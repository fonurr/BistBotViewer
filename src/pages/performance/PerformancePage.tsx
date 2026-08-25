import { useQuery } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';

import { useBotBudgets, usePerformanceData } from '../../app/dataHooks';
import { priceKeys } from '../../app/queryKeys';
import type { CanceledOrder, ClosedTrade } from '../../bistApi/types';
import {
  buildPerformanceReport,
  type HoldComparison,
  type PerformanceAggregate,
  type PerformanceMetric,
  type PerformanceReport,
} from '../../domain/performance';
import { accountIdentityKey } from '../../domain/accounts';
import {
  formatDateKey,
  formatNumber,
  formatPercentage,
  formatSignedNumber,
  toIstanbulDateKey,
} from '../../domain/format';
import { committedAmount } from '../../domain/orders';
import { priceApi } from '../../priceApi/client';
import type { AuctionBar, AuctionBarKey } from '../../priceApi/types';
import './performance.css';

type WindowMode = 'today' | 'week' | 'range' | 'all';
type BarReadState = 'not-required' | 'pending' | 'error' | 'ready';
type BudgetCommittedState = 'loading' | 'unavailable' | 'ready';

interface BudgetContext {
  limit: number;
  committed: number | null;
  committedState: BudgetCommittedState;
  completeBotsOnly: boolean;
  scopeCopy: string;
}

interface RetryScope {
  rows: CanceledOrder[];
  excludedUntimed: number;
  accountAttributionUnavailable: boolean;
}

interface RetryScopeOptions {
  scopedBot: string | null;
  accountKey: string;
  symbols: readonly string[];
  from: string;
  to: string;
}

