import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';

import { useBotBudgets, useBotsData, useFleetPrices } from '../../app/dataHooks';
import { useViewerRuntime } from '../../app/ViewerRuntime';
import type { Account, ActiveOrder, Bot, ClosedTrade, Position } from '../../bistApi/types';
import { buildBookChains } from '../../domain/chains';
import {
  formatDateKey,
  formatNumber,
  formatPercentage,
  formatSignedNumber,
  plural,
} from '../../domain/format';
import { committedAmount, deriveFilledPnlState, realizedPnl } from '../../domain/orders';
import { BotConfigDialog, type BotConfigMode } from './BotConfigDialog';
import { BotStatusDialog } from './BotStatusDialog';
import {
  calculateUnrealized,
  getBotCardState,
  summarizeBot,
  type BotCardSummary,
} from './botsModel';
import './bots.css';

type AccountFilter =
  { kind: 'all' } | { kind: 'unset' } | { kind: 'account'; accountId: string; brokerageId: string };

type OpenDialog =
  { kind: 'config'; mode: BotConfigMode; bot: Bot | null } | { kind: 'status'; bot: Bot } | null;

export function BotsPage() {
  const data = useBotsData();
  const runtime = useViewerRuntime();
  const [showActive, setShowActive] = useState(true);
  const [showInactive, setShowInactive] = useState(false);
  const [search, setSearch] = useState('');
  const [accountFilter, setAccountFilter] = useState<AccountFilter>({
    kind: 'all',
  });
  const [accountOpen, setAccountOpen] = useState(false);
  const [dialog, setDialog] = useState<OpenDialog>(null);
  const accountPopoverRef = useRef<HTMLDivElement>(null);
  const accountTriggerRef = useRef<HTMLButtonElement>(null);
  const snapshotAvailable = !data.isPending && data.error === null;

  useEffect(() => {
    if (!accountOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!accountPopoverRef.current?.contains(event.target as Node)) setAccountOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        setAccountOpen(false);
        requestAnimationFrame(() => accountTriggerRef.current?.focus());
      }
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [accountOpen]);

  const summaryByBot = useMemo(
    () =>
      new Map(
        data.bots.map((bot) => [
          bot.id,
          summarizeBot(
            bot.id,
            data.activeOrders,
            data.positions,
            data.closedTrades,
            data.pendingRequests,
          ),
        ]),
      ),
    [data.activeOrders, data.bots, data.closedTrades, data.pendingRequests, data.positions],
  );
  const normalizedSearch = search.trim().toLocaleLowerCase('en-US');
  const visibleBots = useMemo(
    () =>
      data.bots
        .filter((bot) => (bot.active ? showActive : showInactive))
        .filter((bot) => matchesAccount(bot, accountFilter))
        .filter((bot) =>
          normalizedSearch
            ? bot.id.toLocaleLowerCase('en-US').includes(normalizedSearch) ||
              (bot.algoritmId ?? '').toLocaleLowerCase('en-US').includes(normalizedSearch)
            : true,
        )
        .sort((left, right) => {
          const stateDifference = stateRank(left) - stateRank(right);
          return stateDifference || left.id.localeCompare(right.id, 'en');
        }),
    [accountFilter, data.bots, normalizedSearch, showActive, showInactive],
  );
  const visibleBotIds = useMemo(() => new Set(visibleBots.map((bot) => bot.id)), [visibleBots]);
  const visiblePositions = useMemo(
    () => data.positions.filter((position) => visibleBotIds.has(position.botId)),
    [data.positions, visibleBotIds],
  );
  const visibleOrders = useMemo(
    () => data.activeOrders.filter((order) => visibleBotIds.has(order.botId)),
    [data.activeOrders, visibleBotIds],
  );
  const visibleTrades = useMemo(
    () => data.closedTrades.filter((trade) => visibleBotIds.has(trade.botId)),
    [data.closedTrades, visibleBotIds],
  );
  const budgets = useBotBudgets(visibleBots, snapshotAvailable);
  const symbols = useMemo(
    () => [
      ...new Set([
        ...visiblePositions.map((position) => position.symbol),
        ...visibleOrders
          .filter((order) => order.status === 'PartiallyFilled')
          .map((order) => order.symbol),
      ]),
    ],
    [visibleOrders, visiblePositions],
  );
  const prices = useFleetPrices(symbols, snapshotAvailable && symbols.length > 0);
  const fleet = useMemo(() => {
    const chains = buildBookChains({
      activeOrders: visibleOrders,
      canceledOrders: [],
      positions: visiblePositions,
      closedTrades: visibleTrades,
    });
    const latestBatch =
      chains
        .flatMap((chain) => (chain.batchDate ? [chain.batchDate] : []))
        .sort()
        .at(-1) ?? null;
    const filledState = deriveFilledPnlState(visiblePositions, visibleOrders, visibleTrades);
    const closedRealized = visibleTrades.reduce(
      (sum, trade) =>
        sum + realizedPnl(trade.quantity, trade.averageOpenPrice, trade.averageClosePrice),
      0,
    );
    const partialRealized = filledState.partialSellFills.reduce(
      (sum, fill) =>
        sum + realizedPnl(fill.quantity, fill.averageOpenPrice, fill.averageClosePrice),
      0,
    );
    const realized = closedRealized + partialRealized;
    const costBasis =
      visibleTrades.reduce((sum, trade) => sum + trade.quantity * trade.averageOpenPrice, 0) +
      filledState.partialSellFills.reduce(
        (sum, fill) => sum + fill.quantity * fill.averageOpenPrice,
        0,
      );
    const unrealized = calculateUnrealized(
      visiblePositions,
      prices.quotes,
      prices.trustworthy,
      visibleOrders,
      visibleTrades,
    );
    const completeBots = visibleBots.filter((bot) => bot.complete);
    const allCompleteBudgetsKnown = completeBots.every((bot) => budgets.data.has(bot.id));
    const committed = completeBots.reduce(
      (sum, bot) =>
        sum + (budgets.data.has(bot.id) ? committedAmount(budgets.data.get(bot.id)!) : 0),
      0,
    );
    return {
      latestBatch,
      realized,
      realizedPercentage: costBasis === 0 ? null : (realized / costBasis) * 100,
      unrealized,
      committed,
      allCompleteBudgetsKnown,
      incompleteBots: visibleBots.length - completeBots.length,
    };
  }, [
    budgets,
    prices.quotes,
    prices.trustworthy,
    visibleBots,
    visibleOrders,
    visiblePositions,
    visibleTrades,
  ]);
  const priceReason = describePriceIssue(
    prices.status?.feed,
    prices.error,
    fleet.unrealized.reason,
  );
  const pricesLoading = symbols.length > 0 && prices.isPending;

  const clearFilters = () => {
    setShowActive(true);
    setShowInactive(false);
    setSearch('');
    setAccountFilter({ kind: 'all' });
    setAccountOpen(false);
  };

  return (
    <div className="bots-page">
      <header className="bots-heading">
        <h1>Bots</h1>
        <span>
          {data.isPending
            ? 'loading fleet'
            : data.error
              ? 'fleet unavailable'
              : `${plural(data.bots.length, 'bot')} · ${
                  data.bots.filter((bot) => bot.active).length
                } active`}
        </span>
      </header>

      <div className="bots-toolbar">
        <div className="seg" aria-label="Bot activity filters">
          <label className="seg-opt">
            <input
              type="checkbox"
              checked={showActive}
              onChange={(event) => setShowActive(event.target.checked)}
            />
            <span>Active</span>
          </label>
          <label className="seg-opt">
            <input
              type="checkbox"
              checked={showInactive}
              onChange={(event) => setShowInactive(event.target.checked)}
            />
            <span>Inactive</span>
          </label>
        </div>

        <div className="bots-account-filter" ref={accountPopoverRef}>
          <button
            ref={accountTriggerRef}
            type="button"
            className="btn btn-secondary bots-account-trigger"
            aria-haspopup="dialog"
            aria-expanded={accountOpen}
            onClick={() => setAccountOpen((current) => !current)}
          >
            {accountFilterLabel(accountFilter, data.accounts)} <span aria-hidden="true">⌄</span>
          </button>
          {accountOpen ? (
            <div className="bots-account-popover" role="dialog" aria-label="Filter bots by account">
              <span className="kicker">account</span>
              <p>Bot routing uses the account and brokerage together.</p>
              <AccountChoice
                label="All accounts"
                detail={`${data.accounts.length} loaded`}
                checked={accountFilter.kind === 'all'}
                onChange={() => {
                  setAccountFilter({ kind: 'all' });
                  setAccountOpen(false);
                  requestAnimationFrame(() => accountTriggerRef.current?.focus());
                }}
              />
              {data.accounts.map((account) => (
                <AccountChoice
                  key={`${account.accountId}:${account.brokerageId}`}
                  label={`${account.accountId} · ${account.brokerageId}`}
                  detail={account.owner || account.brokerageName}
                  checked={
                    accountFilter.kind === 'account' &&
                    accountFilter.accountId === account.accountId &&
                    accountFilter.brokerageId === account.brokerageId
                  }
                  onChange={() => {
                    setAccountFilter({
                      kind: 'account',
                      accountId: account.accountId,
                      brokerageId: account.brokerageId,
                    });
                    setAccountOpen(false);
                    requestAnimationFrame(() => accountTriggerRef.current?.focus());
                  }}
                />
              ))}
              <AccountChoice
                label="No account set"
                detail="incomplete routing"
                checked={accountFilter.kind === 'unset'}
                onChange={() => {
                  setAccountFilter({ kind: 'unset' });
                  setAccountOpen(false);
                  requestAnimationFrame(() => accountTriggerRef.current?.focus());
                }}
              />
            </div>
          ) : null}
        </div>

        <label className="bots-search">
          <span className="sr-only">Search by bot or algorithm</span>
          <input
            className="input"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="bot or algorithm…"
          />
        </label>
        <span className="bots-toolbar-spacer" />
        <button
          type="button"
          className="btn btn-primary"
          disabled={!snapshotAvailable}
          title={snapshotAvailable ? undefined : 'Wait for a complete fleet snapshot.'}
          onClick={() => {
            setAccountOpen(false);
            setDialog({ kind: 'config', mode: 'add', bot: null });
          }}
        >
          + Add bot
        </button>
      </div>

      {data.error ? (
        <div className="bots-read-error" role="alert">
          <div>
            <strong>The fleet snapshot is incomplete.</strong>
            <span>
              Counts, P&amp;L, account locks, and deactivate outcomes stay unavailable until every
              fleet read succeeds.
            </span>
          </div>
          <button
            type="button"
            className="btn btn-secondary"
            onClick={() => void runtime.requestReconcile()}
          >
            Try the reads again
          </button>
        </div>
      ) : null}

      {data.isPending || data.bots.length > 0 ? (
        <section className="bots-stat-strip fading-rule" aria-label="Visible fleet summary">
          <FleetStat
            label="latest batch"
            accent
            value={snapshotAvailable && fleet.latestBatch ? formatDateKey(fleet.latestBatch) : ''}
          />
          <FleetStat
            label="fleet realized"
            value={snapshotAvailable ? money(fleet.realized) : 'not available'}
            unavailable={!snapshotAvailable}
            signed={snapshotAvailable ? fleet.realized : null}
            detail={
              snapshotAvailable && fleet.realizedPercentage !== null
                ? formatPercentage(fleet.realizedPercentage)
                : null
            }
          />
          <FleetStat
            label="fleet unrealized"
            value={
              !snapshotAvailable
                ? 'not available'
                : pricesLoading
                  ? 'loading'
                  : fleet.unrealized.value === null
                    ? 'stale'
                    : money(fleet.unrealized.value)
            }
            signed={fleet.unrealized.value}
            unavailable={!snapshotAvailable}
            untrusted={!pricesLoading && fleet.unrealized.value === null}
            detail={!pricesLoading && fleet.unrealized.value === null ? priceReason : null}
          />
          <FleetStat
            label="committed"
            value={
              !snapshotAvailable
                ? 'not available'
                : !fleet.allCompleteBudgetsKnown
                  ? 'loading or unavailable'
                  : fleet.incompleteBots > 0
                    ? `${formatNumber(fleet.committed, 0)} · complete bots only`
                    : formatNumber(fleet.committed, 0)
            }
            unavailable={!snapshotAvailable || !fleet.allCompleteBudgetsKnown}
          />
        </section>
      ) : null}

      <section className="bots-list" aria-label="Bot fleet">
        {data.isPending && data.bots.length === 0 ? (
          <>
            <BotCardSkeleton />
            <BotCardSkeleton />
            <BotCardSkeleton />
          </>
        ) : null}
        {!data.isPending && visibleBots.length === 0 && data.bots.length > 0 ? (
          <div className="bots-filter-empty">
            <strong>No bots match these filters.</strong>
            <p>{filteredEmptyReason(showActive, showInactive, accountFilter, normalizedSearch)}</p>
            <button type="button" className="btn btn-secondary" onClick={clearFilters}>
              Clear filters
            </button>
          </div>
        ) : null}
        {visibleBots.map((bot) => {
          const summary = summaryByBot.get(bot.id)!;
          const positions = visiblePositions.filter((position) => position.botId === bot.id);
          const activeOrders = visibleOrders.filter((order) => order.botId === bot.id);
          const closedTrades = visibleTrades.filter((trade) => trade.botId === bot.id);
          return (
            <BotCard
              key={bot.id}
              bot={bot}
              account={findAccount(bot, data.accounts)}
              summary={summary}
              positions={positions}
              activeOrders={activeOrders}
              closedTrades={closedTrades}
              snapshotAvailable={snapshotAvailable}
              snapshotPending={data.isPending}
              pricePending={prices.isPending}
              quotes={prices.quotes}
              pricesTrustworthy={prices.trustworthy}
              priceReason={priceReason}
              onConfigure={(mode) => setDialog({ kind: 'config', mode, bot })}
              onStatus={() => setDialog({ kind: 'status', bot })}
            />
          );
        })}
      </section>

      {dialog?.kind === 'config' ? (
        <BotConfigDialog
          mode={dialog.mode}
          bot={dialog.bot}
          bots={data.bots}
          accounts={data.accounts}
          activeOrders={data.activeOrders}
          positions={data.positions}
          pendingRequests={data.pendingRequests}
          budget={dialog.bot ? budgets.data.get(dialog.bot.id) : undefined}
          onClose={() => setDialog(null)}
        />
      ) : null}
      {dialog?.kind === 'status' ? (
        <BotStatusDialog
          bot={dialog.bot}
          counts={
            summaryByBot.get(dialog.bot.id)?.rowCounts ?? {
              activeOrders: 0,
              scheduledOrders: 0,
              positions: 0,
              closedTrades: 0,
              pendingRequests: 0,
            }
          }
          budget={budgets.data.get(dialog.bot.id)}
          onClose={() => setDialog(null)}
        />
      ) : null}
    </div>
  );
}

