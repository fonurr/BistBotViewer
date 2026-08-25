import type { BookScope } from '../../domain/chains';

export interface BookFilterState {
  scopes: ReadonlySet<BookScope>;
  botIds: ReadonlySet<string> | null;
  accountIds: ReadonlySet<string> | null;
  symbols: ReadonlySet<string>;
  batchFrom: string | null;
  batchTo: string | null;
  noClosingOrder: boolean;
}

export const defaultBookFilters: BookFilterState = {
  scopes: new Set<BookScope>(['waiting', 'positions']),
  botIds: null,
  accountIds: null,
  symbols: new Set<string>(),
  batchFrom: null,
  batchTo: null,
  noClosingOrder: false,
};
