import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';

import { useBookData, useBotBudgets, useFleetPrices } from '../../app/dataHooks';
import { bistKeys, priceKeys } from '../../app/queryKeys';
import { useViewerRuntime } from '../../app/ViewerRuntime';
import { bistApi } from '../../bistApi/client';
import { asBistApiError } from '../../bistApi/errors';
import type { Bot, ErrorRow, PendingOrderRequest, ScheduleSpec } from '../../bistApi/types';
import { priceApi } from '../../priceApi/client';
import { Modal } from '../../components/Modal';
import { ResultList, type ActionResult } from '../../components/ResultList';
import { accountIdentityKey } from '../../domain/accounts';
import { bookRowCreatedSlip, bookRowSentSlip } from '../../domain/bookRowFlags';
import {
  BOOK_SLIPPAGE_FIELDS,
  matchesBookSlippage,
  rowMatchesBookSlippage,
  type BookRowFlagContext,
} from '../../domain/bookSlippageFilter';
import { formatBookTime, matchesBookTime, rowMatchesBookTime } from '../../domain/bookTimeFilter';
import { activeSessionDates, withinBatchRange } from '../../domain/batchRange';
import { bookAllocation } from '../../domain/budget';
import {
  holidayCalendar,
  previousTradingDate,
  sessionBatchDate,
  type HolidayCalendar,
} from '../../domain/calendar';
import { intentBarLookup, intentPriceReference, intentSlipAllowed } from '../../domain/intentPrice';
import { useIntentPrices } from '../../app/useIntentPrices';
import {
  buildBookChains,
  rowReasons,
  type BookChain,
  type BookChainRow,
  type BookScope,
} from '../../domain/chains';
import {
  formatDate,
  formatNumber,
  formatPercentage,
  formatRowTime,
  formatSignedNumber,
  formatSlip,
  plural,
  toIstanbulDateKey,
} from '../../domain/format';
import {
  deriveFilledPnlState,
  intentSlippagePercentage,
  pnlPercentage,
  realizedPnl,
  unrealizedPnl,
} from '../../domain/orders';
import { displayStatus } from '../../domain/status';
import { BookFilters } from './BookFilters';
import { BookGrid, ColumnDivider, summarizeBookToday } from './BookGrid';
import { OrderDialog, type OrderDialogAction } from './OrderDialog';
import { rangeLabel } from '../../components/DateRangeFilter';
import {
  defaultBookFilters,
  rowFiltersActive,
  type BookFilterState,
  type BookIntentCell,
} from './types';
import './book.css';

interface OpenChainState {
  chainKey: string;
  chainSnapshot: BookChain;
  action?: {
    kind: OrderDialogAction['kind'];
    rowKey: string;
    clientOrderId: string | null;
    disabled?: boolean;
    disabledReason?: string;
  };
}

