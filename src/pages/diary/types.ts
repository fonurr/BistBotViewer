import type { FilterSelection } from '../../components/EntityFilters';
import type { DiaryKind } from '../../domain/diary';

/**
 * The toolbar's whole state. A selection of `null` is *every option*, which is
 * not the same set as all of them ticked: a viewer that gains a bot keeps
 * meaning every bot until somebody narrows it.
 */
export interface DiaryFilterState {
  kinds: ReadonlySet<DiaryKind> | null;
  symbols: ReadonlySet<string>;
  symbolsExcluded: boolean;
  originFilter: boolean;
  origins: FilterSelection;
  orderStageFilter: boolean;
  orderStages: FilterSelection;
  /**
   * Whether the bot filter applies at all. It is off by default because
   * switching it on is itself a narrowing: an entry qualifies by naming a
   * ticked bot, so an account snapshot, a cash movement or an error the server
   * could not attribute drops out even with every bot ticked. Off is therefore
   * not "every bot" — it is the filter not being asked. Switching it either way
   * puts `botIds` back to none, the way `none` leaves it, so a reader switching
   * it on ticks the bots they came for rather than unticking the rest first —
   * the Book's rule for every filter behind a switch.
   */
  botFilter: boolean;
  botIds: FilterSelection;
  /**
   * The same switch over the accounts, off by default for the same cause: an
   * error the server could not attribute names no account, so it drops out even
   * with every account ticked.
   */
  accountFilter: boolean;
  accountKeys: FilterSelection;
  /** Event days, inclusive both ends. `null` is the state before the reads are in. */
  from: string | null;
  to: string | null;
  newestFirst: boolean;
}

export const defaultDiaryFilters: DiaryFilterState = {
  kinds: null,
  symbols: new Set<string>(),
  symbolsExcluded: false,
  originFilter: false,
  origins: new Set<string>(),
  orderStageFilter: false,
  orderStages: new Set<string>(),
  /* Both entity filters come on with nothing ticked, the way their `none`
     leaves them — `null` would be every option. */
  botFilter: false,
  botIds: new Set<string>(),
  accountFilter: false,
  accountKeys: new Set<string>(),
  from: null,
  to: null,
  newestFirst: true,
};
