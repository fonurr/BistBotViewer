import { closeMinuteOn, istanbulDay, istanbulMinuteAt, type HolidayCalendar } from './calendar';

/**
 * The exchange's own auction and continuous-open minutes, matching the ones
 * `firstTradeInstant` folds an off-hours stamp forward onto. A half day only
 * moves the close, so it opens like any other trading day.
 */
const OPENING_MATCH_MINUTE = 9 * 60 + 55;
const CONTINUOUS_OPEN_MINUTE = 10 * 60;
/** `firstTradeInstant` puts a stamp just past the close on close + 5. */
const CLOSING_AUCTION_OFFSET = 5;

/**
 * A stored bar is only as good as the scale it was put on. Where the bulletin
 * never covered a symbol its factor is assumed rather than measured, so the last
 * check is against the row's own recorded price: same instrument, same session, so
 * a gap this wide is a mis-scaled bar, not a market that moved. It clears BIST's
 * own daily limits (±10%, ±20% on some boards) with room to spare.
 */
export const INTENT_PRICE_TOLERANCE = 0.23;

/**
 * How a priced instant is addressed, everywhere: in the request, in the resolved
 * map, and in the report that reads it back. One shape, so a symbol's casing can
 * never split a lookup.
 */
export function intentPriceKey(symbol: string, ts: number): string {
  return `${symbol.toUpperCase()}|${ts}`;
}

/**
 * Which bar answers an intent instant, and which of its prices. The rule lives
 * here rather than in the cache because it is a reading of the session, not a
 * property of a database:
 *
 * - the opening match and the closing auction are single matched prints whose
 *   OHLC are all equal, so either field is the price;
 * - the continuous open is the 10:00 minute's **open** — the first traded price;
 * - any other exact minute is the **previous** minute's close, because the minute
 *   the instant opens has not traded yet at its first tick;
 * - anything carrying seconds is not a minute the tape can be read at, so it
 *   yields nothing rather than a neighbouring approximation.
 */
export interface IntentBarLookup {
  ts: number;
  field: 'open' | 'close';
  /** Auction prints get a price but never a slip — see `intentSlipAllowed`. */
  isAuction: boolean;
}

export function intentBarLookup(
  intentTime: number | null,
  holidays: HolidayCalendar,
): IntentBarLookup | null {
  if (intentTime === null || !Number.isFinite(intentTime)) return null;
  const day = istanbulDay(intentTime);
  if (day === null) return null;

  const midnight = istanbulMinuteAt(day, 0);
  const offset = intentTime - midnight;
  // A minute the tape can be read at is a whole minute. `firstTradeInstant`
  // returns the raw stamp during trading hours, so most of them are not.
  if (offset % 60_000 !== 0) return null;
  const minute = offset / 60_000;

  const closeMinute = closeMinuteOn(day, holidays);
  if (minute === OPENING_MATCH_MINUTE || minute === closeMinute + CLOSING_AUCTION_OFFSET) {
    return { ts: intentTime, field: 'close', isAuction: true };
  }
  if (minute === CONTINUOUS_OPEN_MINUTE) {
    return { ts: intentTime, field: 'open', isAuction: false };
  }
  if (minute > CONTINUOUS_OPEN_MINUTE && minute < closeMinute) {
    return { ts: intentTime - 60_000, field: 'close', isAuction: false };
  }
  // close + 8, or anything else the calendar can name, has no bar behind it.
  return null;
}

/** A bar as the intent cache returns it, narrowed to what pricing needs. */
export interface IntentBarPrices {
  open: number;
  close: number;
}

/**
 * The intent price, or null. `reference` is whatever price the row already
 * carries — `marketPrice`, else `averagePrice`, else `orderPrice` — and a bar more
 * than `INTENT_PRICE_TOLERANCE` away from it is withheld rather than drawn: a
 * state that cannot be confirmed is never shown. With no reference at all the
 * guard simply cannot run, and the bar stands on its own.
 */
export function intentPriceFrom(
  bar: IntentBarPrices | undefined,
  lookup: IntentBarLookup,
  reference: number | null,
): number | null {
  if (!bar) return null;
  const price = lookup.field === 'open' ? bar.open : bar.close;
  if (!Number.isFinite(price) || price <= 0) return null;
  if (reference !== null && Number.isFinite(reference) && reference > 0) {
    if (Math.abs(price / reference - 1) > INTENT_PRICE_TOLERANCE) return null;
  }
  return price;
}

/**
 * The price a row is measured against when checking the bar above. Read in the
 * order of how close each is to the tape: the market the order was decided
 * against first, then what it actually filled at, then what it asked for.
 */
export function intentPriceReference(row: {
  marketPrice: number | null;
  averagePrice: number | null;
  orderPrice: number | null;
}): number | null {
  return row.marketPrice ?? row.averagePrice ?? row.orderPrice;
}

/**
 * Whether an intent price may also carry a slip.
 *
 * An auction is a single matched print, not a price the order could have been
 * worked against, so a slip off it would measure the auction rather than the
 * execution. And an order that registered more than ten seconds **after** it could
 * first have traded was not competing for that price at all — the tape had moved
 * on. Registering *earlier* than the intent instant is ordinary (a plan filed
 * ahead of its own fire time) and is not a reason to withhold anything.
 *
 * Both cases leave the price on screen and drop only the slip, and both are
 * excluded from every average and Performance figure for the same reason.
 */
export const INTENT_SLIP_LATE_MS = 10_000;

export function intentSlipAllowed(
  lookup: IntentBarLookup,
  intentTime: number,
  orderTime: number | null,
): boolean {
  if (lookup.isAuction) return false;
  if (orderTime === null || !Number.isFinite(orderTime)) return true;
  return orderTime - intentTime <= INTENT_SLIP_LATE_MS;
}
