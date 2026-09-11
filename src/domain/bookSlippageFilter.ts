import type { HolidayCalendar } from './calendar';
import type { BookChainRow } from './chains';
import {
  bookRowCreatedSlip,
  bookRowSentSlip,
  finalIsSlow,
  LATE_SENT_MS,
  orderIsSlow,
  sentIsLate,
  SLOW_FINAL_MS,
  SLOW_ORDER_MS,
  SLOW_ORPHAN_FINAL_MS,
} from './bookRowFlags';
import { formatFlagThreshold } from './format';

/**
 * What the slippage filter can select by, in the grid's column order: the three
 * reference prices whose cell draws a slip, then the three clocks the grid
 * colours — a red `sent`, an orange `order`, an orange `final`. Each clock's
 * label names its own threshold, read off `bookRowFlags.ts` so it can never
 * drift from the cells it describes.
 */
export const BOOK_SLIPPAGE_FIELDS = [
  { key: 'createdPrice', label: 'created price' },
  { key: 'intentPrice', label: 'intent price' },
  { key: 'sentPrice', label: 'sent price' },
  { key: 'sentTime', label: `sent time (${formatFlagThreshold(LATE_SENT_MS)})` },
  { key: 'orderTime', label: `order time (${formatFlagThreshold(SLOW_ORDER_MS)})` },
  {
    key: 'finalTime',
    label: `final time (${formatFlagThreshold(SLOW_ORPHAN_FINAL_MS)} or ${formatFlagThreshold(SLOW_FINAL_MS)})`,
  },
] as const;

export type BookSlippageField = (typeof BOOK_SLIPPAGE_FIELDS)[number]['key'];

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
 * Select a whole chain by any ticked flag on any of the rows given — live,
 * scheduled, canceled, or a round trip's leg alike; the page hands over the ones
 * its side toggles read (`bookSides.ts`). A chain none of whose legs the grid
 * would flag cannot match, so the filter narrows the Book even with every field
 * ticked.
 */
export function matchesBookSlippage(
  rows: readonly BookChainRow[],
  fields: ReadonlySet<BookSlippageField>,
  context: BookRowFlagContext,
): boolean {
  return rows.some((row) => rowMatchesBookSlippage(row, fields, context));
}

/**
 * The same test for one leg: a leg the grid flags in a ticked column.
 * `matchesBookSlippage` keeps a chain on any such leg; the Book's `matching
 * orders only` draws just the legs that pass it.
 */
export function rowMatchesBookSlippage(
  row: BookChainRow,
  fields: ReadonlySet<BookSlippageField>,
  context: BookRowFlagContext,
): boolean {
  for (const field of fields) if (FLAGGED[field](row, context)) return true;
  return false;
}