export function BookPage() {
  const data = useBookData();
  const runtime = useViewerRuntime();
  const [searchParams, setSearchParams] = useSearchParams();
  const [filters, setFilters] = useState<BookFilterState>(defaultBookFilters);
  // The never-opened scope is on by default, and it draws nothing but canceled
  // legs — so the toggle starts where switching that scope on would put it,
  // rather than opening the Book on a row of collapsed stubs.
  const [showCanceled, setShowCanceled] = useState(defaultBookFilters.scopes.has('canceled'));
  const [canceledOverrides, setCanceledOverrides] = useState<ReadonlySet<string>>(new Set());
  const [openChain, setOpenChain] = useState<OpenChainState | null>(null);
  const [mismatchOpen, setMismatchOpen] = useState(false);
  const [pendingSelection, setPendingSelection] = useState<ReadonlySet<number>>(new Set());
  const [pendingTargets, setPendingTargets] = useState<readonly PendingOrderRequest[] | null>(null);

  const chains = useMemo(
    () =>
      buildBookChains({
        activeOrders: data.activeOrders,
        canceledOrders: data.canceledOrders,
        positions: data.positions,
        closedTrades: data.closedTrades,
        holidays: data.holidays,
      }),
    [data.activeOrders, data.canceledOrders, data.closedTrades, data.holidays, data.positions],
  );
  // Every batch the loaded chains were filed under, which is the whole universe
  // the range control offers and the span its chip is measured against.
  const batchDates = useMemo(
    () =>
      [...new Set(chains.flatMap((chain) => (chain.batchDate ? [chain.batchDate] : [])))].sort(),
    [chains],
  );
  const botById = useMemo(() => new Map(data.bots.map((bot) => [bot.id, bot])), [data.bots]);
  const symbolsNeedingPrices = useMemo(
    () => [
      ...new Set([
        ...data.positions.map((position) => position.symbol),
        ...data.activeOrders
          .filter((order) => order.status === 'PartiallyFilled')
          .map((order) => order.symbol),
      ]),
    ],
    [data.activeOrders, data.positions],
  );
  const priceFeed = useFleetPrices(symbolsNeedingPrices, symbolsNeedingPrices.length > 0);
  const budgets = useBotBudgets(data.bots);
  const snapshotAvailable = !data.isPending && data.error === null;
  const writesHeldReason =
    data.error !== null
      ? 'Actions are held until every Book source returns a complete snapshot.'
      : runtime.writesHeldReason;
  const noClosingOrderCount = chains.filter((chain) => chain.hasNoClosingOrder).length;
  const mismatchRows = data.errors.filter((row) => row.type === 'OrderAccountMismatch');

  const calendar = useMemo(() => holidayCalendar(data.holidays), [data.holidays]);
  /*
   * Every filter but the slippage one. Its `@intent` field reads the prices the
   * page resolves below, and those are read for exactly these chains — so the
   * slippage filter is the last narrowing, applied to what the rest kept.
   */
  const filteredChains = useMemo(
    () =>
      chains.filter((chain) =>
        chainMatches(chain, filters, accountKeyForBot(botById.get(chain.botId))),
      ),
    [botById, chains, filters],
  );
  /*
   * The `@intent/slip` column. Every drawn row names the minute it wants — most
   * name none, since an intent instant during trading hours carries seconds —
   * and the resolved prices come back from the nightly BistData cache. The scale
   * guard is applied per row rather than per bar, because two rows can hold the
   * same minute against different recorded prices.
   */
  const intentRequests = useMemo(
    () =>
      filteredChains.flatMap((chain) =>
        chain.rows.map((row) => ({
          symbol: row.symbol,
          intentTime: row.intentTime,
          reference: intentPriceReference(row),
        })),
      ),
    [filteredChains],
  );
  const intentPrices = useIntentPrices(intentRequests, calendar, snapshotAvailable);
  const intentCells = useMemo(() => {
    const cells = new Map<string, BookIntentCell>();
    for (const chain of filteredChains) {
      for (const row of chain.rows) {
        const price = intentPrices.priceFor({
          symbol: row.symbol,
          intentTime: row.intentTime,
          reference: intentPriceReference(row),
        });
        if (price === null || row.intentTime === null) continue;
        const lookup = intentBarLookup(row.intentTime, calendar);
        const slip =
          lookup !== null &&
          row.averagePrice !== null &&
          intentSlipAllowed(lookup, row.intentTime, row.orderTime)
            ? intentSlippagePercentage({ intentPrice: price, averagePrice: row.averagePrice })
            : null;
        cells.set(row.key, { price, slip });
      }
    }
    return cells;
  }, [calendar, intentPrices, filteredChains]);
  // What the slippage filter reads a row's flags against: the same calendar and
  // the same resolved `@intent` slip the grid draws.
  const rowFlags = useMemo<BookRowFlagContext>(
    () => ({ calendar, intentSlip: (row) => intentCells.get(row.key)?.slip ?? null }),
    [calendar, intentCells],
  );
  /*
   * What is drawn: the chains every filter kept, and — with `matching orders
   * only` on — just the rows of each that pass every filter at once. From here
   * on a figure is read one of two ways. One counted per order (the order count,
   * the canceled toggle, the slip averages) reads the rows drawn; one counted per
   * chain (budget, allocation, P&L) still reads every row of each drawn chain,
   * since a chain's budget or round trip does not split by the row a filter hit.
   */
  const view = useMemo(
    () =>
      drawnBookView(
        filteredChains.filter((chain) => chainMatchesSlippage(chain, filters, rowFlags)),
        filters,
        rowFlags,
      ),
    [filteredChains, filters, rowFlags],
  );
  const visibleChains = view.chains;
  const visiblePending = useMemo(
    () =>
      /* A queued basket has no order yet, so it owns no canceled leg, no
         recorded reason, no origin, no order clocks, no slip and nobody who
         ended it: nothing in it can match those filters, and it drops
         with the chains that cannot match. */
      filters.noClosingOrder ||
      filters.canceledStatusFilter ||
      filters.reasonFilter ||
      filters.sourceFilter ||
      filters.originFilter ||
      filters.timeFilter ||
      filters.slippageFilter ||
      !filters.scopes.has('waiting')
        ? []
        : data.pendingRequests.filter((request) => {
            if (filters.botIds !== null && !filters.botIds.has(request.botId)) return false;
            const accountKey = accountKeyForBot(botById.get(request.botId));
            if (
              filters.accountIds !== null &&
              (accountKey === null || !filters.accountIds.has(accountKey))
            )
              return false;
            const requestSymbols = request.request?.stocks.map((stock) => stock.symbol) ?? [];
            if (
              filters.symbols.size > 0 &&
              !requestSymbols.some((symbol) => filters.symbols.has(symbol))
            )
              return false;
            return true;
          }),
    [botById, data.pendingRequests, filters],
  );
  /*
   * The toggle is its own count, so it counts what it would uncover: the
   * canceled legs on the chains the filters kept, never the whole loaded book.
   * The needs-a-human pill is the one count on this toolbar that stays
   * unfiltered, and it says so in its own words.
   */
  const visibleCanceledCount = useMemo(
    () => visibleChains.reduce((count, chain) => count + drawnCanceledRows(view, chain).length, 0),
    [view, visibleChains],
  );
  const summary = useMemo(
    () => summarize(view, priceFeed.prices, priceFeed.trustworthy, botById, calendar),
    [botById, calendar, priceFeed.prices, priceFeed.trustworthy, view],
  );

  // The `today` column reads each chain's P&L from the start of today's Istanbul calendar
  // day — never the trading session, which rolls to the next day ten minutes past the
  // close while it is still today by the clock until midnight. Reading the session date
  // here instead zeroed the column at that boundary: a chain opened today would suddenly
  // compare itself to today's own, now-final close. Only the chains carried over from an
  // earlier day need a bar read.
  const todayCalendarDate = toIstanbulDateKey(Date.now());
  const basisSessionDate = useMemo(
    () => previousTradingDate(todayCalendarDate, calendar),
    [calendar, todayCalendarDate],
  );
  const overnightSymbols = useMemo(
    () => [
      ...new Set(
        visibleChains
          .filter(
            (chain) =>
              (chain.scope === 'positions' || chain.scope === 'trades') &&
              chain.batchDate !== todayCalendarDate,
          )
          .map((chain) => chain.symbol.toUpperCase()),
      ),
    ],
    [todayCalendarDate, visibleChains],
  );
  const closingBarsQuery = useQuery({
    queryKey: priceKeys.closingBars(
      `book:${basisSessionDate ?? 'none'}:${overnightSymbols.join(',')}`,
    ),
    queryFn: () =>
      priceApi.getClosingAuctionBars(
        overnightSymbols.map((symbol) => ({ symbol, sessionDate: basisSessionDate! })),
      ),
    enabled: snapshotAvailable && basisSessionDate !== null && overnightSymbols.length > 0,
    staleTime: Number.POSITIVE_INFINITY,
    retry: false,
  });
  const closingBars = useMemo(
    () =>
      new Map(
        (closingBarsQuery.data ?? [])
          .filter((bar) => Number.isFinite(bar.close) && bar.close > 0)
          .map((bar) => [bar.symbol.toUpperCase(), bar.close] as const),
      ),
    [closingBarsQuery.data],
  );
  // The strip averages exactly the slips the rows drew, so a withheld one — an
  // auction print, a late registration, an unpriced instant — is absent here too,
  // and so is every row the slippage filter set aside.
  const avgSlipIntent = useMemo(() => {
    const slips = visibleChains.flatMap((chain) =>
      drawnRowsOf(view, chain).flatMap((row) => {
        const slip = rowFlags.intentSlip(row);
        return slip === null ? [] : [slip];
      }),
    );
    return slips.length ? slips.reduce((sum, value) => sum + value, 0) / slips.length : null;
  }, [rowFlags, view, visibleChains]);
  /*
   * An empty `@intent` column has two very different causes, and the reader has
   * to be able to tell them apart: the rules withheld every figure, or the
   * nightly cache is behind and simply has no minute for the newest sessions.
   * Only the second is worth a word, and only once a row actually asked for one.
   */
  /*
   * An empty `@intent` column has two very different causes, and the reader has
   * to be able to tell them apart: the rules withheld every figure, or the
   * history simply does not reach these sessions yet. BistData backfills, so it
   * trails the live sessions by a day or more — which means the newest batch,
   * the one being worked, is usually the one it cannot price. Naming the last
   * session it does reach is the only way that reads as a gap rather than a
   * fault. Said only once a drawn row actually asked for a minute.
   */
  const intentCacheNote = useMemo(() => {
    if (!intentPrices.asked || !intentPrices.statusSettled) return null;
    if (!intentPrices.available || intentPrices.coversThrough === null) {
      return 'intent prices unavailable';
    }
    const beyond = visibleChains.some(
      (chain) => chain.batchDate !== null && chain.batchDate > intentPrices.coversThrough!,
    );
    return beyond
      ? `intent prices ${formatDate(Date.parse(`${intentPrices.coversThrough}T00:00:00+03:00`))}`
      : null;
  }, [intentPrices, visibleChains]);
  const todaySummary = useMemo(
    () =>
      summarizeBookToday(
        visibleChains,
        priceFeed.prices,
        priceFeed.trustworthy,
        closingBars,
        todayCalendarDate,
      ),
    [closingBars, priceFeed.prices, priceFeed.trustworthy, todayCalendarDate, visibleChains],
  );
  // The batch this moment belongs to: on a Saturday, Monday's session, because
  // Friday's evening orders are already filed under it.
  const currentSession =
    sessionBatchDate(Date.now(), calendar) ?? batchDates.at(-1) ?? todayCalendarDate;
  // The days the range can be set to. Read as `active` that is every session a
  // loaded chain was alive in, which reaches days no chain was opened on.
  const rangeDates = useMemo(
    () =>
      filters.batchBasis === 'active'
        ? activeSessionDates(
            chains.flatMap((chain) => (chain.activeSpan === null ? [] : [chain.activeSpan])),
            currentSession,
            calendar,
          )
        : batchDates,
    [batchDates, calendar, chains, currentSession, filters.batchBasis],
  );
  const chips = filterChips(filters, data.bots.length, data.accounts.length, rangeDates);
  const genuineEmpty = chains.length === 0 && data.pendingRequests.length === 0;
  const filteredEmpty = !genuineEmpty && visibleChains.length === 0 && visiblePending.length === 0;
  const emptyCulprits = useMemo(
    () =>
      filteredEmpty
        ? narrowingsThatEmptiedTheBook(
            chains,
            filters,
            (chain) => accountKeyForBot(botById.get(chain.botId)),
            rowFlags,
            rangeDates,
          )
        : [],
    [botById, chains, filters, filteredEmpty, rangeDates, rowFlags],
  );
  const resolvedOpenChain = useMemo(() => resolveOpenChain(chains, openChain), [chains, openChain]);

  // An open batch draws every chain it holds, and the rows only stay memoized
  // while the callbacks handed to them keep their identity between renders.
  const toggleCanceledChain = useCallback((key: string) => {
    setCanceledOverrides((current) => toggleValue(current, key));
  }, []);
  const openChainFromGrid = useCallback((chain: BookChain, action?: OrderDialogAction) => {
    setOpenChain({
      chainKey: chain.key,
      chainSnapshot: chain,
      ...(action
        ? {
            action: {
              kind: action.kind,
              rowKey: action.row.key,
              clientOrderId: action.row.clientOrderId,
              disabled: action.disabled,
              disabledReason: action.disabledReason,
            },
          }
        : {}),
    });
  }, []);

  // A bot card's `Open book` arrives as ?bot=<id>. The deep link seeds the bot
  // filter once; from then on the toolbar owns it, so any hand-made change
  // drops the parameter rather than fighting the state it seeded.
  const scopedBot = searchParams.get('bot');
  const appliedScope = useRef<string | null>(null);
  useEffect(() => {
    if (scopedBot === appliedScope.current) return;
    appliedScope.current = scopedBot;
    setFilters((current) => ({
      ...current,
      botIds: scopedBot === null ? null : new Set([scopedBot]),
      noClosingOrder: false,
    }));
  }, [scopedBot]);

  const applyFilters = (next: BookFilterState) => {
    /*
     * A never-opened chain owns nothing but canceled legs, so switching that
     * scope on while the canceled rows are hidden asks for chains and draws
     * collapsed stubs. The global toggle follows the scope in, and only in:
     * switching the scope back off leaves the toggle exactly where the reader
     * put it, because by then they may be reading canceled legs on chains that
     * traded.
     */
    if (next.scopes.has('canceled') && !filters.scopes.has('canceled') && !showCanceled) {
      setShowCanceled(true);
      setCanceledOverrides(new Set());
    }
    setFilters(next);
    if (searchParams.has('bot')) {
      const params = new URLSearchParams(searchParams);
      params.delete('bot');
      appliedScope.current = null;
      setSearchParams(params, { replace: true });
    }
  };
  // `clear all` drops the chip filters only. The scope segmented control is
  // not a chip and never shows in the `filtered` row, so leave its selection
  // exactly as the reader set it.
  const clearFilters = () => applyFilters({ ...defaultBookFilters, scopes: filters.scopes });

  return (
    <div className="book-page page-pad">
      {/*
       * The heading is the page's name and nothing else. The line under it
       * restated what the Book obviously is and counted bots and accounts the
       * toolbar under it already counts, in triggers that also filter by them.
       */}
      <header className="page-heading">
        <h1>The Book</h1>
      </header>
      {data.error ? (
        <div className="read-error" role="alert">
          <strong>The order snapshot is incomplete.</strong>
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
      <BookFilters
        filters={filters}
        onChange={applyFilters}
        onSettleDates={(range) =>
          /* Settling on the default is not an edit: routed through applyFilters
             it would drop the `?bot=` deep link the page had just been opened
             with, and clear the no-exit toggle with it. */
          setFilters((current) => ({ ...current, batchFrom: range.from, batchTo: range.to }))
        }
        bots={data.bots}
        accounts={data.accounts}
        chains={chains}
        rangeDates={rangeDates}
        batchesLoaded={!data.isPending}
        currentSession={currentSession}
        noClosingOrderCount={noClosingOrderCount}
        mismatchCount={mismatchRows.length}
        canceledCount={visibleCanceledCount}
        canceledVisible={showCanceled}
        manualOpenLegs={
          showCanceled
            ? 0
            : [...canceledOverrides].reduce((count, key) => {
                const chain = visibleChains.find((candidate) => candidate.key === key);
                return count + (chain ? drawnCanceledRows(view, chain).length : 0);
              }, 0)
        }
        manualClosedChains={
          showCanceled
            ? [...canceledOverrides].filter((key) =>
                visibleChains.some((chain) => chain.key === key),
              ).length
            : 0
        }
        onToggleCanceled={() => {
          setShowCanceled((current) => !current);
          setCanceledOverrides(new Set());
        }}
        onOpenMismatch={() => setMismatchOpen(true)}
      />
      {chips.length > 0 ? (
        <div className="filter-chips">
          <span className="kicker">filtered</span>
          {chips.map((chip) => (
            <button
              type="button"
              className="tag tag-outline"
              key={chip.key}
              onClick={() => applyFilters(chip.clear(filters))}
            >
              {chip.label} <span>×</span>
            </button>
          ))}
          <button type="button" className="btn btn-ghost" onClick={clearFilters}>
            clear all
          </button>
          {/* Drawn only where it can change something: a filter that reads rows
              one at a time is on, and every one of those carries a chip here. */}
          {rowFiltersActive(filters) ? (
            <label className="filter-chips-toggle" title={ORDERS_ONLY_TITLE}>
              <input
                type="checkbox"
                checked={filters.ordersOnly}
                onChange={() => applyFilters({ ...filters, ordersOnly: !filters.ordersOnly })}
              />
              <span>matching orders only</span>
            </label>
          ) : null}
        </div>
      ) : null}
      {snapshotAvailable && !genuineEmpty ? (
        <StatStrip
          summary={summary}
          today={todaySummary}
          pendingCount={visiblePending.length}
          avgSlipIntent={avgSlipIntent}
          intentCacheNote={intentCacheNote}
        />
      ) : null}
      {snapshotAvailable && filters.noClosingOrder ? (
        <div className="no-exit-heading">
          <strong>No closing order</strong>
          <span className="kicker">every bot · every account · every batch</span>
          {/* The two shapes are different problems, so the line counts them apart. */}
          <span className="muted">{noExitSentence(visibleChains)}</span>
        </div>
      ) : null}
      {data.isPending ? <BookSkeleton /> : null}
      {snapshotAvailable && visiblePending.length > 0 ? (
        <PendingBaskets
          requests={visiblePending}
          selected={pendingSelection}
          writesHeldReason={writesHeldReason}
          onToggle={(id) => setPendingSelection((current) => toggleNumber(current, id))}
          onCancel={(targets) => setPendingTargets(targets)}
        />
      ) : null}
      {snapshotAvailable && filters.scopes.size === 0 ? (
        <div className="book-empty-reason">
          Nothing selected. Pick at least one of <span>Waiting</span>, Positions, Trades or Canceled
          to list chains.
        </div>
      ) : null}
      {snapshotAvailable && filters.scopes.size > 0 && filteredEmpty ? (
        <div className="book-empty-filter">
          <strong>No chains match this filter.</strong>
          <p>
            {emptyCulprits.length === 0
              ? `The loaded snapshot holds ${plural(chains.length, 'chain')}, and no one filter explains the gap — it takes the whole combination to exclude every one of them.`
              : emptyCulprits.length === 1
                ? `${emptyCulprits[0]!.sentence} Clearing it brings ${plural(emptyCulprits[0]!.restored, 'chain')} back.`
                : `Clearing any one of these brings chains back: ${emptyCulprits
                    .map((culprit) => culprit.phrase)
                    .join(', ')}.`}
          </p>
          <div className="book-empty-actions">
            {emptyCulprits.map((culprit) => (
              <button
                type="button"
                className="btn btn-ghost"
                key={culprit.key}
                onClick={() => applyFilters(culprit.clear(filters))}
              >
                clear {culprit.phrase}
              </button>
            ))}
            <button type="button" className="btn btn-secondary" onClick={clearFilters}>
              Clear every filter
            </button>
          </div>
        </div>
      ) : null}
      {snapshotAvailable && filters.scopes.size > 0 && visibleChains.length > 0 ? (
        <BookGrid
          chains={visibleChains}
          drawnRows={view.rows}
          showScopeHeadings={!filters.noClosingOrder}
          bots={data.bots}
          accounts={data.accounts}
          prices={priceFeed.prices}
          pricesTrustworthy={priceFeed.trustworthy}
          todayCalendarDate={todayCalendarDate}
          closingBars={closingBars}
          intentCells={intentCells}
          calendar={calendar}
          writesHeldReason={writesHeldReason}
          showCanceled={showCanceled}
          openCanceledChains={canceledOverrides}
          onToggleCanceledChain={toggleCanceledChain}
          onOpenChain={openChainFromGrid}
        />
      ) : null}
      {snapshotAvailable && filters.noClosingOrder && visibleChains.length > 0 ? (
        <p className="no-exit-note">
          This list ignores the batch range on purpose. Clear the no closing order chip to return to
          the filtered Book.
        </p>
      ) : null}
      {resolvedOpenChain ? (
        <OrderDialog
          open
          chain={resolvedOpenChain.chain}
          initialAction={resolvedOpenChain.action}
          bot={botById.get(resolvedOpenChain.chain.botId)}
          budget={budgets.data.get(resolvedOpenChain.chain.botId)}
          holidays={data.holidays}
          writesHeldReason={writesHeldReason}
          marketPrice={
            priceFeed.trustworthy
              ? (priceFeed.prices.get(resolvedOpenChain.chain.symbol.toUpperCase())?.price ?? null)
              : null
          }
          onClose={() => setOpenChain(null)}
        />
      ) : null}
      <MismatchDialog
        open={mismatchOpen}
        rows={mismatchRows}
        onClose={() => setMismatchOpen(false)}
      />
      {pendingTargets && pendingTargets.length > 0 ? (
        <PendingCancelDialog
          requests={pendingTargets}
          writesHeldReason={writesHeldReason}
          onClose={() => {
            setPendingTargets(null);
            setPendingSelection(new Set());
          }}
        />
      ) : null}
    </div>
  );
}

function resolveOpenChain(chains: readonly BookChain[], state: OpenChainState | null) {
  if (!state) return null;
  const chain =
    chains.find((candidate) => candidate.key === state.chainKey) ??
    (state.action?.clientOrderId
      ? chains.find(
          (candidate) =>
            candidate.botId === state.chainSnapshot.botId &&
            candidate.rows.some((row) => row.clientOrderId === state.action?.clientOrderId),
        )
      : undefined) ??
    state.chainSnapshot;
  if (!state.action) return { chain, action: undefined };
  const row =
    chain.rows.find((candidate) => candidate.key === state.action?.rowKey) ??
    (state.action.clientOrderId === null
      ? undefined
      : chain.rows.find((candidate) => candidate.clientOrderId === state.action?.clientOrderId));
  if (!row) return { chain, action: undefined };
  const shared = {
    disabled: state.action.disabled,
    disabledReason: state.action.disabledReason,
  };
  let action: OrderDialogAction | undefined;
  if (
    (state.action.kind === 'edit' || state.action.kind === 'cancel') &&
    (row.source === 'active' || row.source === 'scheduled')
  ) {
    action = { kind: state.action.kind, row, ...shared } as OrderDialogAction;
  } else if (state.action.kind === 'sell' && row.source === 'position') {
    action = { kind: 'sell', row, ...shared };
  } else if (state.action.kind === 'resend' && row.source === 'canceled') {
    action = { kind: 'resend', row, ...shared };
  } else if (state.action.kind === 'fire' && row.source === 'scheduled') {
    action = { kind: 'fire', row, ...shared };
  }
  return { chain, action };
}

interface BookNarrowing {
  key: string;
  /** The chip-sized name, for a button that clears exactly this one. */
  phrase: string;
  /** The whole sentence, for the case where this narrowing is the only culprit. */
  sentence: string;
  restored: number;
  clear: (current: BookFilterState) => BookFilterState;
}

/**
 * Names the filter that emptied the view rather than saying "some filter did".
 * A blank table with no reason is a bug (SCREEN-MAP), and the useful reason is
 * which narrowing, cleared on its own, would bring chains back. Several can
 * qualify at once, and none qualifies when only the combination excludes
 * everything — both cases get their own sentence rather than a guess.
 */
export function narrowingsThatEmptiedTheBook(
  chains: readonly BookChain[],
  filters: BookFilterState,
  accountKeyFor: (chain: BookChain) => string | null,
  rowFlags: BookRowFlagContext,
  /** The days the range control offers; every loaded batch unless the page says otherwise. */
  rangeDates: readonly string[] = [
    ...new Set(chains.flatMap((chain) => (chain.batchDate ? [chain.batchDate] : []))),
  ].sort(),
): BookNarrowing[] {
  const candidates: Array<Omit<BookNarrowing, 'restored'>> = [];
  if (filters.scopes.size > 0 && filters.scopes.size < 4) {
    candidates.push({
      key: 'scopes',
      phrase: 'the scope selection',
      sentence: `The selected ${plural(filters.scopes.size, 'scope')} exclude every loaded chain.`,
      clear: (current) => ({
        ...current,
        scopes: new Set<BookScope>(['waiting', 'positions', 'trades', 'canceled']),
      }),
    });
  }
  if (filters.botIds !== null) {
    candidates.push({
      key: 'bots',
      phrase: 'the bot filter',
      /* `none` is a real selection, and it is not a bot that has no chains —
         it is no bot at all, which is the honest thing to say about it. */
      sentence:
        filters.botIds.size === 0
          ? 'No bot is selected.'
          : `The ${plural(filters.botIds.size, 'selected bot')} have no chain in this view.`,
      clear: (current) => ({ ...current, botIds: null }),
    });
  }
  if (filters.accountIds !== null) {
    candidates.push({
      key: 'accounts',
      phrase: 'the account filter',
      sentence: `The ${plural(filters.accountIds.size, 'selected account')} have no chain in this view.`,
      clear: (current) => ({ ...current, accountIds: null }),
    });
  }
  if (filters.symbols.size > 0) {
    candidates.push({
      key: 'symbols',
      phrase: 'the symbol filter',
      sentence: `${[...filters.symbols].join(', ')} has no chain in this view.`,
      clear: (current) => ({ ...current, symbols: new Set<string>() }),
    });
  }
  if (filters.canceledStatusFilter) {
    candidates.push({
      key: 'canceled-statuses',
      phrase: 'the canceled status filter',
      /* Switching it on is a narrowing in its own right, so the sentence says
         what it excludes rather than blaming the ticks when they are all on. */
      sentence:
        filters.canceledStatuses !== null && filters.canceledStatuses.size === 0
          ? 'No canceled status is selected.'
          : 'No chain owns a canceled order with one of the selected statuses.',
      clear: (current) => ({
        ...current,
        canceledStatusFilter: false,
        canceledStatuses: null,
      }),
    });
  }
  if (filters.reasonFilter) {
    candidates.push({
      key: 'reasons',
      phrase: 'the reason filter',
      sentence:
        filters.reasons !== null && filters.reasons.size === 0
          ? 'No reason is selected.'
          : 'No chain owns a row with one of the selected reasons.',
      clear: (current) => ({ ...current, reasonFilter: false, reasons: null }),
    });
  }
  if (filters.sourceFilter) {
    candidates.push({
      key: 'sources',
      phrase: 'the source filter',
      sentence:
        filters.sources !== null && filters.sources.size === 0
          ? 'No source is selected.'
          : 'No chain owns an order ended by one of the selected sources.',
      clear: (current) => ({ ...current, sourceFilter: false, sources: null }),
    });
  }
  if (filters.originFilter) {
    candidates.push({
      key: 'origins',
      phrase: 'the origin filter',
      sentence:
        filters.origins !== null && filters.origins.size === 0
          ? 'No origin is selected.'
          : 'No chain owns a row from one of the selected origins.',
      clear: (current) => ({ ...current, originFilter: false, origins: null }),
    });
  }
  if (filters.timeFilter) {
    candidates.push({
      key: 'time',
      phrase: 'the time filter',
      sentence:
        filters.timeFields.size === 0
          ? 'No time column is selected.'
          : !filters.timeBuys && !filters.timeSells
            ? 'Neither buys nor sells is selected.'
            : 'No chain owns an order with a selected time inside the time range.',
      clear: (current) => ({
        ...current,
        timeFilter: false,
        timeFields: defaultBookFilters.timeFields,
        timeBuys: defaultBookFilters.timeBuys,
        timeSells: defaultBookFilters.timeSells,
        timeIncludeCanceled: defaultBookFilters.timeIncludeCanceled,
      }),
    });
  }
  if (filters.slippageFilter) {
    candidates.push({
      key: 'slippage',
      phrase: 'the slippage filter',
      sentence:
        filters.slippageFields.size === 0
          ? 'No slippage column is selected.'
          : !filters.slippageBuys && !filters.slippageSells
            ? 'Neither buys nor sells is selected.'
            : 'No chain owns an order flagged in a selected column.',
      clear: clearSlippageFilter,
    });
  }
  if (rangeNarrowed(filters, rangeDates)) {
    candidates.push({
      key: 'dates',
      phrase: 'the batch range',
      sentence:
        filters.batchBasis === 'active'
          ? 'No chain was alive on any day of the selected batch range.'
          : 'No chain opened inside the selected batch range.',
      // The widest range, stated outright — the same set the control settles on
      // by default, named rather than left unset. The basis stays: across every
      // day on offer both readings keep the same chains.
      clear: (current) => ({
        ...current,
        batchFrom: rangeDates[0] ?? null,
        batchTo: rangeDates.at(-1) ?? null,
      }),
    });
  }

  /* Last, since it narrows only by what the others leave: every filter can keep
     a chain on a row of its own, and then no single row passes them all. */
  if (filters.ordersOnly) {
    candidates.push({
      key: 'orders-only',
      phrase: 'matching orders only',
      sentence: 'No single order passes every filter at once, so matching orders only draws none.',
      clear: (current) => ({ ...current, ordersOnly: false }),
    });
  }

  return candidates.flatMap((candidate) => {
    const relaxed = candidate.clear(filters);
    const restored = drawnBookView(
      chains.filter(
        (chain) =>
          chainMatches(chain, relaxed, accountKeyFor(chain)) &&
          chainMatchesSlippage(chain, relaxed, rowFlags),
      ),
      relaxed,
      rowFlags,
    ).chains.length;
    return restored > 0 ? [{ ...candidate, restored }] : [];
  });
}

/**
 * The chains the filters kept, and the rows each one draws. `rows` names only a
 * chain that draws fewer rows than it owns; every other chain draws them all.
 */
export interface BookView {
  chains: readonly BookChain[];
  rows: ReadonlyMap<string, readonly BookChainRow[]>;
}

/**
 * Off, `matching orders only` changes nothing: every kept chain is drawn whole.
 * On, each draws the rows that pass every filter at once and keeps its place as
 * a chain however few that leaves; one with no such row is dropped, since the
 * other filters kept it on rows that each fail a different one.
 */
export function drawnBookView(
  kept: readonly BookChain[],
  filters: BookFilterState,
  rowFlags: BookRowFlagContext,
): BookView {
  if (!filters.ordersOnly || !rowFiltersActive(filters)) return { chains: kept, rows: new Map() };
  const rows = new Map<string, readonly BookChainRow[]>();
  const chains = kept.filter((chain) => {
    const matching = chain.rows.filter((row) => rowMatchesFilters(row, filters, rowFlags));
    if (matching.length < chain.rows.length) rows.set(chain.key, matching);
    return matching.length > 0;
  });
  return { chains, rows };
}

function drawnRowsOf(view: BookView, chain: BookChain): readonly BookChainRow[] {
  return view.rows.get(chain.key) ?? chain.rows;
}

function drawnCanceledRows(view: BookView, chain: BookChain): readonly BookChainRow[] {
  const rows = view.rows.get(chain.key);
  return rows === undefined ? chain.canceledRows : rows.filter((row) => row.source === 'canceled');
}

/**
 * Whether one row passes every filter that reads rows one at a time. The rest —
 * scope, bot, account, symbol, the batch range — already answered for its whole
 * chain, and a chain is only asked this once they kept it.
 */
function rowMatchesFilters(
  row: BookChainRow,
  filters: BookFilterState,
  rowFlags: BookRowFlagContext,
): boolean {
  if (filters.canceledStatusFilter && !rowMatchesCanceledStatus(row, filters.canceledStatuses))
    return false;
  if (filters.reasonFilter && !rowMatchesReason(row, filters.reasons)) return false;
  if (filters.sourceFilter && !rowMatchesSource(row, filters.sources)) return false;
  if (filters.originFilter && !rowMatchesOrigin(row, filters.origins)) return false;
  if (
    filters.timeFilter &&
    !rowMatchesBookTime(row, filters.timeFields, filters.timeFrom, filters.timeTo, {
      buys: filters.timeBuys,
      sells: filters.timeSells,
      includeCanceled: filters.timeIncludeCanceled,
    })
  )
    return false;
  if (
    filters.slippageFilter &&
    !rowMatchesBookSlippage(
      row,
      filters.slippageFields,
      { buys: filters.slippageBuys, sells: filters.slippageSells },
      rowFlags,
    )
  )
    return false;
  return true;
}

/** Off, with every field and both sides back — the state the filter comes up in. */
function clearSlippageFilter(current: BookFilterState): BookFilterState {
  return {
    ...current,
    slippageFilter: false,
    slippageFields: defaultBookFilters.slippageFields,
    slippageBuys: defaultBookFilters.slippageBuys,
    slippageSells: defaultBookFilters.slippageSells,
  };
}

/**
 * The slippage filter, kept apart from `chainMatches` because its `@intent`
 * field reads prices resolved for the chains every other filter kept. A chain
 * outside those has no resolved `@intent` slip, exactly as its cell would be
 * empty, so only the other five fields can bring it back.
 */
function chainMatchesSlippage(
  chain: BookChain,
  filters: BookFilterState,
  rowFlags: BookRowFlagContext,
): boolean {
  return (
    !filters.slippageFilter ||
    matchesBookSlippage(
      chain,
      filters.slippageFields,
      { buys: filters.slippageBuys, sells: filters.slippageSells },
      rowFlags,
    )
  );
}

function chainMatches(
  chain: BookChain,
  filters: BookFilterState,
  accountKey: string | null,
): boolean {
  if (filters.noClosingOrder) return chain.hasNoClosingOrder;
  if (!filters.scopes.has(chain.scope)) return false;
  if (filters.botIds !== null && !filters.botIds.has(chain.botId)) return false;
  if (filters.accountIds !== null && (accountKey === null || !filters.accountIds.has(accountKey)))
    return false;
  if (filters.symbols.size > 0 && !filters.symbols.has(chain.symbol)) return false;
  if (filters.canceledStatusFilter && !matchesCanceledStatus(chain, filters.canceledStatuses))
    return false;
  if (filters.reasonFilter && !matchesReason(chain, filters.reasons)) return false;
  if (filters.sourceFilter && !matchesSource(chain, filters.sources)) return false;
  if (filters.originFilter && !matchesOrigin(chain, filters.origins)) return false;
  if (
    filters.timeFilter &&
    !matchesBookTime(chain, filters.timeFields, filters.timeFrom, filters.timeTo, {
      buys: filters.timeBuys,
      sells: filters.timeSells,
      includeCanceled: filters.timeIncludeCanceled,
    })
  )
    return false;
  // A chain with no batch has no span either, and stays out of every range.
  if (
    (filters.batchFrom !== null || filters.batchTo !== null) &&
    (chain.activeSpan === null ||
      !withinBatchRange(
        chain.activeSpan,
        { from: filters.batchFrom, to: filters.batchTo },
        filters.batchBasis,
      ))
  )
    return false;
  return true;
}

/**
 * Whether the range leaves out a day the control offers. A range reaching past
 * them — the other basis's widest, or a batch a refresh no longer holds —
 * excludes nothing, so it is not a narrowing to name or to clear.
 */
function rangeNarrowed(filters: BookFilterState, rangeDates: readonly string[]): boolean {
  const earliest = rangeDates[0];
  const latest = rangeDates.at(-1);
  return (
    (filters.batchFrom !== null && earliest !== undefined && filters.batchFrom > earliest) ||
    (filters.batchTo !== null && latest !== undefined && filters.batchTo < latest)
  );
}

/**
 * A chain qualifies by owning a canceled order whose status is ticked, and it
 * then draws in full — the filter selects chains, never rows, exactly as the
 * symbol filter does. A chain with no canceled leg has nothing that can match,
 * so switching the filter on narrows the Book even with every status ticked;
 * that is what the off switch beside them is for.
 */
function matchesCanceledStatus(chain: BookChain, statuses: ReadonlySet<string> | null): boolean {
  return chain.canceledRows.some((row) => rowMatchesCanceledStatus(row, statuses));
}

function rowMatchesCanceledStatus(
  row: BookChainRow,
  statuses: ReadonlySet<string> | null,
): boolean {
  return (
    row.source === 'canceled' && (statuses === null || statuses.has(displayStatus(row.status)))
  );
}

/**
 * The same chain-not-row selection the canceled-status filter makes, over every
 * row rather than the canceled ones: a chain qualifies by owning any row whose
 * reason is ticked, and is then drawn whole. A chain whose rows carry no reason
 * at all cannot match, which is why switching the filter on narrows the Book
 * even with every reason ticked.
 */
function matchesReason(chain: BookChain, reasons: ReadonlySet<string> | null): boolean {
  return chain.rows.some((row) => rowMatchesReason(row, reasons));
}

function rowMatchesReason(row: BookChainRow, reasons: ReadonlySet<string> | null): boolean {
  return rowReasons(row).some((reason) => reasons === null || reasons.has(reason));
}

/**
 * The same chain-not-row selection again, over who ended a leg. Only a stored
 * death names one, which is why switching the filter on narrows the Book even
 * with every source ticked.
 */
function matchesSource(chain: BookChain, sources: ReadonlySet<string> | null): boolean {
  return chain.rows.some((row) => rowMatchesSource(row, sources));
}

function rowMatchesSource(row: BookChainRow, sources: ReadonlySet<string> | null): boolean {
  return row.statusSource !== null && (sources === null || sources.has(row.statusSource));
}

/**
 * The same chain-not-row selection once more, over where an order came from. The
 * ordinary bot order names no origin, which is why switching the filter on
 * narrows the Book even with every origin ticked.
 */
function matchesOrigin(chain: BookChain, origins: ReadonlySet<string> | null): boolean {
  return chain.rows.some((row) => rowMatchesOrigin(row, origins));
}

function rowMatchesOrigin(row: BookChainRow, origins: ReadonlySet<string> | null): boolean {
  return row.origin !== null && (origins === null || origins.has(row.origin));
}

function accountKeyForBot(bot: Bot | undefined): string | null {
  return bot?.accountId && bot.brokerageId
    ? accountIdentityKey(bot.accountId, bot.brokerageId)
    : null;
}

/**
 * The strip. The money is read off every row of each drawn chain — a chain's
 * P&L, cost and allocation do not split by the row a filter hit — while the
 * order count and the slip averages read only the rows actually drawn.
 */
function summarize(
  view: BookView,
  prices: ReturnType<typeof useFleetPrices>['prices'],
  pricesTrustworthy: boolean,
  botById: ReadonlyMap<string, ReturnType<typeof useBookData>['bots'][number]>,
  calendar: HolidayCalendar,
) {
  const { chains } = view;
  const trades = new Map(
    chains.flatMap((chain) => chain.sources.closedTrades).map((trade) => [trade.id, trade]),
  );
  const positions = new Map(
    chains.flatMap((chain) => chain.sources.positions).map((position) => [position.id, position]),
  );
  const activeOrders = new Map(
    chains.flatMap((chain) => chain.sources.activeOrders).map((order) => [order.id, order]),
  );
  const filledState = deriveFilledPnlState(
    [...positions.values()],
    [...activeOrders.values()],
    [...trades.values()],
  );
  const closedRealized = [...trades.values()].reduce(
    (sum, trade) =>
      sum + realizedPnl(trade.quantity, trade.averageOpenPrice, trade.averageClosePrice),
    0,
  );
  const realized =
    closedRealized +
    filledState.partialSellFills.reduce(
      (sum, fill) =>
        sum + realizedPnl(fill.quantity, fill.averageOpenPrice, fill.averageClosePrice),
      0,
    );
  const costBasis =
    [...trades.values()].reduce((sum, trade) => sum + trade.quantity * trade.averageOpenPrice, 0) +
    filledState.partialSellFills.reduce(
      (sum, fill) => sum + fill.quantity * fill.averageOpenPrice,
      0,
    ) +
    filledState.exposures.reduce(
      (sum, exposure) => sum + exposure.quantity * exposure.averagePrice,
      0,
    );
  let unrealized = 0;
  let hasEveryPrice = true;
  for (const exposure of filledState.exposures) {
    const marketPrice = prices.get(exposure.symbol.toUpperCase())?.price;
    if (marketPrice === null || marketPrice === undefined) hasEveryPrice = false;
    else unrealized += unrealizedPnl(exposure, marketPrice);
  }
  // Exactly the slips the rows drew: a send outside continuous trading withholds
  // the row's `@sent` slip, so it leaves that average too.
  const rows = chains.flatMap((chain) => drawnRowsOf(view, chain));
  const createdSlips = rows
    .map((row) => bookRowCreatedSlip(row))
    .filter((value): value is number => value !== null);
  const sentSlips = rows
    .map((row) => bookRowSentSlip(row, calendar))
    .filter((value): value is number => value !== null);
  return {
    chains: chains.length,
    // Every drawn row is an order, the holding a filled buy left included —
    // the chain dialog's own `chain · N order` kicker already counts it that way.
    orders: rows.length,
    realized,
    unrealized,
    unrealizedKnown: hasEveryPrice,
    marketFiguresTrusted: filledState.exposures.length === 0 || pricesTrustworthy,
    total: hasEveryPrice ? realized + unrealized : null,
    // The strip states the total against what the visible chains actually
    // cost, never against the portfolio (TOKENS 3).
    totalPercentage: hasEveryPrice ? pnlPercentage(realized + unrealized, costBasis) : null,
    // Held against the bots' limits by the visible chains alone, so the filters
    // decide it as they decide every figure beside it.
    allocated: bookAllocation(chains, botById),
    avgSlipCreated: createdSlips.length
      ? createdSlips.reduce((sum, value) => sum + value, 0) / createdSlips.length
      : null,
    avgSlipSent: sentSlips.length
      ? sentSlips.reduce((sum, value) => sum + value, 0) / sentSlips.length
      : null,
  };
}

type BookSummary = ReturnType<typeof summarize>;
type BookTodaySummary = ReturnType<typeof summarizeBookToday>;

function StatStrip({
  summary,
  today,
  pendingCount,
  avgSlipIntent,
  intentCacheNote,
}: {
  summary: BookSummary;
  today: BookTodaySummary;
  pendingCount: number;
  avgSlipIntent: number | null;
  intentCacheNote: string | null;
}) {
  const trustClass = summary.marketFiguresTrusted ? '' : ' number-untrusted';
  return (
    <div className="book-stat-strip fading-rule">
      <Stat
        label="visible"
        accent
        value={`${plural(summary.chains, 'chain')} · ${plural(summary.orders, 'order')}${
          pendingCount ? ` · ${plural(pendingCount, 'queued basket')}` : ''
        }`}
      />
      {/* Session-to-date across the visible chains: mark-to-market on what is still
          held, realized on what sold today, each from its own session-start basis.
          All-or-nothing — one row it cannot price makes the whole figure unavailable. */}
      <Stat
        label="today"
        value={today.available ? formatSignedNumber(today.value) : 'not available'}
        inlineDetail={today.percent === null ? null : formatPercentage(today.percent)}
        signed={today.available ? today.value : undefined}
        unavailable={!today.available}
      />
      <Stat
        label="realized"
        value={formatSignedNumber(summary.realized)}
        signed={summary.realized}
      />
      <Stat
        label="unrealized"
        value={summary.unrealizedKnown ? formatSignedNumber(summary.unrealized) : 'not available'}
        detail={summary.unrealizedKnown && !summary.marketFiguresTrusted ? 'last known' : null}
        signed={summary.marketFiguresTrusted ? summary.unrealized : undefined}
        unavailable={!summary.unrealizedKnown}
        className={trustClass}
      />
      <Stat
        label="total"
        value={summary.total === null ? 'not available' : formatSignedNumber(summary.total)}
        inlineDetail={
          summary.totalPercentage === null ? null : formatPercentage(summary.totalPercentage)
        }
        detail={summary.total !== null && !summary.marketFiguresTrusted ? 'last known' : null}
        signed={summary.marketFiguresTrusted ? (summary.total ?? undefined) : undefined}
        unavailable={summary.total === null}
        className={trustClass}
      />
      <Stat
        label="allocated"
        value={summary.allocated === null ? 'not available' : formatNumber(summary.allocated, 0)}
        unavailable={summary.allocated === null}
        title={ALLOCATED_TITLE}
      />
      <Stat
        label="slip @created"
        value={
          summary.avgSlipCreated === null ? 'not available' : formatSlip(summary.avgSlipCreated)
        }
        unavailable={summary.avgSlipCreated === null}
      />
      <Stat
        label="slip @intent"
        value={avgSlipIntent === null ? 'not available' : formatSlip(avgSlipIntent)}
        detail={intentCacheNote}
        unavailable={avgSlipIntent === null}
      />
      <Stat
        label="slip @sent"
        value={summary.avgSlipSent === null ? 'not available' : formatSlip(summary.avgSlipSent)}
        unavailable={summary.avgSlipSent === null}
      />
    </div>
  );
}

const ALLOCATED_TITLE =
  'Held positions: quantity × average cost, forbidden stocks excluded.\n' +
  'Buys still to open, resting or scheduled: order quantity × order price, × 1.1 for a market buy.';

const ORDERS_ONLY_TITLE =
  'Draw only the orders that pass every filter at once, each still inside its chain.\n' +
  'The order count, the canceled count and the slip averages follow the orders drawn; budget, allocated, P&L and today still read each drawn chain whole.';

function Stat({
  label,
  value,
  detail = null,
  inlineDetail = null,
  accent,
  signed,
  unavailable = false,
  className = '',
  title,
}: {
  label: string;
  value: string;
  detail?: string | null;
  /** A percentage belongs beside its figure, a step down in size. */
  inlineDetail?: string | null;
  accent?: boolean;
  signed?: number;
  unavailable?: boolean;
  className?: string;
  /** How the figure is counted, on hover over the whole stat. */
  title?: string;
}) {
  // TOKENS rule 9: a figure the viewer could not compute is warn ink, never a
  // plain-text absence that reads like an ordinary value.
  const signedClass = unavailable
    ? ' status-warn'
    : signed === undefined
      ? ''
      : signed >= 0
        ? ' number-positive'
        : ' number-negative';
  return (
    <div className="book-stat" title={title}>
      <span className={`kicker${accent ? ' accent-kicker' : ''}`}>{label}</span>
      <strong className={`${signedClass}${unavailable ? '' : className}`}>
        {value}
        {inlineDetail && !unavailable ? <small> {inlineDetail}</small> : null}
      </strong>
      {/* A qualifier is not the figure: at the strip's size it read louder than the number. */}
      {detail ? <small className="status-warn">{detail}</small> : null}
    </div>
  );
}

function PendingBaskets({
  requests,
  selected,
  writesHeldReason,
  onToggle,
  onCancel,
}: {
  requests: readonly PendingOrderRequest[];
  selected: ReadonlySet<number>;
  writesHeldReason: string | null;
  onToggle: (id: number) => void;
  onCancel: (targets: readonly PendingOrderRequest[]) => void;
}) {
  const selectedHere = requests.filter((request) => selected.has(request.id));
  const bots = new Set(selectedHere.map((request) => request.botId));
  return (
    <section className="pending-baskets" aria-label="Queued order baskets">
      <header>
        <span className="kicker">waiting · queued requests</span>
        <span className="muted">baskets have no chain until they fire</span>
        <span className="pending-grow" />
        {selectedHere.length > 0 ? (
          <>
            <span className="muted">
              {plural(selectedHere.length, 'basket')} selected
              {bots.size > 1 ? ` · ${plural(bots.size, 'call')}, one per bot` : ''}
            </span>
            <button
              type="button"
              className="btn btn-ghost"
              disabled={Boolean(writesHeldReason)}
              title={writesHeldReason ?? undefined}
              onClick={() => onCancel(selectedHere)}
            >
              call off selected
            </button>
          </>
        ) : (
          <span className="muted">select baskets to call several off at once</span>
        )}
      </header>
      {requests.map((request) => (
        <div className="pending-basket-group" key={request.id}>
          <div className="pending-basket">
            <span className="pending-spine" />
            <div className="pending-basket-head">
              <label className="pending-select">
                <input
                  type="checkbox"
                  checked={selected.has(request.id)}
                  onChange={() => onToggle(request.id)}
                  aria-label={`Select queued request ${request.id}`}
                />
              </label>
              <strong>queued {request.direction} batch</strong>
              <span className="muted">
                req {request.id} ·{' '}
                {request.request
                  ? `${plural(request.request.stocks.length, 'stock')}, fires as one`
                  : 'request contents unavailable'}
              </span>
              <span className="status-wait">
                next try{' '}
                {formatRowTime(request.nextAttemptTime, toIstanbulDateKey(Date.now())) ?? ''} ·
                attempt {request.retryCount + 1}
              </span>
              {request.request?.budget === undefined ? null : (
                <span className="muted">budget {formatNumber(request.request.budget, 0)}</span>
              )}
              <span className="pending-grow" />
              <button
                type="button"
                className="btn btn-ghost"
                disabled={Boolean(writesHeldReason)}
                title={writesHeldReason ?? undefined}
                onClick={() => onCancel([request])}
              >
                call off…
              </button>
            </div>
          </div>
          {request.request ? (
            <div className="pending-stocks">
              {request.request.stocks.map((stock, index) => (
                <div className="book-row pending-stock" key={`${stock.symbol}:${index}`}>
                  <span className="book-spine pending-stock-spine" aria-hidden="true" />
                  <div className="book-symbol-leg pending-stock-symbol">↳ {stock.symbol}</div>
                  <div className={stock.quantity === undefined ? 'captured-value' : ''}>
                    {stock.quantity === undefined ? 'auto' : formatNumber(stock.quantity, 0)}
                  </div>
                  <div>
                    <span className={request.direction === 'buy' ? 'side-buy' : 'side-sell'}>
                      {request.direction}
                    </span>
                  </div>
                  <div className="align-right">
                    {stock.price === undefined ? '' : formatNumber(stock.price)}
                  </div>
                  {/* @intent/slip, @sent/slip, fill, p&l, today, created, sent,
                      order, final: a queued stock has none of them yet, and each
                      keeps its own cell — and the bands between them their
                      divider — so the row stays on the Book's column grid. */}
                  <div />
                  <div />
                  <div />
                  <ColumnDivider />
                  <div />
                  <div />
                  <ColumnDivider />
                  <div />
                  <div />
                  <div />
                  <div />
                  <ColumnDivider />
                  <div
                    className={
                      stock.cancelAtFloor ? 'book-status status-warn' : 'book-status status-wait'
                    }
                  >
                    <span>
                      {stock.cancelAtFloor ? 'cancelAtFloor on' : 'Queued'}
                      <span className="muted">
                        {' · '}
                        {stock.quantity === undefined
                          ? 'sized from the limit when it is sent'
                          : 'quantity given in the request'}
                        {pendingTimingCopy(stock.openTime ?? stock.closeTime)}
                      </span>
                    </span>
                  </div>
                  <div />
                </div>
              ))}
            </div>
          ) : (
            <p className="pending-unreadable status-warn">
              The stored request body could not be read; no stock count is inferred.
            </p>
          )}
        </div>
      ))}
    </section>
  );
}

/** Only a stock that overrides the basket's own timing earns a line about it. */
function pendingTimingCopy(spec: ScheduleSpec | undefined): string {
  if (!spec) return '';
  const difference = spec.diff === undefined ? '' : ` ${formatNumber(spec.diff)}m`;
  return ` · own time · ${spec.type}${difference}`;
}

function PendingCancelDialog({
  requests,
  writesHeldReason,
  onClose,
}: {
  requests: readonly PendingOrderRequest[];
  writesHeldReason: string | null;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const writesHeldRef = useRef(writesHeldReason);
  writesHeldRef.current = writesHeldReason;
  const [step, setStep] = useState<'confirm' | 'sending' | 'result'>('confirm');
  const [results, setResults] = useState<ActionResult[]>([]);
  // The endpoint names exactly one bot, so a selection spanning bots is one
  // call per bot, itemized in the order they will be made.
  const byBot = groupRequestsByBot(requests);

  const submit = async () => {
    if (writesHeldRef.current) return;
    setStep('sending');
    const collected: ActionResult[] = [];
    for (const [botId, group] of byBot) {
      try {
        const response = await bistApi.cancelPendingOrderRequests(
          botId,
          group.map((request) => request.id),
        );
        for (const request of group) {
          const outcome = response.results.find((row) => row.id === request.id)?.outcome;
          if (outcome === 'canceled' || outcome === 'gone') {
            queryClient.setQueriesData<PendingOrderRequest[]>(
              { queryKey: bistKeys.pendingRequests('*') },
              (rows) => rows?.filter((row) => row.id !== request.id),
            );
            if (outcome === 'gone') {
              void queryClient.invalidateQueries({ queryKey: bistKeys.activeOrders('*') });
            }
          }
          collected.push(pendingOutcomeResult(request, outcome));
        }
      } catch (error) {
        const apiError = asBistApiError(error);
        for (const request of group) collected.push(pendingErrorResult(request, apiError));
      }
    }
    setResults(collected);
    setStep('result');
  };

  return (
    <Modal
      open
      title={
        requests.length === 1
          ? `Cancel queued request ${requests[0]!.id}`
          : `Cancel ${plural(requests.length, 'queued request')}`
      }
      onClose={onClose}
      closeBlocked={step === 'sending'}
    >
      {step === 'confirm' ? (
        <>
          <p>
            Call {requests.length === 1 ? 'this basket' : 'these baskets'} off before anything is
            sized or sent. A basket the server has already replayed answers{' '}
            <span className="book-inline-value">gone</span>, and its orders are then in the active
            list under their own ids.
          </p>
          <ol className="confirm-calls">
            {[...byBot.entries()].map(([botId, group], index) => (
              <li key={botId}>
                <strong>{index + 1} · CancelPendingOrderRequests</strong>
                <span>
                  {botId} · {group.map((request) => `req ${request.id}`).join(', ')}
                </span>
              </li>
            ))}
          </ol>
          {writesHeldReason ? <p className="form-block-reason">{writesHeldReason}</p> : null}
          <div className="dialog-actions">
            <button type="button" className="btn btn-secondary" onClick={onClose}>
              Close
            </button>
            <button
              type="button"
              className="btn btn-primary"
              disabled={Boolean(writesHeldReason)}
              onClick={() => void submit()}
            >
              {requests.length === 1 ? 'Cancel request' : `Cancel ${requests.length} requests`}
            </button>
          </div>
        </>
      ) : null}
      {step === 'sending' ? (
        <div className="sending-panel">
          <div className="sending-call">
            <span className="spinner" />
            CancelPendingOrderRequests is waiting for the server
          </div>
        </div>
      ) : null}
      {step === 'result' ? (
        <>
          <ResultList results={results} />
          <div className="dialog-actions">
            <button type="button" className="btn btn-secondary" onClick={onClose}>
              Done
            </button>
          </div>
        </>
      ) : null}
    </Modal>
  );
}

export function groupRequestsByBot(
  requests: readonly PendingOrderRequest[],
): Map<string, PendingOrderRequest[]> {
  const byBot = new Map<string, PendingOrderRequest[]>();
  for (const request of requests) {
    const group = byBot.get(request.botId) ?? [];
    group.push(request);
    byBot.set(request.botId, group);
  }
  return byBot;
}

function pendingOutcomeResult(
  request: PendingOrderRequest,
  outcome: 'canceled' | 'gone' | 'wrongBot' | undefined,
): ActionResult {
  return {
    id: String(request.id),
    label: `Queued request ${request.id}`,
    tone:
      outcome === 'canceled'
        ? 'landed'
        : outcome === 'gone' || outcome === undefined
          ? 'unknown'
          : 'refused',
    word: outcome === 'canceled' ? 'Removed' : outcome === 'gone' ? 'Gone' : undefined,
    detail:
      outcome === 'canceled'
        ? 'Canceled before any order reached the exchange.'
        : outcome === 'gone'
          ? 'It was on screen a moment ago, so it fired. The next refresh will show its orders under their own ids.'
          : outcome === 'wrongBot'
            ? 'The server says this request belongs to another bot. This viewer made no second attempt.'
            : 'The reply omitted this request id, so the outcome is unknown. Do not submit the cancellation again.',
  };
}

function pendingErrorResult(
  request: PendingOrderRequest,
  apiError: ReturnType<typeof asBistApiError>,
): ActionResult {
  if (apiError.queued) {
    return {
      id: String(request.id),
      label: `Queued request ${request.id}`,
      tone: 'accepted',
      word: 'Queued',
      detail: `${apiError.message} The server owns this cancellation for replay; do not submit it again.`,
    };
  }
  return {
    id: String(request.id),
    label: `Queued request ${request.id}`,
    tone:
      apiError.mayHaveReachedExchange || apiError.kind === 'unknown' || apiError.kind === 'protocol'
        ? 'unknown'
        : 'refused',
    detail: `${apiError.message} This viewer did not retry the call.`,
  };
}

function MismatchDialog({
  open,
  rows,
  onClose,
}: {
  open: boolean;
  rows: readonly ErrorRow[];
  onClose: () => void;
}) {
  return (
    <Modal open={open} title="Account mismatch" onClose={onClose} wide>
      <p className="form-block-reason">
        The viewer cannot tell which account really holds these shares. Check the MatriksIQ terminal
        before acting on the position.
      </p>
      <p className="dialog-note">
        These fields are everything the server saved — the viewer adds nothing and guesses nothing.
      </p>
      <div className="mismatch-list">
        {rows.map((row) => (
          <dl key={row.id}>
            <dt>id</dt>
            <dd>{row.id}</dd>
            <dt>time</dt>
            <dd>{formatDate(row.time)}</dd>
            <dt>type</dt>
            <dd>{row.type}</dd>
            <dt>accountId</dt>
            <dd>{row.accountId ?? ''}</dd>
            <dt>brokerageId</dt>
            <dd>{row.brokerageId ?? ''}</dd>
            <dt>information</dt>
            <dd>{row.information}</dd>
            <dt>context</dt>
            <dd>
              <pre>{row.context ?? ''}</pre>
            </dd>
          </dl>
        ))}
      </div>
      <div className="dialog-actions">
        <button type="button" className="btn btn-secondary" onClick={onClose}>
          Close
        </button>
      </div>
    </Modal>
  );
}

function BookSkeleton() {
  return (
    <div className="book-skeleton" aria-label="Loading the Book">
      <span />
      <span />
      <span />
      <span />
      <span />
    </div>
  );
}

function toggleNumber(values: ReadonlySet<number>, value: number): ReadonlySet<number> {
  const next = new Set(values);
  if (next.has(value)) next.delete(value);
  else next.add(value);
  return next;
}

function toggleValue(values: ReadonlySet<string>, value: string): ReadonlySet<string> {
  const next = new Set(values);
  if (next.has(value)) next.delete(value);
  else next.add(value);
  return next;
}

/**
 * `2 positions holding shares with nothing set to sell them, and 1 waiting buy
 * whose exit is already gone` — a held position and an unguarded buy are not
 * the same problem, so the heading states each count rather than one total.
 */
function noExitSentence(chains: readonly BookChain[]): string {
  const held = chains.filter((chain) => chain.positionRows.length > 0).length;
  const waiting = chains.length - held;
  const heldPart = `${plural(held, 'position')} holding shares with nothing set to sell them`;
  const waitingPart = `${plural(waiting, 'waiting buy', 'waiting buys')} whose exit is already gone`;
  if (held === 0) return waitingPart;
  if (waiting === 0) return heldPart;
  return `${heldPart}, and ${waitingPart}`;
}

function filterChips(
  filters: BookFilterState,
  botCount: number,
  accountCount: number,
  rangeDates: readonly string[],
) {
  const chips: Array<{
    key: string;
    label: string;
    clear: (current: BookFilterState) => BookFilterState;
  }> = [];
  if (filters.noClosingOrder)
    chips.push({
      key: 'no-exit',
      label: 'no closing order',
      clear: (current) => ({ ...current, noClosingOrder: false }),
    });
  if (filters.botIds !== null && filters.botIds.size !== botCount)
    chips.push({
      key: 'bots',
      label: plural(filters.botIds.size, 'bot'),
      clear: (current) => ({ ...current, botIds: null }),
    });
  if (filters.accountIds !== null && filters.accountIds.size !== accountCount)
    chips.push({
      key: 'accounts',
      label: plural(filters.accountIds.size, 'account'),
      clear: (current) => ({ ...current, accountIds: null }),
    });
  // One chip per symbol, never a joined list: a chip is the control that
  // removes what it names, and `AKBNK, GARAN ×` can only drop both at once.
  for (const symbol of [...filters.symbols].sort())
    chips.push({
      key: `symbol:${symbol}`,
      label: symbol,
      clear: (current) => {
        const symbols = new Set(current.symbols);
        symbols.delete(symbol);
        return { ...current, symbols };
      },
    });
  // One chip for the whole status filter, not one per status: what the chip
  // removes is the filter applying at all, and every tick returns with it.
  if (filters.canceledStatusFilter)
    chips.push({
      key: 'canceled-statuses',
      label:
        filters.canceledStatuses === null
          ? 'with a canceled leg'
          : plural(filters.canceledStatuses.size, 'canceled status', 'canceled statuses'),
      clear: (current) => ({
        ...current,
        canceledStatusFilter: false,
        canceledStatuses: null,
      }),
    });
  if (filters.reasonFilter)
    chips.push({
      key: 'reasons',
      label:
        filters.reasons === null
          ? 'with a recorded reason'
          : plural(filters.reasons.size, 'reason'),
      clear: (current) => ({ ...current, reasonFilter: false, reasons: null }),
    });
  if (filters.sourceFilter)
    chips.push({
      key: 'sources',
      label:
        filters.sources === null ? 'with a named source' : plural(filters.sources.size, 'source'),
      clear: (current) => ({ ...current, sourceFilter: false, sources: null }),
    });
  if (filters.originFilter)
    chips.push({
      key: 'origins',
      label:
        filters.origins === null ? 'with a named origin' : plural(filters.origins.size, 'origin'),
      clear: (current) => ({ ...current, originFilter: false, origins: null }),
    });
  if (filters.timeFilter) {
    // The chip names the range, then any way the side toggles depart from
    // "both sides, canceled legs out" — the state the filter comes up in.
    const sideNotes = [
      filters.timeBuys === filters.timeSells ? null : filters.timeBuys ? 'buys only' : 'sells only',
      !filters.timeBuys && !filters.timeSells ? 'no side' : null,
      filters.timeIncludeCanceled ? 'with canceled' : null,
    ].filter((note): note is string => note !== null);
    const range = `time ${formatBookTime(filters.timeFrom)} → ${formatBookTime(filters.timeTo)}`;
    chips.push({
      key: 'time',
      label: sideNotes.length > 0 ? `${range} · ${sideNotes.join(' · ')}` : range,
      clear: (current) => ({
        ...current,
        timeFilter: false,
        timeFields: defaultBookFilters.timeFields,
        timeBuys: defaultBookFilters.timeBuys,
        timeSells: defaultBookFilters.timeSells,
        timeIncludeCanceled: defaultBookFilters.timeIncludeCanceled,
      }),
    });
  }
  if (filters.slippageFilter) {
    // Every column ticked is the plain word; a narrower pick names its columns,
    // then the chip says how the sides depart from "both".
    const fields =
      filters.slippageFields.size === BOOK_SLIPPAGE_FIELDS.length
        ? null
        : filters.slippageFields.size === 0
          ? 'no column'
          : BOOK_SLIPPAGE_FIELDS.filter(({ key }) => filters.slippageFields.has(key))
              .map(({ label }) => label)
              .join(', ');
    const sides =
      filters.slippageBuys === filters.slippageSells
        ? filters.slippageBuys
          ? null
          : 'no side'
        : filters.slippageBuys
          ? 'buys only'
          : 'sells only';
    chips.push({
      key: 'slippage',
      label: ['slippage', fields, sides].filter((part) => part !== null).join(' · '),
      clear: clearSlippageFilter,
    });
  }
  // The range is always set — every loaded batch is the default — so the chip
  // appears only where it is narrower than the days on offer, and names the
  // days it kept rather than the fact that a range exists. Read as `active` it
  // says so, since the same days then keep more chains.
  if (rangeNarrowed(filters, rangeDates)) {
    const range = rangeLabel({ from: filters.batchFrom, to: filters.batchTo });
    chips.push({
      key: 'dates',
      label: filters.batchBasis === 'active' ? `${range} · active on any day` : range,
      clear: (current) => ({
        ...current,
        batchFrom: rangeDates[0] ?? null,
        batchTo: rangeDates.at(-1) ?? null,
      }),
    });
  }
  return chips;
}
