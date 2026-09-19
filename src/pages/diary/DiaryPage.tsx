import { useMemo, useState } from 'react';

import { useDiaryData } from '../../app/dataHooks';
import { useViewerRuntime } from '../../app/ViewerRuntime';
import { buildDiary, diaryDates, filterDiary, groupDiaryByDate } from '../../domain/diary';
import { holidayCalendar } from '../../domain/calendar';
import { plural, toIstanbulDateKey } from '../../domain/format';
import { DiaryFilters } from './DiaryFilters';
import { DiaryList } from './DiaryList';
import { defaultDiaryFilters, type DiaryFilterState } from './types';
import './diary.css';

/**
 * Everything the server wrote down, including order lifecycles: the configurations a
 * bot has been through, the budget and account figures behind each of them, the
 * cash that moved, and the errors it recorded — one list, under the day each
 * entry happened on.
 *
 * The page is read-only and holds no write path. It also files by the **event's
 * own Istanbul day**, not by the session a chain belongs to: a configuration
 * change at 19:00 is an entry on that evening, where the Book would already
 * have filed an order under the next session. Nothing here is a chain, so
 * nothing here is owed a batch.
 */
export function DiaryPage() {
  const runtime = useViewerRuntime();
  const data = useDiaryData();
  const [filters, setFilters] = useState<DiaryFilterState>(defaultDiaryFilters);
  const [openFilter, setOpenFilter] = useState<string | null>(null);
  const today = toIstanbulDateKey(Date.now());

  const events = useMemo(
    () =>
      buildDiary({
        orders: {
          activeOrders: data.activeOrders,
          canceledOrders: data.canceledOrders,
          positions: data.positions,
          closedTrades: data.closedTrades,
        },
        bots: data.bots,
        accounts: data.accounts,
        botHistory: data.botHistory,
        botSnapshots: data.botSnapshots,
        accountSnapshots: data.accountSnapshots,
        accountTransactions: data.accountTransactions,
        errors: data.errors,
      }),
    [
      data.activeOrders,
      data.canceledOrders,
      data.positions,
      data.closedTrades,
      data.accountSnapshots,
      data.accountTransactions,
      data.accounts,
      data.botHistory,
      data.botSnapshots,
      data.bots,
      data.errors,
    ],
  );

  const calendar = useMemo(
    () => (data.holidays === null ? null : holidayCalendar(data.holidays)),
    [data.holidays],
  );
  const dates = useMemo(() => diaryDates(events), [events]);
  const visible = useMemo(() => filterDiary(events, filters), [events, filters]);
  const groups = useMemo(
    () => groupDiaryByDate(visible, filters.newestFirst),
    [filters.newestFirst, visible],
  );

  const datedGroupCount = groups.filter((group) => group.date !== null).length;

  return (
    <div className="diary-page page-pad">
      <header className="page-heading">
        <h1>Diary</h1>
      </header>
      {data.error ? (
        <div className="read-error" role="alert">
          <strong>The diary is incomplete.</strong>
          <span>
            {data.error instanceof Error
              ? data.error.message
              : 'A read failed without a usable reply.'}
          </span>
          <button
            type="button"
            className="btn btn-secondary"
            onClick={() => void runtime.requestReconcile()}
          >
            Try the reads again
          </button>
        </div>
      ) : null}
      <DiaryFilters
        filters={filters}
        onChange={setFilters}
        /* Settling on the default is the control resolving itself, not an edit. */
        onSettleDates={(range) =>
          setFilters((current) => ({ ...current, from: range.from, to: range.to }))
        }
        bots={data.bots}
        accounts={data.accounts}
        events={events}
        dates={dates}
        loaded={!data.isPending}
        today={today}
        errorsCapped={data.errorsCapped}
        openFilter={openFilter}
        setOpenFilter={setOpenFilter}
      />
      {data.isPending ? (
        <p className="diary-status" role="status">
          <span className="spinner" aria-hidden="true" />
          Reading the diary…
        </p>
      ) : (
        <p className="diary-status muted" role="status">
          {visible.length === events.length
            ? plural(visible.length, 'entry', 'entries')
            : `${plural(visible.length, 'entry', 'entries')} of ${events.length}`}
          {datedGroupCount > 0 ? ` · ${plural(datedGroupCount, 'day')}` : ''}
        </p>
      )}
      {!data.isPending && data.error === null && groups.length === 0 ? (
        <p className="diary-empty">
          {events.length === 0
            ? 'The server has written no diary entries.'
            : 'No entry falls inside this window.'}
        </p>
      ) : null}
      <DiaryList groups={groups} calendar={calendar} newestFirst={filters.newestFirst} />
    </div>
  );
}
