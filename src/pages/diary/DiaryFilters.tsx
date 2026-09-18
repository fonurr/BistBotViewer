import { useMemo } from 'react';

import type { Account, Bot } from '../../bistApi/types';
import { DateRangeFilter } from '../../components/DateRangeFilter';
import {
  accountOptions,
  botPicks,
  MultiSelectFilter,
  type FilterSelection,
} from '../../components/EntityFilters';
import { PopoverScrim } from '../../components/FilterPopover';
import { accountIdentityKey } from '../../domain/accounts';
import {
  DIARY_KINDS,
  diaryBotCounts,
  diaryKindCounts,
  diaryKindLabels,
  type DiaryEvent,
  type DiaryKind,
} from '../../domain/diary';
import { DiarySortToggle } from './DiarySortToggle';
import type { DiaryFilterState } from './types';

interface DiaryFiltersProps {
  filters: DiaryFilterState;
  onChange: (filters: DiaryFilterState) => void;
  /** The range settling on its default, which is nobody's edit. */
  onSettleDates: (range: { from: string | null; to: string | null }) => void;
  bots: readonly Bot[];
  accounts: readonly Account[];
  /** Every entry the reads produced, before this toolbar narrows them. */
  events: readonly DiaryEvent[];
  /** Every day an entry falls on, ascending — the only days the range can reach. */
  dates: readonly string[];
  /** Whether every diary read is in, so the range can settle on its default. */
  loaded: boolean;
  /** Today in Istanbul: an entry is a thing that happened, so nothing is dated past it. */
  today: string;
  /** Whether the error list ended at the read's own cap rather than at the data. */
  errorsCapped: boolean;
  openFilter: string | null;
  setOpenFilter: (name: string | null) => void;
}

export function DiaryFilters(props: DiaryFiltersProps) {
  const { filters, onChange } = props;
  const scope = useMemo(
    () => ({
      botIds: filters.botIds,
      accountKeys: filters.accountKeys,
      from: filters.from,
      to: filters.to,
    }),
    [filters.accountKeys, filters.botIds, filters.from, filters.to],
  );
  const kindCounts = useMemo(() => diaryKindCounts(props.events, scope), [props.events, scope]);
  const botCounts = useMemo(() => diaryBotCounts(props.events), [props.events]);
  const accountByKey = useMemo(
    () =>
      new Set(
        props.accounts.map((account) => accountIdentityKey(account.accountId, account.brokerageId)),
      ),
    [props.accounts],
  );

  return (
    <>
      <div className="book-toolbar diary-toolbar">
        <DateRangeFilter
          name="diary-dates"
          open={props.openFilter === 'diary-dates'}
          setOpen={props.setOpenFilter}
          defaultRange="all"
          heading="event days"
          dates={props.dates}
          ready={props.loaded}
          currentSession={props.today}
          range={{ from: filters.from, to: filters.to }}
          onChange={(range) => onChange({ ...filters, from: range.from, to: range.to })}
          onSettle={props.onSettleDates}
          note="A day here is the day the entry itself happened, in Istanbul — not the batch a chain was filed under. Only a day the loaded entries fall on can be picked."
        />
        <MultiSelectFilter
          name="diary-kinds"
          open={props.openFilter === 'diary-kinds'}
          setOpen={props.setOpenFilter}
          heading="what the server wrote down"
          options={DIARY_KINDS.map((kind) => ({
            key: kind,
            label: diaryKindLabels[kind],
            count: kindCounts.get(kind) ?? 0,
          }))}
          picks={[{ label: 'none', select: new Set<string>() }]}
          selected={filters.kinds as FilterSelection}
          onChange={(kinds) => onChange({ ...filters, kinds: kinds as ReadonlySet<DiaryKind> })}
          one="type"
          many="types"
          note={
            props.errorsCapped ? (
              <span className="status-warn">
                The errors read stops at its own cap, so the error entries reach only as far back as
                the newest rows it returned — an older day may hold errors this page did not load.
              </span>
            ) : undefined
          }
        />
        <MultiSelectFilter
          name="diary-bots"
          open={props.openFilter === 'diary-bots'}
          setOpen={props.setOpenFilter}
          heading="bots with entries in this window"
          options={props.bots.map((bot) => ({
            key: bot.id,
            label: (
              <>
                {bot.id}
                {bot.accountId && bot.brokerageId ? (
                  <span className="muted">
                    {' '}
                    · {bot.accountId} · {bot.brokerageId}
                  </span>
                ) : null}
              </>
            ),
            count: botCounts.get(bot.id) ?? 0,
          }))}
          picks={botPicks(props.bots)}
          selected={filters.botIds}
          onChange={(botIds) => onChange({ ...filters, botIds })}
          one="bot"
          many="bots"
          note="Only a bot's own entries answer to this — its configuration changes and its budget snapshots. An account snapshot, a cash movement or an error names no bot, so it stays whatever is ticked here."
        />
        <MultiSelectFilter
          name="diary-accounts"
          open={props.openFilter === 'diary-accounts'}
          setOpen={props.setOpenFilter}
          heading="accounts"
          help="A bot entry answers to this too, through the account the bot was bound to at that instant — not the one it sits on now."
          options={accountOptions(props.accounts)}
          picks={[{ label: 'none', select: new Set<string>() }]}
          selected={filters.accountKeys}
          onChange={(accountKeys) => onChange({ ...filters, accountKeys })}
          one="account"
          many="accounts"
          note={
            props.bots.some(
              (bot) =>
                bot.accountId &&
                bot.brokerageId &&
                !accountByKey.has(accountIdentityKey(bot.accountId, bot.brokerageId)),
            ) ? (
              <span className="status-warn">Some bot account labels are not in GetAccounts.</span>
            ) : (
              'An error the server could not attribute names no account, so it stays whatever is ticked here.'
            )
          }
        />
        <DiarySortToggle
          newestFirst={filters.newestFirst}
          onChange={(newestFirst) => onChange({ ...filters, newestFirst })}
        />
      </div>
      {props.openFilter ? <PopoverScrim onClose={() => props.setOpenFilter(null)} /> : null}
    </>
  );
}