export function PerformancePage() {
  const data = usePerformanceData();
  const [searchParams, setSearchParams] = useSearchParams();
  const scopedBot = searchParams.get('bot');
  const today = toIstanbulDateKey(Date.now());
  const [windowMode, setWindowMode] = useState<WindowMode>('all');
  const [rangeFrom, setRangeFrom] = useState(shiftDate(today, -14));
  const [rangeTo, setRangeTo] = useState(today);
  const [selectedAccountKey, setSelectedAccountKey] = useState('*');
  const [symbolInput, setSymbolInput] = useState('');
  const sourceReady = !data.isPending && data.error === null;

  const symbols = useMemo(
    () => [
      ...new Set(
        symbolInput
          .toUpperCase()
          .split(',')
          .map((value) => value.trim())
          .filter(Boolean),
      ),
    ],
    [symbolInput],
  );
  const scopedTrades = useMemo(
    () =>
      data.closedTrades.filter((trade) => {
        if (scopedBot && trade.botId !== scopedBot) return false;
        if (
          selectedAccountKey !== '*' &&
          accountIdentityKey(trade.accountId, trade.brokerageId) !== selectedAccountKey
        )
          return false;
        if (symbols.length > 0 && !symbols.includes(trade.symbol)) return false;
        return true;
      }),
    [data.closedTrades, scopedBot, selectedAccountKey, symbols],
  );
  const selectedBots = useMemo(
    () =>
      data.bots.filter((bot) => {
        if (scopedBot && bot.id !== scopedBot) return false;
        if (
          selectedAccountKey !== '*' &&
          (bot.accountId === null ||
            bot.brokerageId === null ||
            accountIdentityKey(bot.accountId, bot.brokerageId) !== selectedAccountKey)
        )
          return false;
        return true;
      }),
    [data.bots, scopedBot, selectedAccountKey],
  );
  const budgets = useBotBudgets(selectedBots, sourceReady);
  const bounds = useMemo(
    () => windowBounds(windowMode, scopedTrades, today, rangeFrom, rangeTo),
    [rangeFrom, rangeTo, scopedTrades, today, windowMode],
  );
  const baseReport = useMemo(
    () =>
      buildPerformanceReport({
        trades: scopedTrades,
        closingBars: [],
        holidays: data.holidays,
        asOf: endOfIstanbulDay(bounds.to),
        startDate: bounds.from,
      }),
    [bounds.from, bounds.to, data.holidays, scopedTrades],
  );
  const barKey = baseReport.requiredClosingBars
    .map((key) => `${key.symbol}:${key.sessionDate}`)
    .join('|');
  const bars = useQuery({
    queryKey: priceKeys.closingBars(barKey || 'none'),
    queryFn: () => priceApi.getClosingAuctionBars(baseReport.requiredClosingBars),
    enabled: sourceReady && baseReport.requiredClosingBars.length > 0,
    staleTime: (query) =>
      shouldPollClosingBars(
        baseReport.requiredClosingBars,
        query.state.data as AuctionBar[] | undefined,
        today,
      )
        ? 59_000
        : Number.POSITIVE_INFINITY,
    refetchOnMount: true,
    refetchInterval: (query) =>
      shouldPollClosingBars(
        baseReport.requiredClosingBars,
        query.state.data as AuctionBar[] | undefined,
        today,
      )
        ? 60_000
        : false,
    retry: false,
  });
  const barsRequired = sourceReady && baseReport.requiredClosingBars.length > 0;
  const barReadState: BarReadState = !barsRequired
    ? 'not-required'
    : bars.isPending
      ? 'pending'
      : bars.isError
        ? 'error'
        : 'ready';
  const report = useMemo(
    () =>
      buildPerformanceReport({
        trades: scopedTrades,
        closingBars: bars.data ?? [],
        holidays: data.holidays,
        asOf: endOfIstanbulDay(bounds.to),
        startDate: bounds.from,
      }),
    [bars.data, bounds.from, bounds.to, data.holidays, scopedTrades],
  );
  const completeSelectedBots = selectedBots.filter((bot) => bot.complete);
  const committedKnown =
    (completeSelectedBots.length > 0 || selectedBots.length === 0) &&
    !budgets.isPending &&
    budgets.error === null &&
    completeSelectedBots.every((bot) => budgets.data.has(bot.id));
  const budgetContext: BudgetContext = {
    limit: selectedBots.reduce((sum, bot) => sum + bot.limit, 0),
    committed: committedKnown
      ? completeSelectedBots.reduce(
          (sum, bot) => sum + committedAmount(budgets.data.get(bot.id)!),
          0,
        )
      : null,
    committedState: budgets.isPending ? 'loading' : committedKnown ? 'ready' : 'unavailable',
    completeBotsOnly: completeSelectedBots.length !== selectedBots.length,
    scopeCopy: budgetScopeCopy(selectedBots.length, scopedBot !== null, selectedAccountKey !== '*'),
  };
  const retryScope = useMemo(
    () =>
      scopeCanceledRetries(data.canceledOrders, {
        scopedBot,
        accountKey: selectedAccountKey,
        symbols,
        from: bounds.from,
        to: bounds.to,
      }),
    [bounds.from, bounds.to, data.canceledOrders, scopedBot, selectedAccountKey, symbols],
  );

  const clearBot = () => {
    const next = new URLSearchParams(searchParams);
    next.delete('bot');
    setSearchParams(next, { replace: true });
  };

  return (
    <div className="performance-page page-pad">
      <header className="page-heading">
        <h1>Performance</h1>
        <span>
          closed round trips only, gross
          {scopedBot
            ? ` · ${scopedBot}`
            : sourceReady
              ? ` · ${report.summary.tradeCount} trades`
              : data.isPending
                ? ' · loading'
                : ' · unavailable'}
        </span>
      </header>
      {sourceReady ? (
        <div className="performance-toolbar">
          <div className="seg" aria-label="Performance window">
            {(['today', 'week', 'range', 'all'] as const).map((mode) => (
              <label className="seg-opt" key={mode}>
                <input
                  type="radio"
                  name="performance-window"
                  checked={windowMode === mode}
                  onChange={() => setWindowMode(mode)}
                />
                <span>{mode === 'range' ? 'Range' : capitalize(mode)}</span>
              </label>
            ))}
          </div>
          {windowMode === 'range' ? (
            <div className="performance-date-range">
              <input
                className="input"
                type="date"
                value={rangeFrom}
                max={rangeTo}
                onChange={(event) => setRangeFrom(event.target.value)}
                aria-label="Performance from date"
              />
              <span>→</span>
              <input
                className="input"
                type="date"
                value={rangeTo}
                min={rangeFrom}
                max={today}
                onChange={(event) => setRangeTo(event.target.value)}
                aria-label="Performance to date"
              />
            </div>
          ) : (
            <span className="input performance-window-label">
              {formatDateKey(bounds.from)} → {formatDateKey(bounds.to)}
            </span>
          )}
          <select
            className="input performance-select"
            value={scopedBot ?? '*'}
            onChange={(event) => {
              const next = new URLSearchParams(searchParams);
              if (event.target.value === '*') next.delete('bot');
              else next.set('bot', event.target.value);
              setSearchParams(next, { replace: true });
            }}
            aria-label="Bot performance filter"
          >
            <option value="*">All bots</option>
            {data.bots.map((bot) => (
              <option value={bot.id} key={bot.id}>
                {bot.id}
              </option>
            ))}
          </select>
          <select
            className="input performance-select"
            value={selectedAccountKey}
            onChange={(event) => setSelectedAccountKey(event.target.value)}
            aria-label="Account performance filter"
          >
            <option value="*">All accounts</option>
            {data.accounts.map((account) => (
              <option
                value={accountIdentityKey(account.accountId, account.brokerageId)}
                key={accountIdentityKey(account.accountId, account.brokerageId)}
              >
                {account.accountId} · {account.brokerageId}
                {account.owner ? ` · ${account.owner}` : ''}
              </option>
            ))}
          </select>
          <input
            className="input performance-symbols"
            value={symbolInput}
            onChange={(event) => setSymbolInput(event.target.value)}
            placeholder="symbol, symbol…"
            aria-label="Symbol performance filter"
          />
          {scopedBot ? (
            <button type="button" className="tag tag-outline scoped-chip" onClick={clearBot}>
              {scopedBot} <span>×</span>
            </button>
          ) : null}
          <span className="performance-toolbar-spacer" />
          <WindowCoverage report={report} />
        </div>
      ) : null}
      {data.error ? (
        <div className="read-error" role="alert">
          <strong>Performance reads are incomplete.</strong>
          <span>
            {data.error instanceof Error ? data.error.message : 'A source did not answer.'}
          </span>
        </div>
      ) : null}
      {data.isPending ? <PerformanceSkeleton /> : null}
      {sourceReady && barReadState === 'pending' ? (
        <PerformanceSkeleton label="Loading closing-auction bars" />
      ) : null}
      {sourceReady && barReadState === 'error' ? (
        <div className="read-error" role="alert">
          <strong>Closing-bar comparison unavailable.</strong>
          <span>
            {bars.error instanceof Error
              ? bars.error.message
              : 'bars.db failed without a readable reply.'}
          </span>
        </div>
      ) : null}
      {sourceReady && barReadState !== 'pending' && report.summary.tradeCount > 0 ? (
        <>
          <PerformanceStrip summary={report.summary} budgetContext={budgetContext} />
          <PerformanceCurve report={report} />
          {!scopedBot ? <RollupTable title="by bot" report={report} kind="bot" /> : null}
          <div className="performance-cards">
            <ExitTimingCard report={report} barReadState={barReadState} />
            <RetryLedger
              trades={report.trades.map((trade) => trade.raw)}
              canceled={retryScope.rows}
              excludedUntimed={retryScope.excludedUntimed}
              accountAttributionUnavailable={retryScope.accountAttributionUnavailable}
            />
          </div>
          <UnavailableSlippage report={report} />
          {!scopedBot ? <SymbolTable report={report} barReadState={barReadState} /> : null}
          <AccountTable report={report} />
          <Limitations report={report} />
        </>
      ) : null}
    </div>
  );
}