function BotCard({
  bot,
  account,
  summary,
  positions,
  activeOrders,
  closedTrades,
  snapshotAvailable,
  snapshotPending,
  pricePending,
  quotes,
  pricesTrustworthy,
  priceReason,
  onConfigure,
  onStatus,
}: {
  bot: Bot;
  account: Account | undefined;
  summary: BotCardSummary;
  positions: readonly Position[];
  activeOrders: readonly ActiveOrder[];
  closedTrades: readonly ClosedTrade[];
  snapshotAvailable: boolean;
  snapshotPending: boolean;
  pricePending: boolean;
  quotes: ReturnType<typeof useFleetPrices>['quotes'];
  pricesTrustworthy: boolean;
  priceReason: string;
  onConfigure: (mode: BotConfigMode) => void;
  onStatus: () => void;
}) {
  const state = getBotCardState(bot);
  const filledState = deriveFilledPnlState(positions, activeOrders, closedTrades);
  const unrealized = calculateUnrealized(
    positions,
    quotes,
    pricesTrustworthy,
    activeOrders,
    closedTrades,
  );
  const missing = [
    bot.algoritmId === null ? 'algorithm id' : null,
    bot.accountId === null || bot.brokerageId === null ? 'account and brokerage' : null,
    bot.emails === null ? 'emails' : null,
  ].filter((value): value is string => value !== null);
  const actionsHeld = !snapshotAvailable;

  return (
    <article className={`card elev-sm bots-card bots-card-${state}`}>
      <span className="bots-card-spine" aria-hidden="true" />
      <div className="bots-card-inner">
        <div className="bots-identity">
          <div className="bots-name-line">
            <span className="bots-name" title={bot.description ?? undefined}>
              {bot.id}
            </span>
            <span className={`tag bots-health bots-health-${state}`}>{state}</span>
          </div>
          <span>{bot.algoritmId ?? ''}</span>
          <span>
            {bot.accountId && bot.brokerageId ? `${bot.accountId} · ${bot.brokerageId}` : ''}
          </span>
          <span>{account?.owner ?? ''}</span>
          {bot.forbiddenStocks.length > 0 ? (
            <div className="bots-forbidden-list" aria-label="Forbidden stocks">
              {bot.forbiddenStocks.map((symbol) => (
                <span className="tag tag-outline" key={symbol}>
                  {symbol}
                </span>
              ))}
              <span>forbidden</span>
            </div>
          ) : null}
        </div>

        <div className="bots-card-main">
          {bot.description !== null ? <p className="bots-description">{bot.description}</p> : null}
          {state === 'incomplete' ? (
            <div className="bots-card-notice bots-card-notice-wait">
              {missing.length > 0
                ? `Missing ${missing.join(', ')}. `
                : 'The server marks this bot incomplete. '}
              Rejected from every order endpoint and scheduled orders are skipped until the missing
              fields are set.
            </div>
          ) : null}
          {state === 'deactivated' && summary.openPositions > 0 ? (
            <div className="bots-card-notice bots-card-notice-dead">
              Still holds {plural(summary.openPositions, 'position')}. It cannot buy, but it can
              still sell, and nobody is managing the exit.
            </div>
          ) : null}

          <div className="bots-metrics">
            {snapshotPending ? (
              <LoadingMetrics />
            ) : !snapshotAvailable ? (
              <UnavailableMetrics />
            ) : (
              <>
                <BotMetric label="buys">
                  <span
                    className="bots-count-shape"
                    aria-label={`${plural(summary.openBuys, 'open buy')}, ${plural(
                      summary.scheduledBuys,
                      'scheduled buy',
                    )}`}
                  >
                    <span className="status-live">{summary.openBuys}</span>
                    <span className="muted">/</span>
                    <span className="status-wait">{summary.scheduledBuys}</span>
                  </span>
                </BotMetric>
                <BotMetric label="positions">
                  <span
                    className="bots-count-shape"
                    aria-label={`${plural(summary.openPositions, 'position')}, ${plural(
                      summary.openSells,
                      'open sell',
                    )}, ${plural(summary.scheduledSells, 'scheduled sell')}`}
                  >
                    <span className="status-fill">{summary.openPositions}</span>
                    <span className="muted">/</span>
                    <span className="status-live">{summary.openSells}</span>
                    <span className="muted">/</span>
                    <span className="status-wait">{summary.scheduledSells}</span>
                  </span>
                </BotMetric>
                <BotMetric label="closed">
                  <span>{summary.closedTrades}</span>
                </BotMetric>
                <BotMetric label="realized">
                  <span className={numberTone(summary.realized)}>{money(summary.realized)}</span>
                  {summary.realizedPercentage !== null ? (
                    <small className={numberTone(summary.realizedPercentage)}>
                      {formatPercentage(summary.realizedPercentage)}
                    </small>
                  ) : null}
                </BotMetric>
                <BotMetric label="unrealized">
                  {filledState.exposures.length > 0 && pricePending ? (
                    <span
                      className="bots-metric-skeleton"
                      aria-label="Loading unrealized P and L"
                    />
                  ) : unrealized.value === null ? (
                    <>
                      <span className="number-untrusted">stale</span>
                      <small className="status-warn">{priceReason}</small>
                    </>
                  ) : (
                    <span className={numberTone(unrealized.value)}>{money(unrealized.value)}</span>
                  )}
                </BotMetric>
              </>
            )}
          </div>
        </div>

        <div className="bots-card-actions">
          <Link className="btn btn-secondary" to={`/book?bot=${encodeURIComponent(bot.id)}`}>
            Open book
          </Link>
          <Link className="btn btn-secondary" to={`/performance?bot=${encodeURIComponent(bot.id)}`}>
            Performance
          </Link>
          {state === 'deactivated' ? (
            <button
              type="button"
              className="btn btn-secondary"
              onClick={onStatus}
              disabled={actionsHeld}
              title={actionsHeld ? 'The complete row snapshot is unavailable.' : undefined}
            >
              Reactivate
            </button>
          ) : (
            <>
              <button
                type="button"
                className={state === 'incomplete' ? 'btn btn-primary' : 'btn btn-secondary'}
                onClick={() => onConfigure(state === 'incomplete' ? 'finish' : 'edit')}
                disabled={actionsHeld}
                title={actionsHeld ? 'The complete row snapshot is unavailable.' : undefined}
              >
                {state === 'incomplete' ? 'Finish setup' : 'Edit'}
              </button>
              <button
                type="button"
                className="btn btn-secondary bots-deactivate-button"
                onClick={onStatus}
                disabled={actionsHeld}
                title={actionsHeld ? 'The complete row snapshot is unavailable.' : undefined}
              >
                Deactivate
              </button>
            </>
          )}
        </div>
      </div>
    </article>
  );
}

