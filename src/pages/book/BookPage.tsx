import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';

import { useBookData, useBotBudgets, useFleetPrices } from '../../app/dataHooks';
import { bistKeys } from '../../app/queryKeys';
import { useViewerRuntime } from '../../app/ViewerRuntime';
import { bistApi } from '../../bistApi/client';
import { asBistApiError } from '../../bistApi/errors';
import type { Bot, ErrorRow, PendingOrderRequest, ScheduleSpec } from '../../bistApi/types';
import { Modal } from '../../components/Modal';
import { ResultList, type ActionResult } from '../../components/ResultList';
import { accountIdentityKey } from '../../domain/accounts';
import { buildBookChains, type BookChain, type BookScope } from '../../domain/chains';
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
  committedAmount,
  deriveFilledPnlState,
  pnlPercentage,
  realizedPnl,
  slippagePercentage,
  unrealizedPnl,
} from '../../domain/orders';
import { BookFilters } from './BookFilters';
import { BookGrid } from './BookGrid';
import { OrderDialog, type OrderDialogAction } from './OrderDialog';
import { defaultBookFilters, type BookFilterState } from './types';
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
  const [showCanceled, setShowCanceled] = useState(false);
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

  const visibleChains = useMemo(
    () =>
      chains.filter((chain) =>
        chainMatches(chain, filters, accountKeyForBot(botById.get(chain.botId))),
      ),
    [botById, chains, filters],
  );
  const visiblePending = useMemo(
    () =>
      filters.noClosingOrder || !filters.scopes.has('waiting')
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
  const summary = useMemo(
    () => summarize(visibleChains, priceFeed.prices, priceFeed.trustworthy, budgets.data, botById),
    [botById, budgets.data, priceFeed.prices, priceFeed.trustworthy, visibleChains],
  );
  const chips = filterChips(filters, data.bots.length, data.accounts.length);
  const genuineEmpty = chains.length === 0 && data.pendingRequests.length === 0;
  const filteredEmpty = !genuineEmpty && visibleChains.length === 0 && visiblePending.length === 0;
  const emptyCulprits = useMemo(
    () =>
      filteredEmpty
        ? narrowingsThatEmptiedTheBook(chains, filters, (chain) =>
            accountKeyForBot(botById.get(chain.botId)),
          )
        : [],
    [botById, chains, filters, filteredEmpty],
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
    setFilters(next);
    if (searchParams.has('bot')) {
      const params = new URLSearchParams(searchParams);
      params.delete('bot');
      appliedScope.current = null;
      setSearchParams(params, { replace: true });
    }
  };
  const clearFilters = () => applyFilters(defaultBookFilters);

  return (
    <div className="book-page page-pad">
      <header className="page-heading">
        <h1>The Book</h1>
        <span>
          every order, position and trade —{' '}
          {data.isPending
            ? 'loading'
            : data.error
              ? 'snapshot unavailable'
              : `${plural(data.bots.length, 'bot')}, ${plural(data.accounts.length, 'account')}`}
        </span>
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
        bots={data.bots}
        accounts={data.accounts}
        chains={chains}
        noClosingOrderCount={noClosingOrderCount}
        mismatchCount={mismatchRows.length}
        canceledCount={data.canceledOrders.length}
        canceledVisible={showCanceled}
        manualOpenLegs={
          showCanceled
            ? 0
            : [...canceledOverrides].reduce(
                (count, key) =>
                  count + (chains.find((chain) => chain.key === key)?.canceledRows.length ?? 0),
                0,
              )
        }
        manualClosedChains={showCanceled ? canceledOverrides.size : 0}
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
          <span className="muted">
            the strip and chain counts follow the filter; the red count does not
          </span>
        </div>
      ) : null}
      {snapshotAvailable && !genuineEmpty ? (
        <StatStrip summary={summary} pendingCount={visiblePending.length} />
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
          showScopeHeadings={!filters.noClosingOrder}
          bots={data.bots}
          accounts={data.accounts}
          prices={priceFeed.prices}
          pricesTrustworthy={priceFeed.trustworthy}
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
  if (filters.batchFrom !== null || filters.batchTo !== null) {
    candidates.push({
      key: 'dates',
      phrase: 'the batch range',
      sentence: 'No chain opened inside the selected batch range.',
      clear: (current) => ({ ...current, batchFrom: null, batchTo: null }),
    });
  }

  return candidates.flatMap((candidate) => {
    const relaxed = candidate.clear(filters);
    const restored = chains.filter((chain) =>
      chainMatches(chain, relaxed, accountKeyFor(chain)),
    ).length;
    return restored > 0 ? [{ ...candidate, restored }] : [];
  });
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
  if (chain.batchDate !== null && filters.batchFrom && chain.batchDate < filters.batchFrom)
    return false;
  if (chain.batchDate !== null && filters.batchTo && chain.batchDate > filters.batchTo)
    return false;
  if (chain.batchDate === null && (filters.batchFrom || filters.batchTo)) return false;
  return true;
}

function accountKeyForBot(bot: Bot | undefined): string | null {
  return bot?.accountId && bot.brokerageId
    ? accountIdentityKey(bot.accountId, bot.brokerageId)
    : null;
}

function summarize(
  chains: readonly BookChain[],
  prices: ReturnType<typeof useFleetPrices>['prices'],
  pricesTrustworthy: boolean,
  budgets: ReadonlyMap<
    string,
    ReturnType<typeof useBotBudgets>['data'] extends Map<string, infer B> ? B : never
  >,
  botById: ReadonlyMap<string, ReturnType<typeof useBookData>['bots'][number]>,
) {
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
  const slips = chains
    .flatMap((chain) => chain.rows)
    .flatMap((row) =>
      row.averagePrice === null
        ? []
        : [
            slippagePercentage({
              orderPrice: row.orderPrice,
              averagePrice: row.averagePrice,
              type: row.orderType,
            }),
          ],
    )
    .filter((value): value is number => value !== null);
  const visibleBots = new Set(chains.map((chain) => chain.botId));
  const completeVisibleBots = [...visibleBots].filter((botId) => botById.get(botId)?.complete);
  const botRecordsKnown = [...visibleBots].every((botId) => botById.has(botId));
  const committedKnown =
    botRecordsKnown && completeVisibleBots.every((botId) => budgets.has(botId));
  const committed = committedKnown
    ? completeVisibleBots.reduce((sum, botId) => sum + committedAmount(budgets.get(botId)!), 0)
    : null;
  const committedCompleteOnly = [...visibleBots].some((botId) => !botById.get(botId)?.complete);
  return {
    chains: chains.length,
    orders: chains.reduce(
      (sum, chain) =>
        sum + chain.activeRows.length + chain.canceledRows.length + chain.tradeRows.length,
      0,
    ),
    realized,
    unrealized,
    unrealizedKnown: hasEveryPrice,
    marketFiguresTrusted: filledState.exposures.length === 0 || pricesTrustworthy,
    total: hasEveryPrice ? realized + unrealized : null,
    // The strip states the total against what the visible chains actually
    // cost, never against the portfolio (TOKENS 3).
    totalPercentage: hasEveryPrice ? pnlPercentage(realized + unrealized, costBasis) : null,
    committed,
    committedCompleteOnly,
    avgSlip: slips.length ? slips.reduce((sum, value) => sum + value, 0) / slips.length : null,
  };
}

type BookSummary = ReturnType<typeof summarize>;

function StatStrip({ summary, pendingCount }: { summary: BookSummary; pendingCount: number }) {
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
        label="committed"
        value={summary.committed === null ? 'not available' : formatNumber(summary.committed, 0)}
        detail={
          summary.committed !== null && summary.committedCompleteOnly ? 'complete bots only' : null
        }
        unavailable={summary.committed === null}
      />
      <Stat
        label="avg slip"
        value={summary.avgSlip === null ? 'not available' : formatSlip(summary.avgSlip)}
        unavailable={summary.avgSlip === null}
      />
    </div>
  );
}

function Stat({
  label,
  value,
  detail = null,
  inlineDetail = null,
  accent,
  signed,
  unavailable = false,
  className = '',
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
    <div className="book-stat">
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
                    </span>{' '}
                    {request.request?.type}
                  </div>
                  <div className="align-right">
                    {stock.price === undefined ? '' : formatNumber(stock.price)}
                  </div>
                  <div />
                  <div />
                  <div />
                  <div />
                  <div />
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

function filterChips(filters: BookFilterState, botCount: number, accountCount: number) {
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
  if (filters.batchFrom || filters.batchTo)
    chips.push({
      key: 'dates',
      label: 'batch range',
      clear: (current) => ({ ...current, batchFrom: null, batchTo: null }),
    });
  return chips;
}