export function scopeCanceledRetries(
  canceledOrders: readonly CanceledOrder[],
  options: RetryScopeOptions,
): RetryScope {
  // CanceledOrders has no account/brokerage field. A bot's current account is not
  // evidence of the account a historical canceled row belonged to.
  if (options.accountKey !== '*') {
    return { rows: [], excludedUntimed: 0, accountAttributionUnavailable: true };
  }

  const symbolSet = new Set(options.symbols);
  const rows: CanceledOrder[] = [];
  let excludedUntimed = 0;
  for (const order of canceledOrders) {
    if (!order.chainId || !order.retryOfClientOrderId) continue;
    if (options.scopedBot && order.botId !== options.scopedBot) continue;
    if (symbolSet.size > 0 && !symbolSet.has(order.symbol)) continue;
    if (order.cancelTime === null) {
      excludedUntimed += 1;
      continue;
    }
    const canceledDate = toIstanbulDateKey(order.cancelTime);
    if (canceledDate < options.from || canceledDate > options.to) continue;
    rows.push(order);
  }
  return { rows, excludedUntimed, accountAttributionUnavailable: false };
}

export function shouldPollClosingBars(
  required: readonly AuctionBarKey[],
  rows: readonly AuctionBar[] | undefined,
  today: string,
): boolean {
  const currentSessionKeys = required.filter((key) => key.sessionDate === today);
  if (currentSessionKeys.length === 0) return false;
  const usable = new Set(
    (rows ?? [])
      .filter((row) => Number.isFinite(row.close) && row.close > 0)
      .map((row) => `${row.symbol.toUpperCase()}|${row.sessionDate}`),
  );
  return currentSessionKeys.some(
    (key) => !usable.has(`${key.symbol.toUpperCase()}|${key.sessionDate}`),
  );
}

