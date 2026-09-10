import type { HolidayCalendar } from './calendar';
import type { BookChainRow } from './chains';
import { marketSlippagePercentage, sentSlipAllowed, slippagePercentage } from './orders';

/*
 * What the Book flags on one row — the slip each reference-price cell draws and
 * the clocks it colours — written once, so the cells that draw a flag, the strip
 * that averages the slips and the slippage filter that selects by them can never
 * disagree. The `@intent` slip is not here: its price comes from the minute
 * history, so the page resolves it per row and hands it on.
 */

/** A send more than this later than its plan is drawn late. */
export const LATE_SENT_MS = 10_000;
/** An exchange registration more than this later than the send is drawn slow. */
export const SLOW_ORDER_MS = 10_000;
/** A fill seen this long past both the order's intent and its send, once registered, is slow. */
export const SLOW_FINAL_MS = 120_000;
/** With no registration to lean on, a fill this long past the order's intent is slow. */
export const SLOW_ORPHAN_FINAL_MS = 10_000;

/**
 * The `@created/slip` cell's slip: the fill against the price the order was
 * created with. Null until something filled, and for a market order, whose
 * captured price was never sent — see `slippagePercentage`.
 */
export function bookRowCreatedSlip(
  row: Pick<BookChainRow, 'orderPrice' | 'averagePrice' | 'orderType'>,
): number | null {
  if (row.averagePrice === null) return null;
  return slippagePercentage({
    orderPrice: row.orderPrice,
    averagePrice: row.averagePrice,
    type: row.orderType,
  });
}

/**
 * The `@sent/slip` cell's slip: the fill against the tape the order was decided
 * against, drawn only for an order sent inside continuous trading — see
 * `sentSlipAllowed`. Null until something filled or where no tape was stored.
 */
export function bookRowSentSlip(
  row: Pick<BookChainRow, 'marketPrice' | 'averagePrice' | 'sentTime'>,
  calendar: HolidayCalendar,
): number | null {
  if (row.averagePrice === null || !sentSlipAllowed(row.sentTime, calendar)) return null;
  return marketSlippagePercentage({ marketPrice: row.marketPrice, averagePrice: row.averagePrice });
}

/**
 * `sent` is late (red) when the send trailed every stamp it can be measured
 * against — `scheduledTime` and `createdTime` — by more than ten seconds.
 */
export function sentIsLate(
  row: Pick<BookChainRow, 'sentTime' | 'scheduledTime' | 'createdTime'>,
): boolean {
  return lateAgainst(row.sentTime, [row.scheduledTime, row.createdTime], LATE_SENT_MS);
}

/**
 * `order` is slow (orange) when the exchange registered the order more than ten
 * seconds after this server sent it.
 */
export function orderIsSlow(row: Pick<BookChainRow, 'orderTime' | 'sentTime'>): boolean {
  return lateAgainst(row.orderTime, [row.sentTime], SLOW_ORDER_MS);
}

/**
 * `final` is slow (orange) when it landed well past the order. Once the order
 * had registered (`orderTime` present) the fill notice has some lag, so it is
 * slow only when it trailed **both** the order's intent and its own send by more
 * than two minutes. On a row that never registered — a scheduled order skipped
 * before it fired — the intent is all there is, and ten seconds past it is slow.
 * A `null` final, or a stamp missing or sitting after it, is never slow.
 */
export function finalIsSlow(
  row: Pick<BookChainRow, 'finalSeenTime' | 'orderTime' | 'intentTime' | 'sentTime'>,
): boolean {
  const { finalSeenTime, intentTime, sentTime } = row;
  if (finalSeenTime === null || intentTime === null) return false;
  if (row.orderTime === null) return finalSeenTime - intentTime > SLOW_ORPHAN_FINAL_MS;
  return (
    sentTime !== null &&
    finalSeenTime - intentTime > SLOW_FINAL_MS &&
    finalSeenTime - sentTime > SLOW_FINAL_MS
  );
}

/**
 * Whether `stamp` trails every anchor it can be measured against by more than
 * `toleranceMs`. A `null` stamp or no usable anchor is never late; an anchor
 * that sits after the stamp (clock skew, a plan revised past the send) is not
 * counted against it.
 */
function lateAgainst(
  stamp: number | null,
  anchors: readonly (number | null)[],
  toleranceMs: number,
): boolean {
  if (stamp === null) return false;
  const present = anchors.filter((anchor): anchor is number => anchor !== null);
  return present.length > 0 && present.every((anchor) => stamp - anchor > toleranceMs);
}
