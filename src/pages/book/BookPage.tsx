import { useQueryClient } from '@tanstack/react-query';
import { useMemo, useRef, useState } from 'react';

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
  formatSignedNumber,
  plural,
} from '../../domain/format';
import {
  committedAmount,
  deriveFilledPnlState,
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
  const [filters, setFilters] = useState<BookFilterState>(defaultBookFilters);
  const [showCanceled, setShowCanceled] = useState(false);
  const [canceledOverrides, setCanceledOverrides] = useState<ReadonlySet<string>>(new Set());
  const [openChain, setOpenChain] = useState<OpenChainState | null>(null);
  const [mismatchOpen, setMismatchOpen] = useState(false);
  const [pendingTarget, setPendingTarget] = useState<PendingOrderRequest | null>(null);

  const chains = useMemo(
    () =>
      buildBookChains({
        activeOrders: data.activeOrders,
        canceledOrders: data.canceledOrders,
        positions: data.positions,
        closedTrades: data.closedTrades,
      }),
    [data.activeOrders, data.canceledOrders, data.closedTrades, data.positions],
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
  const prices = useFleetPrices(symbolsNeedingPrices, symbolsNeedingPrices.length > 0);
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
    () => summarize(visibleChains, prices.quotes, prices.trustworthy, budgets.data, botById),
    [botById, budgets.data, prices.quotes, prices.trustworthy, visibleChains],
  );
  const scopeSummaries = useMemo(
    () => summarizeScopes(visibleChains, visiblePending, prices.quotes, prices.trustworthy),
    [prices.quotes, prices.trustworthy, visibleChains, visiblePending],
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

  const clearFilters = () => setFilters(defaultBookFilters);

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
        onChange={setFilters}
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
              onClick={() => setFilters(chip.clear(filters))}
            >
              {chip.label} <span>×</span>
            </button>
          ))}
          <button type="button" className="btn btn-ghost" onClick={clearFilters}>
            clear all
          </button>
          <span className="muted">
            the strip and chain counts follow the filter; the needs-a-human count does not
          </span>
        </div>
      ) : null}
      {snapshotAvailable && !genuineEmpty ? (
        <StatStrip summary={summary} pendingCount={visiblePending.length} />
      ) : null}
      {snapshotAvailable && !filters.noClosingOrder && filters.scopes.size > 0 ? (
        <ScopeSummaries summaries={scopeSummaries} selected={filters.scopes} />
      ) : null}
      {snapshotAvailable && filters.noClosingOrder ? (
        <div className="no-exit-heading">
          <strong>No closing order</strong>
          <span className="kicker">every bot · every account · every batch</span>
          <span className="muted">
            held shares and waiting buys whose only exit is already gone
          </span>
        </div>
      ) : null}
      {data.isPending ? <BookSkeleton /> : null}
      {snapshotAvailable && visiblePending.length > 0 ? (
        <PendingBaskets requests={visiblePending} onCancel={setPendingTarget} />
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
                onClick={() => setFilters(culprit.clear(filters))}
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
          filters={filters}
          bots={data.bots}
          accounts={data.accounts}
          quotes={prices.quotes}
          pricesTrustworthy={prices.trustworthy}
          writesHeldReason={writesHeldReason}
          showCanceled={showCanceled}
          openCanceledChains={canceledOverrides}
          onToggleCanceledChain={(key) =>
            setCanceledOverrides((current) => toggleValue(current, key))
          }
          onOpenChain={(chain, action) =>
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
            })
          }
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
          onClose={() => setOpenChain(null)}
        />
      ) : null}
      <MismatchDialog
        open={mismatchOpen}
        rows={mismatchRows}
        onClose={() => setMismatchOpen(false)}
      />
      {pendingTarget ? (
        <PendingCancelDialog
          request={pendingTarget}
          writesHeldReason={writesHeldReason}
          onClose={() => setPendingTarget(null)}
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
      sentence: `The ${plural(filters.botIds.size, 'selected bot')} have no chain in this view.`,
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
  if (![...filters.scopes].some((scope) => chain.scopeMembership[scope])) return false;
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
  quotes: ReturnType<typeof useFleetPrices>['quotes'],
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
  let unrealized = 0;
  let hasEveryPrice = true;
  for (const exposure of filledState.exposures) {
    const marketPrice = quotes.get(exposure.symbol)?.son;
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
    committed,
    committedCompleteOnly,
    avgSlip: slips.length ? slips.reduce((sum, value) => sum + value, 0) / slips.length : null,
  };
}

type BookSummary = ReturnType<typeof summarize>;

function summarizeScopes(
  chains: readonly BookChain[],
  pending: readonly PendingOrderRequest[],
  quotes: ReturnType<typeof useFleetPrices>['quotes'],
  pricesTrustworthy: boolean,
) {
  const waitingChains = chains.filter((chain) => chain.scopeMembership.waiting);
  const positionChains = chains.filter((chain) => chain.scopeMembership.positions);
  const tradeChains = chains.filter((chain) => chain.scopeMembership.trades);
  const canceledChains = chains.filter((chain) => chain.scopeMembership.canceled);
  const positions = new Map(
    positionChains.flatMap((chain) => chain.sources.positions).map((row) => [row.id, row]),
  );
  const trades = new Map(
    tradeChains.flatMap((chain) => chain.sources.closedTrades).map((row) => [row.id, row]),
  );
  const activeOrders = new Map(
    positionChains.flatMap((chain) => chain.sources.activeOrders).map((row) => [row.id, row]),
  );
  const filledState = deriveFilledPnlState(
    [...positions.values()],
    [...activeOrders.values()],
    [...trades.values()],
  );
  let positionPnl = 0;
  let everyPositionPriceKnown = true;
  for (const exposure of filledState.exposures) {
    const marketPrice = quotes.get(exposure.symbol)?.son;
    if (marketPrice === null || marketPrice === undefined) everyPositionPriceKnown = false;
    else positionPnl += unrealizedPnl(exposure, marketPrice);
  }
  const realized = [...trades.values()].reduce(
    (total, trade) =>
      total + realizedPnl(trade.quantity, trade.averageOpenPrice, trade.averageClosePrice),
    0,
  );
  return {
    waiting: {
      count: waitingChains.length,
      detail: `${plural(
        waitingChains.reduce(
          (total, chain) => total + chain.activeRows.filter((row) => row.isWaiting).length,
          0,
        ),
        'executable row',
      )}${pending.length ? ` · ${plural(pending.length, 'queued basket')}` : ''}`,
      aggregate: 'can still execute',
      tone: 'status-wait',
    },
    positions: {
      count: positionChains.length,
      detail: plural(
        filledState.exposures
          .filter((exposure) => exposure.source === 'position')
          .reduce((total, exposure) => total + exposure.quantity, 0),
        'held share',
      ),
      aggregate: everyPositionPriceKnown
        ? `${formatSignedNumber(positionPnl)} unrealized${pricesTrustworthy ? '' : ' · last known'}`
        : 'unrealized not available',
      tone:
        everyPositionPriceKnown && pricesTrustworthy
          ? positionPnl >= 0
            ? 'number-positive'
            : 'number-negative'
          : 'status-warn',
    },
    trades: {
      count: tradeChains.length,
      detail: `${plural(trades.size, 'closed round trip')} · gross`,
      aggregate: formatSignedNumber(realized),
      tone: realized >= 0 ? 'number-positive' : 'number-negative',
    },
    canceled: {
      count: canceledChains.length,
      detail: plural(
        canceledChains.reduce((total, chain) => total + chain.canceledRows.length, 0),
        'gone order leg',
      ),
      aggregate: 'historical only',
      tone: 'status-dead',
    },
  } as const;
}

function ScopeSummaries({
  summaries,
  selected,
}: {
  summaries: ReturnType<typeof summarizeScopes>;
  selected: ReadonlySet<keyof ReturnType<typeof summarizeScopes>>;
}) {
  return (
    <div className="book-scope-summaries" aria-label="Selected Book scope aggregates">
      {(['waiting', 'positions', 'trades', 'canceled'] as const).map((scope) =>
        selected.has(scope) ? (
          <div className="book-scope-summary" key={scope}>
            <span className="kicker">{scope}</span>
            <span>
              {plural(summaries[scope].count, 'chain')} · {summaries[scope].detail}
            </span>
            <strong className={summaries[scope].tone}>{summaries[scope].aggregate}</strong>
            <i />
          </div>
        ) : null,
      )}
    </div>
  );
}

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
        value={
          summary.unrealizedKnown
            ? `${formatSignedNumber(summary.unrealized)}${
                summary.marketFiguresTrusted ? '' : ' · last known'
              }`
            : 'not available'
        }
        signed={summary.marketFiguresTrusted ? summary.unrealized : undefined}
        unavailable={!summary.unrealizedKnown}
        className={trustClass}
      />
      <Stat
        label="total"
        value={
          summary.total === null
            ? 'not available'
            : `${formatSignedNumber(summary.total)}${
                summary.marketFiguresTrusted ? '' : ' · last known'
              }`
        }
        signed={summary.marketFiguresTrusted ? (summary.total ?? undefined) : undefined}
        unavailable={summary.total === null}
        className={trustClass}
      />
      <Stat
        label="committed"
        value={
          summary.committed === null
            ? 'not available'
            : `${formatNumber(summary.committed, 0)}${
                summary.committedCompleteOnly ? ' · complete bots only' : ''
              }`
        }
        unavailable={summary.committed === null}
      />
      <Stat
        label="avg slip"
        value={summary.avgSlip === null ? 'not available' : formatPercentage(summary.avgSlip)}
        unavailable={summary.avgSlip === null}
      />
    </div>
  );
}