function budgetScopeCopy(botCount: number, botScoped: boolean, accountScoped: boolean): string {
  const count = `${botCount} ${botCount === 1 ? 'bot' : 'bots'}`;
  const scope = accountScoped ? 'bot/account scope' : botScoped ? 'bot scope' : 'fleet scope';
  return `${count} · ${scope}; window and symbol filters do not change these limits`;
}

function PerformanceStrip({
  summary,
  budgetContext,
}: {
  summary: PerformanceAggregate;
  budgetContext: BudgetContext;
}) {
  const committedCopy =
    budgetContext.committedState === 'loading'
      ? 'loading current committed amount'
      : budgetContext.committedState === 'unavailable' || budgetContext.committed === null
        ? `current committed amount unavailable${
            budgetContext.completeBotsOnly ? ' · incomplete bots have no budget read' : ''
          }`
        : `${formatNumber(budgetContext.committed, 0)} currently committed${
            budgetContext.completeBotsOnly ? ' · complete bots only' : ''
          }`;
  const metrics: Array<{
    label: string;
    value: string;
    sub: string;
    tone?: string;
    subTone?: string;
    scope?: string;
  }> = [
    {
      label: 'realized',
      value: formatSignedNumber(summary.grossPnl),
      sub: metricText(summary.grossReturnPercent, true),
      tone: signedTone(summary.grossPnl),
    },
    {
      label: 'round trips',
      value: String(summary.tradeCount),
      sub: `${summary.winningTrades} won · ${metricText(summary.winRatePercent, true)}`,
    },
    {
      label: 'per trade',
      value: metricMoney(summary.averageTradePnl),
      sub: 'gross expectancy',
      tone: metricTone(summary.averageTradePnl),
    },
    {
      label: 'avg win',
      value: metricMoney(summary.averageWinPnl),
      sub: `${summary.winningTrades} winning`,
      tone: summary.averageWinPnl.available ? 'number-positive' : 'status-warn',
    },
    {
      label: 'avg loss',
      value: metricMoney(summary.averageLossPnl),
      sub: `${summary.losingTrades} losing`,
      tone: summary.averageLossPnl.available ? 'number-negative' : 'status-warn',
    },
    {
      label: 'max drawdown',
      value: metricMoney(summary.drawdown.amount, false),
      sub:
        summary.drawdown.peakDate && summary.drawdown.troughDate
          ? `${formatDateKey(summary.drawdown.peakDate)} → ${formatDateKey(summary.drawdown.troughDate)}`
          : 'observed gross curve',
      tone: summary.drawdown.amount.available ? 'number-negative' : 'status-warn',
    },
    {
      label: 'configured limits',
      value: formatNumber(budgetContext.limit, 0),
      sub: committedCopy,
      subTone: budgetContext.committedState === 'ready' ? 'muted' : 'status-warn',
      scope: budgetContext.scopeCopy,
    },
    {
      label: 'profit factor',
      value: metricNumber(summary.profitFactor),
      sub: 'gross profit ÷ gross loss',
    },
  ];
  return (
    <div className="performance-strip fading-rule">
      {metrics.map((metric) => (
        <div className="performance-stat" key={metric.label}>
          <span className="kicker">{metric.label}</span>
          <strong className={metric.tone}>{metric.value}</strong>
          <small className={metric.subTone ?? metric.tone ?? 'muted'}>{metric.sub}</small>
          {metric.scope ? <small className="muted">{metric.scope}</small> : null}
        </div>
      ))}
    </div>
  );
}

