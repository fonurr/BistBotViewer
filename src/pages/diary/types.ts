import type { FilterSelection } from '../../components/EntityFilters';
import type { DiaryKind } from '../../domain/diary';

/**
 * The toolbar's whole state. Every selection is `null` for *every option*,
 * which is not the same set as all of them ticked: a viewer that gains a bot
 * keeps meaning every bot until somebody narrows it.
 */
export interface DiaryFilterState {
  kinds: ReadonlySet<DiaryKind> | null;
  botIds: FilterSelection;
  accountKeys: FilterSelection;
  /** Event days, inclusive both ends. `null` is the state before the reads are in. */
  from: string | null;
  to: string | null;
  newestFirst: boolean;
}

export const defaultDiaryFilters: DiaryFilterState = {
  kinds: null,
  botIds: null,
  accountKeys: null,
  from: null,
  to: null,
  newestFirst: true,
};
