import { useQuery } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { bistApi } from '../bistApi/client';
import { holidayCalendar, isProducerExpectedUp } from '../domain/calendar';
import { MAX_STREAM_SYMBOLS, normalizeSymbols, priceApi, priceStreamUrl } from '../priceApi/client';
import { subscribeToPriceEvents } from '../priceApi/live';
import type { LatestBar, ProducerStatus, Quote, ResolvedPrice } from '../priceApi/types';
import { pricesAreComplete, resolvePrices, type PriceStreamState } from './priceFeed';
import { bistKeys, priceKeys } from './queryKeys';

/**
 * How often streamed quotes are handed to React. Upstream pushes every change, and the Book keeps
 * its price map by identity so a new one redraws every row; two seconds reads as live without
 * turning a busy symbol into a repaint loop.
 */
const QUOTE_FLUSH_MS = 2_000;
/** How often the session window is re-read, so the stream opens and closes on its own. */
const WINDOW_POLL_MS = 30_000;
/** The bridge answers a refused producer with JSON, which closes an EventSource for good. */
const STREAM_RETRY_MS = 15_000;
/** Stored bars are re-read on this cadence while anything on screen is not a live price. */
const BAR_POLL_MS = 60_000;

export interface PriceFeedValue {
  prices: ReadonlyMap<string, ResolvedPrice>;
  pricesComplete: boolean;
  priceStreamState: PriceStreamState;
  priceStatus: { value: ProducerStatus; receivedAt: number } | null;
  priceConnectedSince: number | null;
  requiredSymbols: readonly string[];
  priceError: unknown;
  pricesPending: boolean;
  registerPriceSymbols: (sourceId: string, symbols: readonly string[] | null) => void;
}

