import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';

import { histApi } from '../histApi/client';
import type { HolidayCalendar } from '../domain/calendar';
import {
  intentBarLookup,
  intentPriceFrom,
  intentPriceKey,
  type IntentBarLookup,
} from '../domain/intentPrice';
import { histKeys } from './queryKeys';

/**
 * One row's ask: which instrument, at which instant, and the price the row already
 * carries so the scale guard has something to hold the bar against.
 */
export interface IntentPriceRequest {
  symbol: string;
  intentTime: number | null;
  reference: number | null;
}

export interface ResolvedIntentPrices {
  /** `SYMBOL|ts` (the *bar's* minute, not the instant) → the normalized price. */
  raw: ReadonlyMap<string, number>;
  /** The guarded, per-row answer: null wherever the instant cannot be priced. */
  priceFor: (request: IntentPriceRequest) => number | null;
  /** True once a snapshot exists but is not the current one. */
  stale: boolean;
  available: boolean;
  /** The snapshot day the cache holds, for saying which one a stale figure is from. */
  snapshotFor: string | null;
  /** Whether any drawn row named a minute at all — without one the cache is not why. */
  asked: boolean;
  /**
   * Whether the cache has answered for itself yet. Until it has, nothing is known
   * about it, and a page that said 'unavailable' in the meantime would be
   * asserting a state it cannot confirm.
   */
  statusSettled: boolean;
}

function lookupsFor(
  requests: readonly IntentPriceRequest[],
  holidays: HolidayCalendar,
): Map<string, { symbol: string; ts: number; lookup: IntentBarLookup }> {
  const wanted = new Map<string, { symbol: string; ts: number; lookup: IntentBarLookup }>();
  for (const request of requests) {
    const lookup = intentBarLookup(request.intentTime, holidays);
    if (!lookup) continue;
    const symbol = request.symbol.toUpperCase();
    wanted.set(intentPriceKey(symbol, lookup.ts), { symbol, ts: lookup.ts, lookup });
  }
  return wanted;
}

/**
 * Resolves the minutes a page draws into prices, through the history bridge.
 *
 * The read is bounded by exactly what is on screen and never refetched — a
 * historical minute cannot change, and the cache behind it only moves once a
 * night. A page that resolves nothing asks nothing.
 */
export function useIntentPrices(
  requests: readonly IntentPriceRequest[],
  holidays: HolidayCalendar,
  enabled: boolean,
): ResolvedIntentPrices {
  const wanted = useMemo(() => lookupsFor(requests, holidays), [holidays, requests]);
  const keys = useMemo(() => [...wanted.keys()].sort(), [wanted]);

  const status = useQuery({
    queryKey: histKeys.status,
    queryFn: () => histApi.getSnapshotStatus(),
    enabled,
    staleTime: 5 * 60_000,
    retry: false,
  });

  const bars = useQuery({
    queryKey: histKeys.intentBars(keys.join(',')),
    queryFn: () => histApi.getIntentBars([...wanted.values()]),
    enabled: enabled && keys.length > 0,
    staleTime: Number.POSITIVE_INFINITY,
    retry: false,
  });

  const settled = status.isSuccess || status.isError;

  return useMemo(() => {
    const byKey = new Map(
      (bars.data ?? []).map((bar) => [intentPriceKey(bar.symbol, bar.ts), bar] as const),
    );
    const raw = new Map<string, number>();
    for (const [key, entry] of wanted) {
      const price = intentPriceFrom(byKey.get(key), entry.lookup, null);
      if (price !== null) raw.set(key, price);
    }
    return {
      raw,
      // The guard is applied per row, not per bar: two rows can hold the same
      // minute against different recorded prices.
      priceFor: (request: IntentPriceRequest) => {
        const lookup = intentBarLookup(request.intentTime, holidays);
        if (!lookup) return null;
        const bar = byKey.get(intentPriceKey(request.symbol, lookup.ts));
        return intentPriceFrom(bar, lookup, request.reference);
      },
      stale: status.data ? status.data.stale : false,
      available: status.data ? status.data.available : false,
      snapshotFor: status.data?.snapshotFor ?? null,
      asked: wanted.size > 0,
      statusSettled: !enabled || settled,
    };
  }, [bars.data, enabled, holidays, settled, status.data, wanted]);
}