function PerformanceCurve({ report }: { report: PerformanceReport }) {
  const series = report.summary.series;
  const values = series.map((day) => day.cumulativeGrossPnl);
  const min = Math.min(0, ...values);
  const max = Math.max(0, ...values);
  const span = Math.max(1, max - min);
  const left = 54;
  const right = 940;
  const top = 18;
  const bottom = 180;
  const points = series.map((day, index) => ({
    x: series.length === 1 ? right : left + (index / (series.length - 1)) * (right - left),
    y: bottom - ((day.cumulativeGrossPnl - min) / span) * (bottom - top),
    day,
  }));
  const line = points.map((point) => `${point.x.toFixed(1)},${point.y.toFixed(1)}`).join(' ');
  const area = points.length
    ? `${left},${bottom} ${line} ${points.at(-1)?.x ?? right},${bottom}`
    : '';
  return (
    <section className="performance-section">
      <SectionHeading
        title="cumulative realized"
        detail={`${formatDateKey(report.window.startDate)} → ${formatDateKey(report.window.endDate)} · gross`}
      />
      <div className="curve-wrap">
        <svg viewBox="0 0 960 200" role="img" aria-labelledby="performance-curve-title">
          <title id="performance-curve-title">Cumulative gross realized profit and loss</title>
          {[top, (top + bottom) / 2, bottom].map((y) => (
            <line key={y} x1="0" y1={y} x2="960" y2={y} className="curve-rule" />
          ))}
          <text x="0" y={top + 3}>
            {formatSignedNumber(max, 0)}
          </text>
          <text x="0" y={(top + bottom) / 2 + 3}>
            {formatSignedNumber((max + min) / 2, 0)}
          </text>
          <text x="0" y={bottom - 4}>
            {formatSignedNumber(min, 0)}
          </text>
          {area ? <polygon points={area} className="curve-area" /> : null}
          {line ? <polyline points={line} className="curve-line" /> : null}
          {points
            .filter((point) => point.day.grossPnl < 0)
            .map((point) => (
              <circle key={point.day.date} cx={point.x} cy={point.y} r="3" className="curve-loss" />
            ))}
          {points.at(-1) ? (
            <circle cx={points.at(-1)!.x} cy={points.at(-1)!.y} r="4" className="curve-end" />
          ) : null}
        </svg>
        <div className="curve-caption">
          <span>
            <i /> days that gave gross P&amp;L back
          </span>
          <span>not a portfolio value — no balance history exists to draw one</span>
        </div>
      </div>
    </section>
  );
}