export function usePriceFeed(): PriceFeedValue {
  const registrations = useRef(new Map<string, readonly string[]>());
  const [requiredKey, setRequiredKey] = useState('');
  const required = useMemo(() => (requiredKey === '' ? [] : requiredKey.split(',')), [requiredKey]);

  const registerPriceSymbols = useCallback(
    (sourceId: string, symbols: readonly string[] | null) => {
      if (symbols === null) registrations.current.delete(sourceId);
      else registrations.current.set(sourceId, symbols);
      const union = normalizeSymbols([...registrations.current.values()].flat());
      setRequiredKey((current) => {
        const next = union.join(',');
        return current === next ? current : next;
      });
    },
    [],
  );

  const holidays = useQuery({ queryKey: bistKeys.holidays, queryFn: bistApi.getHolidays });
  const calendar = useMemo(() => holidayCalendar(holidays.data ?? []), [holidays.data]);

  // The producer only runs inside the session and refuses everything outside it, so the viewer
  // stops asking rather than failing once a minute all night.
  const [producerUp, setProducerUp] = useState(() => isProducerExpectedUp(Date.now(), calendar));
  useEffect(() => {
    const evaluate = () => setProducerUp(isProducerExpectedUp(Date.now(), calendar));
    evaluate();
    const interval = window.setInterval(evaluate, WINDOW_POLL_MS);
    return () => window.clearInterval(interval);
  }, [calendar]);

  const streamUrl = producerUp ? priceStreamUrl(required) : null;
  const [streamState, setStreamState] = useState<PriceStreamState>('idle');
  const [connectedSince, setConnectedSince] = useState<number | null>(null);
  const [status, setStatus] = useState<{ value: ProducerStatus; receivedAt: number } | null>(null);
  const [quotes, setQuotes] = useState<ReadonlyMap<string, Quote>>(new Map());
  const [retryTick, setRetryTick] = useState(0);

  useEffect(() => {
    if (streamUrl === null) {
      setStreamState('idle');
      setConnectedSince(null);
      setStatus(null);
      setQuotes(new Map());
      return;
    }

    const pending = new Map<string, Quote>();
    let flushTimer: number | null = null;
    let retryTimer: number | null = null;
    let closed = false;

    const flush = () => {
      flushTimer = null;
      if (closed || pending.size === 0) return;
      const batch = [...pending.values()];
      pending.clear();
      setQuotes((current) => {
        const next = new Map(current);
        for (const quote of batch) next.set(quote.symbol.toUpperCase(), quote);
        return next;
      });
    };
    const scheduleFlush = () => {
      if (flushTimer !== null || closed) return;
      flushTimer = window.setTimeout(flush, QUOTE_FLUSH_MS);
    };
    // The bridge answers a refused producer with a JSON body, and an EventSource given anything
    // but an event stream closes for good rather than retrying. So the retry is ours.
    const scheduleRetry = () => {
      if (retryTimer !== null || closed) return;
      retryTimer = window.setTimeout(() => {
        retryTimer = null;
        setRetryTick((tick) => tick + 1);
      }, STREAM_RETRY_MS);
    };

    setStreamState('connecting');
    setConnectedSince(Date.now());
    const unsubscribe = subscribeToPriceEvents(streamUrl, {
      open: () => setStreamState('live'),
      error: () => {
        setStreamState('down');
        scheduleRetry();
      },
      // A malformed event is not a reason to drop the connection: the next one may be fine, and
      // the prices already on screen keep their own age.
      protocolError: () => undefined,
      subscribed: () => undefined,
      quote: (quote) => {
        pending.set(quote.symbol.toUpperCase(), quote);
        scheduleFlush();
      },
      status: (value) => {
        setStatus({ value, receivedAt: Date.now() });
        setStreamState('live');
      },
      stopped: () => {
        setStreamState('idle');
        // The session is over and the producer is leaving. Stored bars answer from here.
        setQuotes(new Map());
      },
    });

    return () => {
      closed = true;
      if (flushTimer !== null) window.clearTimeout(flushTimer);
      if (retryTimer !== null) window.clearTimeout(retryTimer);
      unsubscribe();
    };
  }, [streamUrl, retryTick]);

  // Every symbol the stream did not answer for falls back to its newest stored bar.
  const liveSymbols = useMemo(() => {
    const live = new Set<string>();
    for (const [symbol, quote] of quotes) {
      if (quote.feed === 'live' && quote.son !== null && Number.isFinite(quote.son)) {
        live.add(symbol);
      }
    }
    return live;
  }, [quotes]);
  const everythingLive = required.length > 0 && required.every((symbol) => liveSymbols.has(symbol));

  const bars = useQuery({
    queryKey: priceKeys.latestBars(required),
    queryFn: () => priceApi.getLatestBars(required),
    enabled: required.length > 0 && !everythingLive,
    staleTime: BAR_POLL_MS - 1_000,
    refetchInterval: producerUp ? BAR_POLL_MS : false,
    retry: false,
  });

  const barMap = useMemo(
    () =>
      new Map<string, LatestBar>((bars.data ?? []).map((bar) => [bar.symbol.toUpperCase(), bar])),
    [bars.data],
  );

  const prices = useMemo(
    () => resolvePrices({ required, quotes, bars: barMap }),
    [barMap, quotes, required],
  );

  // A set too large for one stream stays on the pull endpoint, which takes a far longer list.
  const overStreamCap = required.length > MAX_STREAM_SYMBOLS;
  const fallbackQuotes = useQuery({
    queryKey: priceKeys.quotes(required),
    queryFn: () => priceApi.getQuotes(required),
    enabled: producerUp && required.length > 0 && (overStreamCap || streamState === 'down'),
    staleTime: 59_000,
    refetchInterval: 60_000,
    retry: false,
  });
  useEffect(() => {
    if (!fallbackQuotes.data) return;
    setQuotes((current) => {
      const next = new Map(current);
      for (const quote of fallbackQuotes.data) next.set(quote.symbol.toUpperCase(), quote);
      return next;
    });
  }, [fallbackQuotes.data]);

  const barsError = bars.error;
  const fallbackError = fallbackQuotes.error;
  const barsPending = bars.isPending;

  return useMemo(
    () => ({
      prices,
      pricesComplete: pricesAreComplete(required, prices),
      priceStreamState: streamState,
      priceStatus: status,
      priceConnectedSince: connectedSince,
      requiredSymbols: required,
      priceError: prices.size === 0 ? (barsError ?? fallbackError ?? null) : null,
      pricesPending: required.length > 0 && prices.size === 0 && barsPending,
      registerPriceSymbols,
    }),
    [
      barsError,
      barsPending,
      connectedSince,
      fallbackError,
      prices,
      registerPriceSymbols,
      required,
      status,
      streamState,
    ],
  );
}