function BotMetric({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="bots-metric">
      <span className="kicker">{label}</span>
      <strong>{children}</strong>
    </div>
  );
}

function UnavailableMetrics() {
  return (
    <>
      {['buys', 'positions', 'closed', 'realized', 'unrealized'].map((label) => (
        <BotMetric label={label} key={label}>
          <span className="number-untrusted bots-unavailable">not available</span>
        </BotMetric>
      ))}
    </>
  );
}

function LoadingMetrics() {
  return (
    <>
      {['buys', 'positions', 'closed', 'realized', 'unrealized'].map((label) => (
        <BotMetric label={label} key={label}>
          <span className="bots-metric-skeleton" aria-label={`Loading ${label}`} />
        </BotMetric>
      ))}
    </>
  );
}

function FleetStat({
  label,
  value,
  detail,
  accent = false,
  signed = null,
  untrusted = false,
  unavailable = false,
}: {
  label: string;
  value: string;
  detail?: string | null;
  accent?: boolean;
  signed?: number | null;
  untrusted?: boolean;
  unavailable?: boolean;
}) {
  return (
    <div className="bots-fleet-stat">
      <span className={`kicker${accent ? ' bots-accent-kicker' : ''}`}>{label}</span>
      <strong
        className={
          // TOKENS rule 9: an uncomputable figure is warn ink, not a plain absence.
          unavailable
            ? 'status-warn'
            : `${signed === null ? '' : numberTone(signed)}${untrusted ? ' number-untrusted' : ''}`
        }
      >
        {value}
      </strong>
      {detail ? (
        <small
          className={
            untrusted || unavailable
              ? 'status-warn'
              : signed === null
                ? 'muted'
                : numberTone(signed)
          }
        >
          {detail}
        </small>
      ) : null}
    </div>
  );
}

