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
  batchFrom: string | null;
  batchTo: string | null;
  noClosingOrder: boolean;
}

export const defaultBookFilters: BookFilterState = {
  scopes: new Set<BookScope>(['waiting', 'positions']),
  botIds: null,
  accountIds: null,
  symbols: new Set<string>(),
  canceledStatusFilter: false,
  canceledStatuses: null,
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
