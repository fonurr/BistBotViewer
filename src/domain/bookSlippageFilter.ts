import type { HolidayCalendar } from './calendar';
import type { BookChain, BookChainRow } from './chains';
import {
  bookRowCreatedSlip,
  bookRowSentSlip,
  finalIsSlow,
  orderIsSlow,
  sentIsLate,
} from './bookRowFlags';

/**
 * What the slippage filter can select by, in the grid's column order: the three
 * reference prices whose cell draws a slip, then the three clocks the grid
 * colours — a red `sent`, an orange `order`, an orange `final`.
 */
export const BOOK_SLIPPAGE_FIELDS = [
  { key: 'createdPrice', label: 'created price' },
  { key: 'intentPrice', label: 'intent price' },
  { key: 'sentPrice', label: 'sent price' },
  { key: 'sentTime', label: 'sent time' },
  { key: 'orderTime', label: 'order time' },
  { key: 'finalTime', label: 'final time' },
] as const;

export type BookSlippageField = (typeof BOOK_SLIPPAGE_FIELDS)[number]['key'];

/**
 * Which of a chain's legs the slippage filter reads — an OR, like the time
 * filter's: a chain matches on any leg whose side is still ticked. `all` /
 * `none` never touch these; only switching the filter off restores them.
 */
export interface BookSlippageSides {
  buys: boolean;
  sells: boolean;
}

export const BOOK_SLIPPAGE_SIDES_DEFAULT: BookSlippageSides = { buys: true, sells: true };

/**
 * What a row's flags are read against: the trading calendar the `@sent` slip's
 * session rule needs, and the `@intent` slip the page already resolved for the
 * row, since that price comes from the minute history rather than the row.
 */
export interface BookRowFlagContext {
  calendar: HolidayCalendar;
  intentSlip: (row: BookChainRow) => number | null;
}

/** Each field asks exactly the question its cell asks before it draws its flag. */
const FLAGGED: Record<
  BookSlippageField,
  (row: BookChainRow, context: BookRowFlagContext) => boolean
> = {
  createdPrice: (row) => bookRowCreatedSlip(row) !== null,
  intentPrice: (row, context) => context.intentSlip(row) !== null,
  sentPrice: (row, context) => bookRowSentSlip(row, context.calendar) !== null,
  sentTime: (row) => sentIsLate(row),
  orderTime: (row) => orderIsSlow(row),
  finalTime: (row) => finalIsSlow(row),
};

/**
 * Select whole chains by any ticked flag on any leg of a ticked side — live,
 * scheduled, canceled, or a round trip's leg alike. A chain none of whose legs
 * the grid would flag cannot match, so switching the filter on narrows the Book
 * even with every field ticked.
 */
export function matchesBookSlippage(
  chain: BookChain,
  fields: ReadonlySet<BookSlippageField>,
  sides: BookSlippageSides,
  context: BookRowFlagContext,
): boolean {
  return chain.rows.some((row) => rowMatchesBookSlippage(row, fields, sides, context));
}

/**
 * The same test for one leg: a leg on a ticked side that the grid flags in a
 * ticked column. `matchesBookSlippage` keeps a chain on any such leg; the Book's
 * `matching orders only` draws just the legs that pass it.
 */
export function rowMatchesBookSlippage(
  row: BookChainRow,
  fields: ReadonlySet<BookSlippageField>,
  sides: BookSlippageSides,
  context: BookRowFlagContext,
): boolean {
  if (row.direction === 'buy' ? !sides.buys : !sides.sells) return false;
  for (const field of fields) if (FLAGGED[field](row, context)) return true;
  return false;
}
