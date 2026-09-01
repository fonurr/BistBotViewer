import type { HolidayCalendar } from '../domain/calendar';
import { areLivePricesExpected, lastCompletedSessionDate } from '../domain/calendar';
import { formatDate, formatShortAge } from '../domain/format';
import type { LatestBar, ProducerStatus, Quote, ResolvedPrice } from '../priceApi/types';

/** The stream's own condition, which is not the same thing as the producer's `feed`. */
export type PriceStreamState = 'idle' | 'connecting' | 'live' | 'down';

export interface PriceInputs {
  /** Every symbol a drawn row needs a price for, in any case. */
  required: readonly string[];
  quotes: ReadonlyMap<string, Quote>;
  bars: ReadonlyMap<string, LatestBar>;
}

export interface PriceFreshness {
  /** The copy, or null when the prices on screen need no qualification. */
  copy: string | null;
  className: 'status-warn' | 'status-dead' | null;
}

/**
 * A live quote is preferred; the newest stored bar stands in when the feed cannot answer. A symbol
 * that resolves to neither is simply absent, which is what keeps unrealized P&L all-or-nothing.
 *
 * Keys are upper-cased here so every caller can look up by either case.
 */
export function resolvePrices(inputs: PriceInputs): Map<string, ResolvedPrice> {
  const resolved = new Map<string, ResolvedPrice>();
  for (const raw of inputs.required) {
    const symbol = raw.toUpperCase();
    const quote = inputs.quotes.get(symbol);
    if (quote && quote.feed === 'live' && quote.son !== null && Number.isFinite(quote.son)) {
      resolved.set(symbol, {
        symbol,
        price: quote.son,
        source: 'live',
        // `server_ts` is Unix seconds upstream; every timestamp inside the viewer is milliseconds.
        asOf: Math.round(quote.server_ts * 1_000),
      });
      continue;
    }
    const bar = inputs.bars.get(symbol);
    if (bar && Number.isFinite(bar.close)) {
      resolved.set(symbol, {
        symbol,
        price: bar.close,
        source: 'bar',
        asOf: bar.barTs * 1_000,
        barType: bar.barType,
        sessionDate: bar.sessionDate,
      });
    }
  }
  return resolved;
}

/** Whether every drawn row can be priced. One symbol short blanks the fleet figure, as it always has. */
export function pricesAreComplete(
  required: readonly string[],
  prices: ReadonlyMap<string, ResolvedPrice>,
): boolean {
  const unique = new Set(required.map((symbol) => symbol.toUpperCase()));
  if (unique.size === 0) return false;
  for (const symbol of unique) if (!prices.has(symbol)) return false;
  return true;
}

export interface FreshnessInputs {
  now: number;
  holidays: HolidayCalendar;
  required: readonly string[];
  prices: ReadonlyMap<string, ResolvedPrice>;
  streamState: PriceStreamState;
  /** The newest `status` the producer sent, and when the viewer received it. */
  status: { value: ProducerStatus; receivedAt: number } | null;
  /** When the viewer first tried to reach the producer this session; the floor for an age. */
  connectedSince: number | null;
}

/**
 * One line, drawn only when the prices on screen are not live.
 *
 * Inside the session a stale price is a fault and is given its age, coloured by whose fault it is:
 * amber while the producer still answers and says its feed is not live, red when the stream itself
 * is gone. Outside the session the last close is simply the right price, so nothing is said —
 * unless the stored bars do not reach that close, and then the line gives the date they do reach.
 */
export function pricesFreshness(inputs: FreshnessInputs): PriceFreshness {
  const required = [...new Set(inputs.required.map((symbol) => symbol.toUpperCase()))];
  if (required.length === 0) return { copy: null, className: null };

  const resolved = required.flatMap((symbol) => {
    const price = inputs.prices.get(symbol);
    return price ? [price] : [];
  });
  if (resolved.length < required.length) {
    return { copy: 'prices unavailable', className: 'status-dead' };
  }
  if (resolved.every((price) => price.source === 'live')) return { copy: null, className: null };

  if (areLivePricesExpected(inputs.now, inputs.holidays)) {
    return {
      copy: `prices ${formatShortAge(globalFeedAge(inputs))} old`,
      className: inputs.streamState === 'down' ? 'status-dead' : 'status-warn',
    };
  }

  // The session is over. The closing auction of the last completed session is the correct price,
  // and a viewer looking at it needs no warning; anything older than that is a gap worth naming.
  const lastSession = lastCompletedSessionDate(inputs.now, inputs.holidays);
  const complete =
    lastSession !== null &&
    resolved.every(
      (price) => price.barType === 'CLOSING_AUCTION' && price.sessionDate === lastSession,
    );
  if (complete) return { copy: null, className: null };

  const oldest = Math.min(...resolved.map((price) => price.asOf));
  return { copy: `prices ${formatDate(oldest)}`, className: 'status-warn' };
}

/**
 * How old the feed is as a whole, not one symbol's. The producer's `feed_age_ms` answers "when did
 * anything last tick", which is the question, and the wall clock carries it forward between the
 * five-second status events. With no status at all, the age is however long the viewer has been
 * trying.
 */
function globalFeedAge(inputs: FreshnessInputs): number {
  if (inputs.status !== null) {
    const reported = inputs.status.value.feed_age_ms;
    const sinceReceived = Math.max(0, inputs.now - inputs.status.receivedAt);
    return (reported ?? 0) + sinceReceived;
  }
  if (inputs.connectedSince !== null) return Math.max(0, inputs.now - inputs.connectedSince);
  return 0;
}