function Stat({
  label,
  value,
  accent,
  signed,
  unavailable = false,
  className = '',
}: {
  label: string;
  value: string;
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
      <strong className={`${signedClass}${unavailable ? '' : className}`}>{value}</strong>
    </div>
  );
}

function PendingBaskets({
  requests,
  onCancel,
}: {
  requests: readonly PendingOrderRequest[];
  onCancel: (request: PendingOrderRequest) => void;
}) {
  return (
    <section className="pending-baskets" aria-label="Queued order baskets">
      <header>
        <span className="kicker">waiting · queued requests</span>
        <span className="muted">baskets have no chain until they fire</span>
      </header>
      {requests.map((request) => (
        <div className="pending-basket" key={request.id}>
          <span className="pending-spine" />
          <div className="pending-basket-summary">
            <strong>{request.direction} batch</strong>
            <span>
              req {request.id} ·{' '}
              {request.request
                ? `${plural(request.request.stocks.length, 'stock')}, fires as one`
                : 'request contents unavailable'}
            </span>
            <span className="status-wait">
              next try {formatDate(request.nextAttemptTime)} · attempt {request.retryCount + 1}
            </span>
          </div>
          <div className="pending-stock-list">
            {request.request ? (
              request.request.stocks.map((stock, index) => (
                <span key={`${stock.symbol}:${index}`}>
                  <b>{stock.symbol}</b> · {request.request?.type}
                  {stock.quantity === undefined ? ' · quantity at fire' : ` · ${stock.quantity}`}
                  {stock.price === undefined ? '' : ` @ ${formatNumber(stock.price)}`}
                  {pendingTimingCopy(
                    stock.openTime ??
                      stock.closeTime ??
                      request.request?.openTime ??
                      request.request?.closeTime,
                  )}
                </span>
              ))
            ) : (
              <span className="status-warn">
                The stored request body could not be read; no stock count is inferred.
              </span>
            )}
          </div>
          <span className="pending-grow" />
          <button type="button" className="btn btn-ghost" onClick={() => onCancel(request)}>
            cancel
          </button>
        </div>
      ))}
    </section>
  );
}