function AccountChoice({
  label,
  detail,
  checked,
  onChange,
}: {
  label: string;
  detail: string;
  checked: boolean;
  onChange: () => void;
}) {
  return (
    <label className="bots-account-choice">
      <input type="radio" name="bots-account-filter" checked={checked} onChange={onChange} />
      <span className="bots-account-dot" />
      <span>
        <strong>{label}</strong>
        <small>{detail}</small>
      </span>
    </label>
  );
}

function BotCardSkeleton() {
  return (
    <div className="card elev-sm bots-card bots-card-skeleton" aria-label="Loading bot card">
      <span className="bots-card-spine" />
      <div className="bots-card-inner">
        <div className="bots-identity">
          <span className="bots-skeleton-line bots-skeleton-title" />
          <span className="bots-skeleton-line" />
          <span className="bots-skeleton-line" />
        </div>
        <div className="bots-card-main">
          <span className="bots-skeleton-line bots-skeleton-copy" />
          <div className="bots-metrics">
            {Array.from({ length: 5 }, (_, index) => (
              <span className="bots-metric-skeleton" key={index} />
            ))}
          </div>
        </div>
        <div className="bots-skeleton-actions">
          <span />
          <span />
          <span />
        </div>
      </div>
    </div>
  );
}

function matchesAccount(bot: Bot, filter: AccountFilter): boolean {
  if (filter.kind === 'all') return true;
  if (filter.kind === 'unset') return bot.accountId === null || bot.brokerageId === null;
  return bot.accountId === filter.accountId && bot.brokerageId === filter.brokerageId;
}

