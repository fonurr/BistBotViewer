import type { BookScope } from '../../domain/chains';

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
  batchFrom: string | null;
  batchTo: string | null;
  noClosingOrder: boolean;
}

export const defaultBookFilters: BookFilterState = {
  /* Every scope, because the default batch range is one session: the whole of
     one day's work is what a reader opens the Book for, and a day is small
     enough to draw whole. */
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
  /* Null is not "every batch" but the moment before one has loaded;
     `DateRangeFilter` resolves it to the newest batch as soon as one exists. */
  batchFrom: null,
  batchTo: null,
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