function pendingTimingCopy(spec: ScheduleSpec | undefined): string {
  if (!spec) return ' · next replay sends now';
  const difference = spec.diff === undefined ? '' : ` ${formatNumber(spec.diff)}m`;
  return ` · ${spec.day} ${spec.type}${difference}`;
}

function PendingCancelDialog({
  request,
  writesHeldReason,
  onClose,
}: {
  request: PendingOrderRequest;
  writesHeldReason: string | null;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const writesHeldRef = useRef(writesHeldReason);
  writesHeldRef.current = writesHeldReason;
  const [step, setStep] = useState<'confirm' | 'sending' | 'result'>('confirm');
  const [results, setResults] = useState<ActionResult[]>([]);
  const submit = async () => {
    if (writesHeldRef.current) return;
    setStep('sending');
    try {
      const response = await bistApi.cancelPendingOrderRequests(request.botId, [request.id]);
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
      setResults([
        {
          id: String(request.id),
          label: `Queued request ${request.id}`,
          tone:
            outcome === 'canceled'
              ? 'landed'
              : outcome === 'gone' || outcome === undefined
                ? 'unknown'
                : 'refused',
          word: outcome === 'canceled' ? 'Removed' : undefined,
          detail:
            outcome === 'canceled'
              ? 'Canceled before any order reached the exchange.'
              : outcome === 'gone'
                ? 'It was on screen a moment ago, so it fired. The next refresh will show its orders under their own ids.'
                : outcome === 'wrongBot'
                  ? 'The server says this request belongs to another bot. This viewer made no second attempt.'
                  : 'The reply omitted this request id, so the outcome is unknown. Do not submit the cancellation again.',
        },
      ]);
    } catch (error) {
      const apiError = asBistApiError(error);
      setResults([
        apiError.queued
          ? {
              id: String(request.id),
              label: `Queued request ${request.id}`,
              tone: 'accepted',
              word: 'Queued',
              detail: `${apiError.message} The server owns this cancellation for replay; do not submit it again.`,
            }
          : {
              id: String(request.id),
              label: `Queued request ${request.id}`,
              tone:
                apiError.mayHaveReachedExchange ||
                apiError.kind === 'unknown' ||
                apiError.kind === 'protocol'
                  ? 'unknown'
                  : 'refused',
              detail: `${apiError.message} This viewer did not retry the call.`,
            },
      ]);
    }
    setStep('result');
  };
  return (
    <Modal
      open
      title={`Cancel queued request ${request.id}`}
      onClose={onClose}
      closeBlocked={step === 'sending'}
    >
      {step === 'confirm' ? (
        <>
          <p>Cancel this whole {request.direction} basket before it sizes or sends any stock.</p>
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
              Cancel request
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

function toggleValue(values: ReadonlySet<string>, value: string): ReadonlySet<string> {
  const next = new Set(values);
  if (next.has(value)) next.delete(value);
  else next.add(value);
  return next;
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
  if (filters.symbols.size > 0)
    chips.push({
      key: 'symbols',
      label: [...filters.symbols].join(', '),
      clear: (current) => ({ ...current, symbols: new Set() }),
    });
  if (filters.batchFrom || filters.batchTo)
    chips.push({
      key: 'dates',
      label: 'batch range',
      clear: (current) => ({ ...current, batchFrom: null, batchTo: null }),
    });
  return chips;
}