function RollupTable({
  title,
  report,
  kind,
}: {
  title: string;
  report: PerformanceReport;
  kind: 'bot';
}) {
  const rows = kind === 'bot' ? report.byBot : [];
  return (
    <section className="performance-section">
      <SectionHeading title={title} detail="ranked by gross realized P&L" />
      <table className="table performance-table">
        <thead>
          <tr>
            <th>bot</th>
            <th>trips</th>
            <th>won</th>
            <th>realized</th>
            <th>avg win</th>
            <th>avg loss</th>
            <th>per trip</th>
            <th>hold</th>
            <th>slip</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.botId}>
              <td>
                <strong>{row.botId}</strong>
              </td>
              <td>{row.tradeCount}</td>
              <td>
                {row.winningTrades} · {metricText(row.winRatePercent, true)}
              </td>
              <MoneyCell value={row.grossPnl} />
              <MetricCell metric={row.averageWinPnl} money />
              <MetricCell metric={row.averageLossPnl} money />
              <MetricCell metric={row.averageTradePnl} money />
              <td className="status-warn">not available</td>
              <td className="status-warn">not available</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

function ExitTimingCard({
  report,
  barReadState,
}: {
  report: PerformanceReport;
  barReadState: BarReadState;
}) {
  const coverage = report.closingBarCoverage;
  let coverageValue: string | number = coverage.missingCount;
  let coverageTone = 'status-warn';
  let coverageCopy: string;
  if (barReadState === 'error') {
    coverageValue = '—';
    coverageCopy =
      'The bounded bars.db read failed. Bar availability is unknown, so no row is called missing.';
  } else if (coverage.requiredCount === 0) {
    coverageValue = '—';
    coverageCopy =
      'Hold-boundary bars were not requested because the holiday calendar cannot verify this window’s first and last sessions.';
  } else if (coverage.missingCount === coverage.requiredCount) {
    coverageCopy = `No closing-auction bars were returned. ${coverage.missingCount} required hold-boundary bars are missing — not compared, never counted as zero.`;
  } else if (coverage.missingCount > 0 || coverage.invalidCount > 0) {
    coverageCopy = `${coverage.missingCount} of ${coverage.requiredCount} required boundary bars are missing${
      coverage.invalidCount > 0 ? `; ${coverage.invalidCount} more are invalid or ambiguous` : ''
    } — not compared, never counted as zero.`;
  } else {
    coverageValue = `${coverage.presentCount}/${coverage.requiredCount}`;
    coverageTone = 'status-fill';
    coverageCopy = 'Every required hold-boundary bar is present.';
  }
  return (
    <article className="card elev-sm performance-card performance-card-warn">
      <div className="card-kicker status-warn">exit timing</div>
      <h3>Not derivable from ClosedTrades</h3>
      <p>
        The stored execute time is when this server learned of a fill, not the exchange fill time.
        Matching it to that day’s closing auction could select the wrong session, so no cost or
        benefit is invented.
      </p>
      <div className={`metric-line ${coverageTone}`}>
        <strong>{coverageValue}</strong>
        <span>{coverageCopy}</span>
      </div>
    </article>
  );
}

function RetryLedger({
  trades,
  canceled,
  excludedUntimed,
  accountAttributionUnavailable,
}: {
  trades: readonly ClosedTrade[];
  canceled: readonly CanceledOrder[];
  excludedUntimed: number;
  accountAttributionUnavailable: boolean;
}) {
  const tradeChains = new Map(
    trades.filter((trade) => trade.chainId).map((trade) => [trade.chainId!, trade]),
  );
  const retryChains = new Set<string>();
  for (const trade of trades)
    if (trade.chainId && (trade.openRetryOfClientOrderId || trade.closeRetryOfClientOrderId))
      retryChains.add(trade.chainId);
  for (const order of canceled)
    if (order.chainId && order.retryOfClientOrderId) retryChains.add(order.chainId);
  const completed = [...retryChains].flatMap((chainId) =>
    tradeChains.get(chainId) ? [tradeChains.get(chainId)!] : [],
  );
  const gross = completed.reduce(
    (sum, trade) => sum + trade.quantity * (trade.averageClosePrice - trade.averageOpenPrice),
    0,
  );
  const incompleteCount = retryChains.size - completed.length;
  return (
    <article className="card elev-sm performance-card performance-card-dead">
      <div className="card-kicker status-dead">the retry ledger</div>
      <h3>
        {retryChains.size
          ? `${retryChains.size} ${retryChains.size === 1 ? 'chain' : 'chains'} needed another attempt`
          : 'No retry edge in this selected window'}
      </h3>
      <p>
        Retry edges come only from stored retry identifiers. They report what the policy did; they
        do not guess at orders missing from every list.
      </p>
      {accountAttributionUnavailable ? (
        <p className="status-warn">
          CanceledOrders stores no account id. In account scope, canceled-only retry edges are not
          attributed; retry edges carried by the selected closed trades remain included.
        </p>
      ) : null}
      {excludedUntimed > 0 ? (
        <p className="status-warn">
          {excludedUntimed} canceled retry {excludedUntimed === 1 ? 'row has' : 'rows have'} no
          cancel time and cannot be placed inside this selected window.
        </p>
      ) : null}
      <div className={`metric-line ${completed.length > 0 ? 'status-live' : 'muted'}`}>
        <strong>{completed.length}</strong>
        <span>
          {completed.length > 0
            ? `eventually closed · ${formatSignedNumber(gross)} gross`
            : 'completed in this selected window'}
        </span>
      </div>
      <div className={`metric-line ${incompleteCount > 0 ? 'status-dead' : 'muted'}`}>
        <strong>{incompleteCount}</strong>
        <span>no completed round trip in this selected window</span>
      </div>
    </article>
  );
}

function UnavailableSlippage({ report }: { report: PerformanceReport }) {
  return (
    <section className="performance-section">
      <SectionHeading
        title="slippage"
        detail="order price against average fill, signed by price direction"
      />
      <div className="slippage-grid">
        {['entry · limit', 'entry · market', 'exit · limit', 'exit · market'].map((label) => (
          <div className="unavailable-metric" key={label}>
            <span className="kicker">{label}</span>
            <strong className="status-warn">not available</strong>
            <small>
              ClosedTrades stores prices but not order type; {report.summary.tradeCount} trades
              cannot be split without inventing which prices were sent.
            </small>
          </div>
        ))}
      </div>
    </section>
  );
}

function SymbolTable({
  report,
  barReadState,
}: {
  report: PerformanceReport;
  barReadState: BarReadState;
}) {
  return (
    <section className="performance-section">
      <SectionHeading
        title="by symbol"
        detail="gross trading result against the boundary return available from bars.db"
      />
      <table className="table performance-table">
        <thead>
          <tr>
            <th>symbol</th>
            <th>trips</th>
            <th>bot gross</th>
            <th>held return</th>
            <th>coverage</th>
          </tr>
        </thead>
        <tbody>
          {report.bySymbol.map((row) => (
            <tr key={row.symbol}>
              <td>
                <strong>{row.symbol}</strong>
              </td>
              <td>{row.tradeCount}</td>
              <MoneyCell value={row.grossPnl} />
              <HoldReturnCell comparison={row.holdComparison} barReadState={barReadState} />
              <td
                className={
                  barReadState === 'error' || !row.holdComparison.returnPercent.available
                    ? 'status-warn'
                    : 'muted'
                }
              >
                {holdCoverageCopy(row.holdComparison, barReadState)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

function HoldReturnCell({
  comparison,
  barReadState,
}: {
  comparison: HoldComparison;
  barReadState: BarReadState;
}) {
  if (barReadState === 'error') return <td className="status-warn">not available</td>;
  const boundaryCount = holdBoundaryCount(comparison);
  if (
    comparison.returnPercent.reason === 'missing-closing-bar' &&
    boundaryCount > 0 &&
    comparison.missingDates.length === boundaryCount
  ) {
    return <td className="status-warn">not available · no bars</td>;
  }
  return <MetricCell metric={comparison.returnPercent} percent />;
}

function holdCoverageCopy(comparison: HoldComparison, barReadState: BarReadState): string {
  if (barReadState === 'error') return 'bars.db read failed; availability unknown';
  const boundaryCount = holdBoundaryCount(comparison);
  if (comparison.returnPercent.reason === 'missing-closing-bar') {
    if (boundaryCount > 0 && comparison.missingDates.length === boundaryCount) {
      return `${comparison.missingDates.length} boundary bars missing`;
    }
    return `${comparison.missingDates.length} of ${boundaryCount} boundary bars missing`;
  }
  if (comparison.returnPercent.available) {
    return `${comparison.startDate} → ${comparison.endDate}`;
  }
  return unavailableReason(comparison.returnPercent);
}

function holdBoundaryCount(comparison: HoldComparison): number {
  if (comparison.startDate === null || comparison.endDate === null) return 0;
  return comparison.startDate === comparison.endDate ? 1 : 2;
}

function AccountTable({ report }: { report: PerformanceReport }) {
  return (
    <section className="performance-section">
      <SectionHeading
        title="by account"
        detail="closed round trips attributed by their stored brokerage and account"
      />
      <table className="table performance-table">
        <thead>
          <tr>
            <th>account</th>
            <th>brokerage</th>
            <th>trips</th>
            <th>won</th>
            <th>gross</th>
          </tr>
        </thead>
        <tbody>
          {report.byAccount.map((row) => (
            <tr key={row.key}>
              <td>{row.accountId}</td>
              <td>{row.brokerageId}</td>
              <td>{row.tradeCount}</td>
              <td>{metricText(row.winRatePercent, true)}</td>
              <MoneyCell value={row.grossPnl} />
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

function Limitations({ report }: { report: PerformanceReport }) {
  return (
    <section className="limitations">
      <article className="card">
        <div className="card-kicker">what this page cannot say</div>
        <h3>No net result</h3>
        <p>
          There is no commission or tax field. Every figure above is gross; subtracting an invented
          cost would be less accurate than leaving it unavailable.
        </p>
      </article>
      <article className="card">
        <div className="card-kicker">time boundary</div>
        <h3>Acknowledgement, not fill time</h3>
        <p>
          Trades are assigned to the Istanbul date when this server learned of the close.{' '}
          {report.exclusions.missingCloseAcknowledgementCount} rows lacked even that boundary and
          were excluded. {report.exclusions.nonBusinessAcknowledgementCount} were learned on a
          weekend or full holiday; they remain included on that observed acknowledgement date
          because the fill may have happened earlier.
        </p>
      </article>
      <article className="card">
        <div className="card-kicker">calendar boundary</div>
        <h3>{report.window.calendarVerified ? 'Calendar covered' : 'Session count unavailable'}</h3>
        <p>
          {report.window.calendarVerified
            ? `The holiday rows cover this range; ${metricText(report.window.tradingDayCount)} trading days are represented.`
            : 'An empty or partial holiday list cannot prove every absent weekday traded. The report shows observed dates without asserting a session count.'}
        </p>
      </article>
    </section>
  );
}

function WindowCoverage({ report }: { report: PerformanceReport }) {
  return (
    <span
      className={
        report.window.tradingDayCount.available
          ? 'muted window-coverage'
          : 'status-warn window-coverage'
      }
    >
      {report.window.tradingDayCount.available
        ? `${formatNumber(report.window.tradingDayCount.value, 0)} trading days · holidays applied`
        : 'trading-day count unavailable · holiday coverage incomplete'}
    </span>
  );
}

function SectionHeading({ title, detail }: { title: string; detail: string }) {
  return (
    <header className="performance-section-heading">
      <span className="kicker">{title}</span>
      <span className="muted">{detail}</span>
      <i />
    </header>
  );
}
function MoneyCell({ value }: { value: number }) {
  return <td className={signedTone(value)}>{formatSignedNumber(value)}</td>;
}
function MetricCell({
  metric,
  money,
  percent,
}: {
  metric: PerformanceMetric;
  money?: boolean;
  percent?: boolean;
}) {
  return (
    <td className={metric.available ? metricTone(metric) : 'status-warn'}>
      {metric.available
        ? percent
          ? formatPercentage(metric.value)
          : money
            ? formatSignedNumber(metric.value)
            : formatNumber(metric.value)
        : 'not available'}
    </td>
  );
}
function metricMoney(metric: PerformanceMetric, signed = true): string {
  return metric.available
    ? signed
      ? formatSignedNumber(metric.value)
      : formatNumber(metric.value)
    : 'not available';
}
function metricNumber(metric: PerformanceMetric): string {
  return metric.available ? formatNumber(metric.value) : 'not available';
}
function metricText(metric: PerformanceMetric, percent = false): string {
  return metric.available
    ? percent
      ? formatPercentage(metric.value, 1, false)
      : formatNumber(metric.value)
    : 'not available';
}
function metricTone(metric: PerformanceMetric): string | undefined {
  return metric.available ? signedTone(metric.value) : 'status-warn';
}
function signedTone(value: number): string {
  return value >= 0 ? 'number-positive' : 'number-negative';
}
function unavailableReason(metric: PerformanceMetric): string {
  return metric.available ? '' : metric.reason.replaceAll('-', ' ');
}
function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function windowBounds(
  mode: WindowMode,
  trades: readonly ClosedTrade[],
  today: string,
  rangeFrom: string,
  rangeTo: string,
) {
  if (mode === 'today') return { from: today, to: today };
  if (mode === 'week') return { from: shiftDate(today, -6), to: today };
  if (mode === 'range') return { from: rangeFrom, to: rangeTo };
  const dates = trades
    .flatMap((trade) =>
      trade.closeExecuteTime === null ? [] : [toIstanbulDateKey(trade.closeExecuteTime)],
    )
    .sort();
  return { from: dates[0] ?? today, to: today };
}

function shiftDate(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}
function endOfIstanbulDay(date: string): number {
  return Date.parse(`${date}T23:59:59.999+03:00`);
}

function PerformanceSkeleton({ label = 'Loading performance' }: { label?: string }) {
  return (
    <div className="performance-skeleton" aria-label={label}>
      <span />
      <span />
      <span />
    </div>
  );
}
