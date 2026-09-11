import type { BatchRangeBasis } from '../../domain/batchRange';
import type { BookScope } from '../../domain/chains';
import { BOOK_SIDES_DEFAULT, type BookSides } from '../../domain/bookSides';
import type { BookSlippageField } from '../../domain/bookSlippageFilter';
import type { BookTimeField } from '../../domain/bookTimeFilter';

/**
 * One row's `@intent/slip` cell, resolved on the page so the grid stays a
 * renderer. `slip` is null on its own where the price stands but the slip is
 * withheld — an auction print, or an order that registered more than ten
 * seconds after the instant it could first have traded.
 */
export interface BookIntentCell {
  price: number;
  slip: number | null;
}

export interface BookFilterState {
  scopes: ReadonlySet<BookScope>;
  botIds: ReadonlySet<string> | null;
  accountIds: ReadonlySet<string> | null;
  symbols: ReadonlySet<string>;
  /**
   * Whether `symbols` names the chains left out rather than the ones kept. It
   * only reads while a symbol is picked: an empty pick is every symbol either way.
   */
  symbolsExcluded: boolean;
  /**
   * Whether the canceled-status filter applies at all. It is off by default
   * because switching it on is itself a narrowing: a chain qualifies only by
   * owning a canceled order, so every chain that never lost a leg drops out
   * even with all statuses ticked. Off is therefore not "all of them" — it is
   * the filter not being asked. Switching it either way puts `canceledStatuses`
   * back to none, the way `none` leaves it, so a reader switching it on ticks
   * the statuses they came for rather than unticking the rest first. The same
   * holds for every filter below that carries a switch.
   */
  canceledStatusFilter: boolean;
  /** `null` is every status, in the display form the status cells carry. */
  canceledStatuses: ReadonlySet<string> | null;
  /**
   * Whether the reason filter applies at all — off by default for the same
   * cause as the status one above, and only that cause: a row matches by
   * carrying a reason key, so a chain the server said nothing about drops out
   * even with every reason ticked. Unlike the status filter it reads every
   * row, not only the canceled ones.
   */
  reasonFilter: boolean;
  /** `null` is every reason, in the server's own key form. */
  reasons: ReadonlySet<string> | null;
  /**
   * Whether the source filter applies at all. Off by default for the same cause
   * as the two above: only a stored death names who ended it, so a chain whose
   * legs all still live drops out even with every source ticked.
   */
  sourceFilter: boolean;
  /** `null` is every source, in the server's own key form. */
  sources: ReadonlySet<string> | null;
  /**
   * Whether the origin filter applies at all. Off by default for the same cause
   * as the three above: the ordinary bot order names no origin, so a chain built
   * only of those drops out even with every origin ticked.
   */
  originFilter: boolean;
  /** `null` is every origin, in the server's own key form. */
  origins: ReadonlySet<string> | null;
  /** Any chosen clock on any chain leg can satisfy this daily Istanbul range. */
  timeFilter: boolean;
  timeFields: ReadonlySet<BookTimeField>;
  /** Inclusive whole-minute bounds, from 00:00 (0) through 23:59 (1439). */
  timeFrom: number;
  timeTo: number;
  /**
   * Whether the slippage filter applies at all. Off by default for the same
   * cause as the status filters above: a chain qualifies only by owning a leg
   * the grid flags — a slip drawn in `@created`, `@intent` or `@sent`, a red
   * `sent`, an orange `order` or `final` — so switching it on narrows the Book
   * even with every field ticked.
   */
  slippageFilter: boolean;
  slippageFields: ReadonlySet<BookSlippageField>;
  /**
   * Which orders every row filter reads (`rowFiltersActive`): `buys` / `sells`
   * are an OR, `includeCanceled` an AND laid over both. They sit beside
   * `matching orders only` and, like it, answer for all of those filters at
   * once. The default reads every order.
   */
  sides: BookSides;
  batchFrom: string | null;
  batchTo: string | null;
  /**
   * How the batch range is read: `batch` keeps the chains filed under one of its
   * sessions, `active` every chain alive on one of them (`BookChain.activeSpan`).
   * Over the widest range the two keep the same chains, so the difference only
   * shows once the range is narrowed.
   */
  batchBasis: BatchRangeBasis;
  noClosingOrder: boolean;
  /**
   * How a kept chain is drawn. Off, it is drawn whole: every filter selects
   * chains, never rows. On, a chain draws only the rows that pass every filter
   * at once — still as a chain, however few — and drops out where none does.
   * Only the row filters (`rowFiltersActive`) can tell one row of a chain from
   * another, so with none of them on this changes nothing.
   */
  ordersOnly: boolean;
}

export const defaultBookFilters: BookFilterState = {
  /* Every scope: the whole of the desk's work is what a reader opens the Book
     for. The range spans every loaded batch, and only the newest one is drawn
     expanded — the rest wait behind their chevron — so this stays quick across
     a year of them. */
  scopes: new Set<BookScope>(['waiting', 'positions', 'trades', 'canceled']),
  botIds: null,
  accountIds: null,
  symbols: new Set<string>(),
  symbolsExcluded: false,
  /* Every filter behind a switch comes on with nothing ticked, the way its
     `none` leaves it — `null` would be every option. */
  canceledStatusFilter: false,
  canceledStatuses: new Set<string>(),
  reasonFilter: false,
  reasons: new Set<string>(),
  sourceFilter: false,
  sources: new Set<string>(),
  originFilter: false,
  origins: new Set<string>(),
  timeFilter: false,
  timeFields: new Set<BookTimeField>(),
  timeFrom: 0,
  timeTo: 1439,
  slippageFilter: false,
  slippageFields: new Set<BookSlippageField>(),
  sides: BOOK_SIDES_DEFAULT,
  /* Null is not "every batch" but the moment before one has loaded;
     `DateRangeFilter` resolves it to every loaded batch as soon as one exists. */
  batchFrom: null,
  batchTo: null,
  batchBasis: 'batch',
  noClosingOrder: false,
  ordersOnly: false,
};

/**
 * What becomes of a chain a row filter kept, in the words each filter's note
 * uses: drawn whole, or only as far as its rows pass every filter at once.
 */
export function keptChainDrawing(filters: Pick<BookFilterState, 'ordersOnly'>): string {
  return filters.ordersOnly
    ? 'draws only its orders that pass every filter, since matching orders only is on'
    : 'draws the whole chain';
}

/**
 * Whether a filter that reads rows one at a time is on — the ones that can keep
 * a chain by one of its rows and not another. Scope, bot, account, symbol and
 * the batch range answer for the whole chain at once.
 */
export function rowFiltersActive(filters: BookFilterState): boolean {
  return (
    !filters.noClosingOrder &&
    (filters.canceledStatusFilter ||
      filters.reasonFilter ||
      filters.sourceFilter ||
      filters.originFilter ||
      filters.timeFilter ||
      filters.slippageFilter)
  );
}

/**
 * `canceled` is the scope's key, not its word. A chain only lands there when
 * every leg it ever had died, so what the toggle and the group heading are
 * naming is the chains that never opened a position — which is what a reader
 * picking that scope is after, and what "canceled" on its own fails to say
 * beside a canceled *leg* on a chain that traded perfectly well.
 */
export const scopeLabels: Record<BookScope, string> = {
  waiting: 'Waiting',
  positions: 'Positions',
  trades: 'Trades',
  canceled: 'Never Opened',
};