function accountFilterLabel(filter: AccountFilter, accounts: readonly Account[]): string {
  if (filter.kind === 'all') return 'All accounts';
  if (filter.kind === 'unset') return 'No account set';
  const account = accounts.find(
    (row) => row.accountId === filter.accountId && row.brokerageId === filter.brokerageId,
  );
  return account ? `${account.accountId} · ${account.brokerageId}` : 'Selected account';
}

function findAccount(bot: Bot, accounts: readonly Account[]): Account | undefined {
  return accounts.find(
    (account) => account.accountId === bot.accountId && account.brokerageId === bot.brokerageId,
  );
}

function stateRank(bot: Bot): number {
  const state = getBotCardState(bot);
  return state === 'healthy' ? 0 : state === 'incomplete' ? 1 : 2;
}

function money(value: number): string {
  return value === 0 ? formatNumber(0) : formatSignedNumber(value);
}

function numberTone(value: number): string {
  return value > 0 ? 'number-positive' : value < 0 ? 'number-negative' : '';
}

function filteredEmptyReason(
  showActive: boolean,
  showInactive: boolean,
  accountFilter: AccountFilter,
  search: string,
): string {
  if (!showActive && !showInactive) return 'Both activity checkboxes are off.';
  if (search) return `No bot id or algorithm contains “${search}”.`;
  if (accountFilter.kind !== 'all') return 'No bot routes through the selected account state.';
  return 'The selected activity state has no bots.';
}

function describePriceIssue(
  feed: string | undefined,
  error: unknown,
  reason: 'feed' | 'quote' | null,
): string {
  if (feed && feed !== 'live') return `feed ${feed}`;
  if (error) return 'price service unavailable';
  if (reason === 'quote') return 'required live quote missing';
  return 'feed not live';
}
