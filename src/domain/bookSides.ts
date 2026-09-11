import type { BookChainRow } from './chains';

/**
 * Which orders the Book's order filters read — canceled status, reason, source,
 * origin, time and slippage alike. `buys` and `sells` are an OR: an order on a
 * side still ticked is read, and with neither ticked none is. `includeCanceled`
 * is an AND laid over both: a canceled order is read only while it is on and its
 * own side is ticked too. The default reads every order, so the toggles only
 * ever narrow what those filters can match.
 */
export interface BookSides {
  buys: boolean;
  sells: boolean;
  includeCanceled: boolean;
}

export const BOOK_SIDES_DEFAULT: BookSides = { buys: true, sells: true, includeCanceled: true };

export function bookSidesNarrowed(sides: BookSides): boolean {
  return !sides.buys || !sides.sells || !sides.includeCanceled;
}

/** Whether the order filters read this row at all. */
export function rowOnBookSides(row: BookChainRow, sides: BookSides): boolean {
  if (row.source === 'canceled' && !sides.includeCanceled) return false;
  return row.direction === 'buy' ? sides.buys : sides.sells;
}

/**
 * The rows the order filters read. Asked before any of them: it is the cheapest
 * question, so every costlier test — a clock read in Istanbul time, a slip — runs
 * only on what it leaves. At the default every row is read and the same array
 * comes back.
 */
export function rowsOnBookSides(
  rows: readonly BookChainRow[],
  sides: BookSides,
): readonly BookChainRow[] {
  return bookSidesNarrowed(sides) ? rows.filter((row) => rowOnBookSides(row, sides)) : rows;
}
