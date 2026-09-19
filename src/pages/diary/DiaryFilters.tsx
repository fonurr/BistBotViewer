import { useMemo } from 'react';

import type { Account, Bot } from '../../bistApi/types';
import { DateRangeFilter } from '../../components/DateRangeFilter';
import {
  accountOptions,
  botPicks,
  MultiSelectFilter,
  SymbolFilter,
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
import { DIARY_ORDER_STAGES } from '../../domain/diaryOrders';
import { DiarySortToggle } from './DiarySortToggle';
import { defaultDiaryFilters, type DiaryFilterState } from './types';

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
  const kindCounts = useMemo(() => diaryKindCounts(props.events, filters), [props.events, filters]);
  const symbols = useMemo(
    () =>
      [...new Set(props.events.flatMap((event) => (event.symbol ? [event.symbol] : [])))].sort(),
    [props.events],
  );
  const origins = useMemo(
    () =>
      [...new Set(props.events.flatMap((event) => (event.origin ? [event.origin] : [])))].sort(),
    [props.events],
  );
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
          active={filters.botFilter}
          onActiveChange={(botFilter) =>
            /* Either way the selection goes back to none: switching on starts
               from nothing ticked, and the disabled boxes behind an off switch
               show exactly what it would come back on with. */
            onChange({ ...filters, botFilter, botIds: defaultDiaryFilters.botIds })
          }
          activeLabel="filter"
          inactiveLabel="any bot"
          selected={filters.botIds}
          onChange={(botIds) => onChange({ ...filters, botIds })}
          one="bot"
          many="bots"
          note="On, the Diary keeps an entry only where it names a ticked bot — a bot's own configuration change, budget snapshot or order event. An account snapshot, a cash movement or an error names no bot, so it drops out even with every bot ticked. Off, the bot axis is not asked at all."
        />
        <MultiSelectFilter
          name="diary-accounts"
          open={props.openFilter === 'diary-accounts'}
          setOpen={props.setOpenFilter}
          heading="accounts"
          help="A bot entry answers to this too, through the account the bot was bound to at that instant — not the one it sits on now."
          options={accountOptions(props.accounts)}
          picks={[{ label: 'none', select: new Set<string>() }]}
          active={filters.accountFilter}
          onActiveChange={(accountFilter) =>
            onChange({ ...filters, accountFilter, accountKeys: defaultDiaryFilters.accountKeys })
          }
          activeLabel="filter"
          inactiveLabel="any account"
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
              'On, the Diary keeps an entry only where it names a ticked account. An error the server could not attribute names none, so it drops out even with every account ticked. Off, the account axis is not asked at all.'
            )
          }
        />
        <SymbolFilter
          name="diary-symbols"
          open={props.openFilter === 'diary-symbols'}
          setOpen={props.setOpenFilter}
          heading="symbols in the diary"
          symbols={symbols}
          selected={filters.symbols}
          onChange={(symbols) => onChange({ ...filters, symbols })}
          excluded={filters.symbolsExcluded}
          onExcludedChange={(symbolsExcluded) => onChange({ ...filters, symbolsExcluded })}
          keptNote={(_, list) => `Only entries naming ${list} are kept.`}
          excludedNote={(_, list) => `Entries naming ${list} are excluded.`}
          emptyNote="No loaded order names a matching symbol."
        />
        <MultiSelectFilter
          name="diary-origins"
          open={props.openFilter === 'diary-origins'}
          setOpen={props.setOpenFilter}
          heading="order origins"
          options={origins.map((origin) => ({ key: origin, label: origin }))}
          picks={[{ label: 'none', select: new Set<string>() }]}
          active={filters.originFilter}
          onActiveChange={(originFilter) =>
            onChange({ ...filters, originFilter, origins: defaultDiaryFilters.origins })
          }
          activeLabel="filter"
          inactiveLabel="any origin"
          selected={filters.origins}
          onChange={(origins) => onChange({ ...filters, origins })}
          one="origin"
          many="origins"
          note="On, only entries naming a selected origin are kept. Ordinary bot orders name no origin."
        />
        <MultiSelectFilter
          name="diary-order-stages"
          open={props.openFilter === 'diary-order-stages'}
          setOpen={props.setOpenFilter}
          heading="order stages"
          options={DIARY_ORDER_STAGES.map((stage) => ({ key: stage, label: stage }))}
          picks={[{ label: 'none', select: new Set<string>() }]}
          active={filters.orderStageFilter}
          onActiveChange={(orderStageFilter) =>
            onChange({ ...filters, orderStageFilter, orderStages: defaultDiaryFilters.orderStages })
          }
          activeLabel="filter"
          inactiveLabel="any order stage"
          selected={filters.orderStages}
          onChange={(orderStages) => onChange({ ...filters, orderStages })}
          one="stage"
          many="stages"
          note="Scheduled uses creation time; canceled includes rejected, expired and skipped orders. Filled includes partial fills. Final times are when the server observed the result; fills without a time appear separately, outside the date range."
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
