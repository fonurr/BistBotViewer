import type { BatchRangeBasis } from '../../domain/batchRange';
import type { BookScope } from '../../domain/chains';
import {
  BOOK_SLIPPAGE_FIELDS,
  BOOK_SLIPPAGE_SIDES_DEFAULT,
  type BookSlippageField,
} from '../../domain/bookSlippageFilter';
import {
  BOOK_TIME_FIELDS,
  BOOK_TIME_SIDES_DEFAULT,
  type BookTimeField,
} from '../../domain/bookTimeFilter';

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
   * Whether the canceled-status filter applies at all. It is off by default
   * because switching it on is itself a narrowing: a chain qualifies only by
   * owning a canceled order, so every chain that never lost a leg drops out
   * even with all statuses ticked. Off is therefore not "all of them" — it is
   * the filter not being asked, which is why `canceledStatuses` is pinned back
   * to every status whenever it goes off.
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
  /**
   * Which legs the time filter reads. `timeBuys` / `timeSells` are an OR over the
   * chain's legs; `timeIncludeCanceled` is an AND laid over both. They sit beside
   * the clock checkboxes and `all` / `none` never touch them, so switching the
   * filter off is the only thing that restores their defaults (both sides on,
   * canceled legs out).
   */
  timeBuys: boolean;
  timeSells: boolean;
  timeIncludeCanceled: boolean;
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
   * Which legs it reads, an OR over the chain's legs like the time filter's.
   * `all` / `none` never touch them; switching the filter off restores both.
   */
  slippageBuys: boolean;
  slippageSells: boolean;
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
  canceledStatusFilter: false,
  canceledStatuses: null,
  reasonFilter: false,
  reasons: null,
  sourceFilter: false,
  sources: null,
  originFilter: false,
  origins: null,
  timeFilter: false,
  timeFields: new Set(BOOK_TIME_FIELDS.map(({ key }) => key)),
  timeBuys: BOOK_TIME_SIDES_DEFAULT.buys,
  timeSells: BOOK_TIME_SIDES_DEFAULT.sells,
  timeIncludeCanceled: BOOK_TIME_SIDES_DEFAULT.includeCanceled,
  timeFrom: 0,
  timeTo: 1439,
  slippageFilter: false,
  slippageFields: new Set(BOOK_SLIPPAGE_FIELDS.map(({ key }) => key)),
  slippageBuys: BOOK_SLIPPAGE_SIDES_DEFAULT.buys,
  slippageSells: BOOK_SLIPPAGE_SIDES_DEFAULT.sells,
  /* Null is not "every batch" but the moment before one has loaded;
     `DateRangeFilter` resolves it to every loaded batch as soon as one exists. */
  batchFrom: null,
  batchTo: null,
  batchBasis: 'batch',
  noClosingOrder: false,
};

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
