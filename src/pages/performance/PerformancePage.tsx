import { useQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState } from 'react';
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
import {
  accountOptions,
  MultiSelectFilter,
  SymbolFilter,
  type FilterSelection,
} from '../../components/EntityFilters';
import { PopoverScrim } from '../../components/FilterPopover';
import { accountIdentityKey } from '../../domain/accounts';
import { holidayCalendar, sessionBatchDate, type HolidayCalendar } from '../../domain/calendar';
import {
  formatCompactDuration,
  formatDateKey,
  formatNumber,
  formatPercentage,
  formatSignedNumber,
  formatSlip,
  plural,
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
  botIds: FilterSelection;
  accountScoped: boolean;
  symbols: ReadonlySet<string>;
  from: string;
  to: string;
  calendar: HolidayCalendar;
}

export function PerformancePage() {
  const data = usePerformanceData();
  const [searchParams, setSearchParams] = useSearchParams();
  const today = toIstanbulDateKey(Date.now());
  const [windowMode, setWindowMode] = useState<WindowMode>('all');
  const [rangeFrom, setRangeFrom] = useState(shiftDate(today, -14));
  const [rangeTo, setRangeTo] = useState(today);
  const [openFilter, setOpenFilter] = useState<string | null>(null);
  const sourceReady = !data.isPending && data.error === null;

  // A bot card's `Performance` button deep-links with `?bot=`; the filter itself
  // is the Book's multi-select, so one selected bot and that link are the same
  // state seen from two sides and are kept in step here.
  const botParam = searchParams.get('bot');
  const [selectedBotIds, setSelectedBotIds] = useState<FilterSelection>(
    botParam ? new Set([botParam]) : null,
  );
  const appliedBotParam = useRef(botParam);
  useEffect(() => {
    if (appliedBotParam.current === botParam) return;
    appliedBotParam.current = botParam;
    setSelectedBotIds(botParam ? new Set([botParam]) : null);
  }, [botParam]);
  const [selectedAccounts, setSelectedAccounts] = useState<FilterSelection>(null);
  const [selectedSymbols, setSelectedSymbols] = useState<ReadonlySet<string>>(
    () => new Set<string>(),
  );

  const pickBots = (selection: FilterSelection) => {
    setSelectedBotIds(selection);
    const only = selection !== null && selection.size === 1 ? [...selection][0]! : null;
    appliedBotParam.current = only;
    const next = new URLSearchParams(searchParams);
    if (only === null) next.delete('bot');
    else next.set('bot', only);
    setSearchParams(next, { replace: true });
  };
  const clearBot = () => pickBots(null);

  const accountScoped = selectedAccounts !== null && selectedAccounts.size !== data.accounts.length;
  const scopedBot =
    selectedBotIds !== null && selectedBotIds.size === 1 ? [...selectedBotIds][0]! : null;

  const inFleetScope = useMemo(
    () =>
      data.closedTrades.filter((trade) => {
        if (selectedBotIds !== null && !selectedBotIds.has(trade.botId)) return false;
        if (
          selectedAccounts !== null &&
          !selectedAccounts.has(accountIdentityKey(trade.accountId, trade.brokerageId))
        )
          return false;
        return true;
      }),
    [data.closedTrades, selectedAccounts, selectedBotIds],
  );
  // The symbol list only holds names the rows in scope actually traded, so a
  // choice can never select nothing.
  const symbolUniverse = useMemo(
    () => [...new Set(inFleetScope.map((trade) => trade.symbol))].sort(),
    [inFleetScope],
  );
  const scopedTrades = useMemo(
    () =>
      selectedSymbols.size === 0
        ? inFleetScope
        : inFleetScope.filter((trade) => selectedSymbols.has(trade.symbol)),
    [inFleetScope, selectedSymbols],
  );
  const tripsByBot = useMemo(() => {
    const counts = new Map<string, number>();
    for (const trade of data.closedTrades)
      counts.set(trade.botId, (counts.get(trade.botId) ?? 0) + 1);
    return counts;
  }, [data.closedTrades]);
  const selectedBots = useMemo(
    () =>
      data.bots.filter((bot) => {
        if (selectedBotIds !== null && !selectedBotIds.has(bot.id)) return false;
        if (
          selectedAccounts !== null &&
          (bot.accountId === null ||
            bot.brokerageId === null ||
            !selectedAccounts.has(accountIdentityKey(bot.accountId, bot.brokerageId)))
        )
          return false;
        return true;
      }),
    [data.bots, selectedAccounts, selectedBotIds],
  );
  const budgets = useBotBudgets(selectedBots, sourceReady);
  const calendar = useMemo(() => holidayCalendar(data.holidays), [data.holidays]);
  const bounds = useMemo(
    () => windowBounds(windowMode, scopedTrades, today, rangeFrom, rangeTo, calendar),
    [calendar, rangeFrom, rangeTo, scopedTrades, today, windowMode],
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
    scopeCopy: budgetScopeCopy(selectedBots.length, scopedBot !== null, accountScoped),
  };
  const retryScope = useMemo(
    () =>
      scopeCanceledRetries(data.canceledOrders, {
        botIds: selectedBotIds,
        accountScoped,
        symbols: selectedSymbols,
        from: bounds.from,
        to: bounds.to,
        calendar,
      }),
    [
      accountScoped,
      bounds.from,
      bounds.to,
      calendar,
      data.canceledOrders,
      selectedBotIds,
      selectedSymbols,
    ],
  );
  // A bot in scope with no closed round trip carries no figure in the table, and
  // the table says so rather than leaving it to be missed.
  const silentBots = useMemo(
    () =>
      selectedBots
        .filter((bot) => !report.byBot.some((row) => row.botId === bot.id))
        .map((bot) => ({
          id: bot.id,
          reason:
            bot.accountId === null || bot.brokerageId === null
              ? 'no account set \u2014 never traded, so it cannot appear in any figure above'
              : 'no closed round trip in this window, so it carries no figure above',
        })),
    [report.byBot, selectedBots],
  );

  return (
    <div className="performance-page page-pad">
      <header className="page-heading">
        <h1>Performance</h1>
        <span>
          closed round trips only, gross
          {scopedBot
            ? ` · ${scopedBot}`
            : sourceReady
              ? ` · ${plural(report.summary.tradeCount, 'trade')}`
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
                <span>{mode === 'range' ? 'Window' : capitalize(mode)}</span>
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
          <MultiSelectFilter
            name="bots"
            open={openFilter === 'bots'}
            setOpen={setOpenFilter}
            heading="one bot, or the whole fleet"
            help="Scoping recomputes every figure and the curve's axis. The by-bot and by-symbol tables are cross-comparisons, so they leave while one bot is selected."
            options={data.bots.map((bot) => ({
              key: bot.id,
              label: bot.id,
              count: tripsByBot.get(bot.id) ?? 0,
            }))}
            selected={selectedBotIds}
            onChange={pickBots}
            one="bot"
            many="bots"
          />
          <MultiSelectFilter
            name="accounts"
            open={openFilter === 'accounts'}
            setOpen={setOpenFilter}
            heading="accounts"
            help="A closed trade is attributed by the account stored on it, not by where its bot routes today."
            options={accountOptions(data.accounts)}
            selected={selectedAccounts}
            onChange={setSelectedAccounts}
            one="account"
            many="accounts"
          />
          <SymbolFilter
            open={openFilter === 'symbols'}
            setOpen={setOpenFilter}
            heading="symbols traded in this scope"
            symbols={symbolUniverse}
            selected={selectedSymbols}
            onChange={setSelectedSymbols}
            keptNote={(count, list) => (
              <>
                {plural(count, 'symbol')} kept: {list}. Every figure below is recomputed over the
                round trips in those names alone.
              </>
            )}
            emptyNote="The list only holds symbols the closed round trips in scope actually traded."
          />
          {scopedBot ? (
            <button type="button" className="tag tag-outline scoped-chip" onClick={clearBot}>
              {scopedBot} <span>×</span>
            </button>
          ) : null}
          <span className="performance-toolbar-spacer" />
          <WindowCoverage report={report} />
          {openFilter ? <PopoverScrim onClose={() => setOpenFilter(null)} /> : null}
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
          <PerformanceStrip summary={report.summary} />
          <PerformanceCurve report={report} />
          {!scopedBot ? <RollupTable report={report} silentBots={silentBots} /> : null}
          <div className="performance-cards">
            <ExitTimingCard report={report} barReadState={barReadState} />
            <RetryLedger
              trades={report.trades.map((trade) => trade.raw)}
              canceled={retryScope.rows}
              excludedUntimed={retryScope.excludedUntimed}
              accountAttributionUnavailable={retryScope.accountAttributionUnavailable}
              grossRealized={report.summary.grossPnl}
            />
          </div>
          <SlippageSection report={report} />
          {!scopedBot ? <SymbolTable report={report} barReadState={barReadState} /> : null}
          <AccountTable report={report} />
          <Limitations report={report} budgetContext={budgetContext} />
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
  if (options.accountScoped) {
    return { rows: [], excludedUntimed: 0, accountAttributionUnavailable: true };
  }

  const rows: CanceledOrder[] = [];
  let excludedUntimed = 0;
  for (const order of canceledOrders) {
    if (!order.chainId || !order.retryOfClientOrderId) continue;
    if (options.botIds !== null && !options.botIds.has(order.botId)) continue;
    if (options.symbols.size > 0 && !options.symbols.has(order.symbol)) continue;
    // A dead attempt is placed in the batch it was aimed at, the same way the Book places
    // the chain it belongs to, so a window holds an evening rejection and the trade its
    // ladder finally opened together.
    const batch = sessionBatchDate(
      order.orderTime ?? order.sentTime ?? order.cancelTime,
      options.calendar,
    );
    if (batch === null) {
      excludedUntimed += 1;
      continue;
    }
    if (batch < options.from || batch > options.to) continue;
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
  const count = plural(botCount, 'bot');
  const scope = accountScoped ? 'bot/account scope' : botScoped ? 'bot scope' : 'fleet scope';
  return `${count} · ${scope}; window and symbol filters do not change these limits`;
}

function PerformanceStrip({ summary }: { summary: PerformanceAggregate }) {
  const slip = summary.slippage.combined;
  const metrics: Array<{
    label: string;
    value: string;
    sub: string;
    tone?: string;
    subTone?: string;
  }> = [
    {
      label: 'realized',
      value: formatSignedNumber(summary.grossPnl),
      sub: metricText(summary.grossReturnPercent, true),
      tone: signedTone(summary.grossPnl),
      subTone: summary.grossReturnPercent.available ? undefined : 'status-warn',
    },
    {
      label: 'round trips',
      value: String(summary.tradeCount),
      sub: `${summary.winningTrades} won · ${metricText(summary.winRatePercent, true)}`,
      subTone: summary.winRatePercent.available ? undefined : 'status-warn',
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
      // The domain keeps the drawdown as a non-negative distance. It is inked
      // red, so it is shown as the fall it was; a zero is not a fall and stays
      // in body ink (TOKENS rule 7).
      value: !summary.drawdown.amount.available
        ? 'not available'
        : summary.drawdown.amount.value > 0
          ? formatSignedNumber(-summary.drawdown.amount.value)
          : formatNumber(0),
      sub:
        summary.drawdown.peakDate && summary.drawdown.troughDate
          ? `${formatDateKey(summary.drawdown.peakDate)} → ${formatDateKey(summary.drawdown.troughDate)}`
          : 'observed gross curve',
      // A drawdown of zero is not a number that went down (TOKENS rule 7).
      tone: !summary.drawdown.amount.available
        ? 'status-warn'
        : summary.drawdown.amount.value > 0
          ? 'number-negative'
          : undefined,
    },
    {
      label: 'avg hold',
      value: summary.averageHoldDurationMs.available
        ? formatCompactDuration(summary.averageHoldDurationMs.value)
        : 'not available',
      sub: summary.medianHoldDurationMs.available
        ? `median ${formatCompactDuration(summary.medianHoldDurationMs.value)}`
        : 'no pair of acknowledgement stamps',
      tone: summary.averageHoldDurationMs.available ? undefined : 'status-warn',
      subTone: summary.medianHoldDurationMs.available ? 'muted' : 'status-warn',
    },
    {
      // SPEC 4: slip is never inked. Whether a move helped depends on the side,
      // so the reader supplies that judgement.
      label: 'slip',
      value: slip.available ? formatSlip(slip.value) : 'not available',
      sub: 'order vs fill, signed',
      tone: slip.available ? undefined : 'status-warn',
      subTone: slip.available ? 'muted' : 'status-warn',
    },
  ];
  return (
    <div className="performance-strip fading-rule">
      {metrics.map((metric) => (
        <div className="performance-stat" key={metric.label}>
          <span className="kicker">{metric.label}</span>
          <strong className={metric.tone}>{metric.value}</strong>
          <small className={metric.subTone ?? metric.tone ?? 'muted'}>{metric.sub}</small>
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
  const right = 925;
  const top = 34;
  const bottom = 180;
  const points = series.map((day, index) => ({
    x:
      series.length === 1
        ? (left + right) / 2
        : left + (index / (series.length - 1)) * (right - left),
    y: bottom - ((day.cumulativeGrossPnl - min) / span) * (bottom - top),
    day,
  }));
  // One observed day is a point, not a slope. Drawing a ramp from the left edge
  // would show a rise across days the window does not contain.
  const drawsPath = points.length > 1;
  const line = drawsPath
    ? points.map((point) => `${point.x.toFixed(1)},${point.y.toFixed(1)}`).join(' ')
    : '';
  const area = drawsPath ? `${left},${bottom} ${line} ${points.at(-1)!.x},${bottom}` : '';
  const end = points.at(-1);
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
          {end ? <circle cx={end.x} cy={end.y} r="4" className="curve-end" /> : null}
          {end ? (
            <text x={right} y="14" className="curve-end-label" textAnchor="end">
              {formatSignedNumber(end.day.cumulativeGrossPnl, 0)}
            </text>
          ) : null}
          {/* The axis names the sessions the curve actually stands on — a day
              nothing closed is not on it, so the gaps are not even spacing. */}
          {dateTicks(points.length).map((index) => {
            const point = points[index]!;
            return (
              <text
                key={point.day.date}
                x={point.x}
                y="196"
                className="curve-date"
                textAnchor={index === 0 ? 'start' : index === points.length - 1 ? 'end' : 'middle'}
              >
                {formatDateKey(point.day.date).slice(0, 5)}
              </text>
            );
          })}
        </svg>
        <div className="curve-caption">
          <span>
            {points.length === 1 ? (
              'one observed day · no curve to draw'
            ) : (
              <>
                <i /> days that gave gross P&amp;L back
              </>
            )}
          </span>
          <span>not a portfolio value — no balance history exists to draw one</span>
        </div>
      </div>
    </section>
  );
}

/**
 * At most ten dates, always including the first and the last. More than that and
 * the labels overlap, which reads as a smudge rather than an axis.
 */
function dateTicks(count: number): number[] {
  if (count === 0) return [];
  if (count <= 10) return Array.from({ length: count }, (_, index) => index);
  const step = Math.ceil((count - 1) / 9);
  const ticks: number[] = [];
  for (let index = 0; index < count - 1; index += step) ticks.push(index);
  if (ticks.at(-1) !== count - 1) ticks.push(count - 1);
  return ticks;
}

function RollupTable({
  report,
  silentBots,
}: {
  report: PerformanceReport;
  silentBots: readonly { id: string; reason: string }[];
}) {
  return (
    <section className="performance-section">
      <SectionHeading title="by bot" detail="ranked by gross realized P&L" />
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
            <th>avg hold</th>
            <th>slip</th>
            <th>retried</th>
          </tr>
        </thead>
        <tbody>
          {report.byBot.map((row) => (
            <tr key={row.botId}>
              <td>
                <strong>{row.botId}</strong>
              </td>
              <td>{row.tradeCount}</td>
              <td>
                {row.winningTrades}{' '}
                <span className="muted">· {metricText(row.winRatePercent, true)}</span>
              </td>
              <MoneyCell value={row.grossPnl} lead />
              <MetricCell metric={row.averageWinPnl} money />
              <MetricCell metric={row.averageLossPnl} money />
              <MetricCell metric={row.averageTradePnl} money />
              <HoldCell metric={row.averageHoldDurationMs} />
              <SlipCell metric={row.slippage.combined} />
              <td className="muted">{row.retriedChainCount}</td>
            </tr>
          ))}
          {/* A bot with no trip is not a zero row: it has no win rate, no
              expectancy and no slip, and averaging it in as neutral would be
              the one figure here nobody could reproduce. */}
          {silentBots.map((bot) => (
            <tr key={bot.id}>
              <td className="status-wait">{bot.id}</td>
              <td className="status-wait table-note" colSpan={9}>
                {bot.reason}
              </td>
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

interface RetryLedgerFigures {
  chainCount: number;
  wonCount: number;
  wonAmount: number;
  deadCount: number;
  worseCount: number;
  worseAmount: number;
  uncomparedCount: number;
  net: number;
}

/**
 * Follows the stored `retryOf` edge and nothing else: how many chains needed
 * another attempt, how many of them ever closed, and what the retried fills cost
 * against what the first attempt had asked for.
 */
export function summarizeRetryLedger(
  trades: readonly ClosedTrade[],
  canceled: readonly CanceledOrder[],
): RetryLedgerFigures {
  const tradeByChain = new Map<string, ClosedTrade>();
  for (const trade of trades)
    if (trade.chainId && !tradeByChain.has(trade.chainId)) tradeByChain.set(trade.chainId, trade);

  const retryChains = new Set<string>();
  for (const trade of trades)
    if (trade.chainId && (trade.openRetryOfClientOrderId || trade.closeRetryOfClientOrderId))
      retryChains.add(trade.chainId);
  for (const order of canceled)
    if (order.chainId && order.retryOfClientOrderId) retryChains.add(order.chainId);

  // The price the first attempt asked for. A market row's stored price was
  // captured at the API call and never sent, so it is not an asking price.
  const askedByClientOrderId = new Map<string, number>();
  for (const order of canceled) {
    if (!order.clientOrderId || order.type === 'market') continue;
    if (order.orderPrice === null || order.orderPrice <= 0) continue;
    askedByClientOrderId.set(order.clientOrderId, order.orderPrice);
  }

  const completed = [...retryChains].flatMap((chainId) => {
    const trade = tradeByChain.get(chainId);
    return trade ? [trade] : [];
  });
  let wonAmount = 0;
  let worseCount = 0;
  let worseAmount = 0;
  let uncomparedCount = 0;
  for (const trade of completed) {
    wonAmount += trade.quantity * (trade.averageClosePrice - trade.averageOpenPrice);
    const cost = retryFillCost(trade, askedByClientOrderId);
    if (cost === null) uncomparedCount += 1;
    else if (cost > 0) {
      worseCount += 1;
      worseAmount -= cost;
    }
  }
  return {
    chainCount: retryChains.size,
    wonCount: completed.length,
    wonAmount,
    deadCount: retryChains.size - completed.length,
    worseCount,
    worseAmount,
    uncomparedCount,
    net: wonAmount + worseAmount,
  };
}

/**
 * What the retried legs paid above what the first attempt had asked. A buy above
 * its asking price and a sell below it both cost money; `null` means the first
 * attempt is not in the loaded canceled rows, or asked no price at all.
 */
function retryFillCost(trade: ClosedTrade, asked: ReadonlyMap<string, number>): number | null {
  let cost = 0;
  let compared = false;
  const openAsked = trade.openRetryOfClientOrderId
    ? asked.get(trade.openRetryOfClientOrderId)
    : undefined;
  if (openAsked !== undefined) {
    cost += trade.quantity * (trade.averageOpenPrice - openAsked);
    compared = true;
  }
  const closeAsked = trade.closeRetryOfClientOrderId
    ? asked.get(trade.closeRetryOfClientOrderId)
    : undefined;
  if (closeAsked !== undefined) {
    cost += trade.quantity * (closeAsked - trade.averageClosePrice);
    compared = true;
  }
  return compared ? cost : null;
}

function RetryLedger({
  trades,
  canceled,
  excludedUntimed,
  accountAttributionUnavailable,
  grossRealized,
}: {
  trades: readonly ClosedTrade[];
  canceled: readonly CanceledOrder[];
  excludedUntimed: number;
  accountAttributionUnavailable: boolean;
  grossRealized: number;
}) {
  const figures = summarizeRetryLedger(trades, canceled);
  // A share only reads as one while it is inside the whole. Retrying that moved
  // more money than the window realized is stated against the figure itself.
  const share =
    grossRealized > 0 && Math.abs(figures.net) <= grossRealized
      ? `${formatPercentage((figures.net / grossRealized) * 100, 0, false)} of everything realized`
      : `against ${formatSignedNumber(grossRealized, 0)} realized in this window`;
  return (
    <article className="card elev-sm performance-card performance-card-dead">
      <div className="card-kicker status-dead">the retry ledger</div>
      <h3>
        {figures.chainCount === 0 ? (
          'No retry edge in this selected window'
        ) : (
          <>
            Retrying earned{' '}
            <span className={figures.net >= 0 ? 'status-live' : 'status-dead'}>
              {formatSignedNumber(figures.net)}
            </span>
          </>
        )}
      </h3>
      <p>
        {figures.chainCount === 0 ? (
          <>
            Retry edges come only from stored retry identifiers. They report what the policy did;
            they do not guess at orders missing from every list.
          </>
        ) : (
          <>
            {plural(figures.chainCount, 'chain')} needed another attempt — {figures.wonCount} of
            them got there, {figures.deadCount} did not. Following the{' '}
            <span className="book-inline-value">retryOf</span> edge tells you whether the policy
            paid for the orders it burned.
          </>
        )}
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
      {figures.chainCount > 0 ? (
        <>
          <div className="ledger-lines">
            <div className={`metric-line ${figures.wonCount > 0 ? 'status-live' : 'muted'}`}>
              <strong>{figures.wonCount}</strong>
              <span>eventually opened, then closed</span>
              <em className={signedTone(figures.wonAmount) ?? 'muted'}>
                {formatSignedNumber(figures.wonAmount)}
              </em>
            </div>
            {figures.worseCount > 0 ? (
              <div className="metric-line-nested">
                <i />
                <div className="metric-line status-wait">
                  <strong>{figures.worseCount}</strong>
                  <span>of those, filled worse than the first try asked</span>
                  <em className="number-negative">{formatSignedNumber(figures.worseAmount)}</em>
                </div>
              </div>
            ) : null}
            <div className={`metric-line ${figures.deadCount > 0 ? 'status-dead' : 'muted'}`}>
              <strong>{figures.deadCount}</strong>
              <span>never opened — the chain just died</span>
              <em className="muted">no cost</em>
            </div>
          </div>
          {figures.uncomparedCount > 0 ? (
            /* A first attempt that is not in the loaded canceled rows, or asked
               no price at all, is left out rather than compared against a
               price nobody sent. */
            <p className="muted">
              {figures.uncomparedCount} of the {figures.wonCount} closed chains could not be
              compared: the attempt they retry is outside the loaded canceled rows, or carried no
              price the exchange saw.
            </p>
          ) : null}
          <div className="card-total">
            <span className="kicker">total</span>
            <strong className={figures.net >= 0 ? 'status-live' : 'status-dead'}>
              {formatSignedNumber(figures.net)}
            </strong>
            <span />
            <small className="muted">{share}</small>
          </div>
        </>
      ) : null}
    </article>
  );
}

function SlippageSection({ report }: { report: PerformanceReport }) {
  const { entry, exit, exitOrderPriceMissingCount } = report.summary.slippage;
  const legs: Array<{ label: string; metric: PerformanceMetric; sub: string }> = [
    {
      label: 'entry',
      metric: entry,
      sub: `${plural(entry.sampleSize, 'opening fill')} · every buy carries an order price`,
    },
    {
      label: 'exit',
      metric: exit,
      sub:
        exitOrderPriceMissingCount > 0
          ? `${plural(exit.sampleSize, 'closing fill')} · ${exitOrderPriceMissingCount} priced no sell`
          : `${plural(exit.sampleSize, 'closing fill')} · every sell carries an order price`,
    },
  ];
  return (
    <section className="performance-section">
      <SectionHeading
        title="slippage"
        detail="order price against average fill, signed by which way the price moved"
      />
      <div className="slippage-grid">
        {legs.map((leg) => (
          <div
            className={`slippage-metric${leg.metric.available ? '' : ' slippage-metric-unavailable'}`}
            key={leg.label}
          >
            <span className="kicker">{leg.label}</span>
            {/* SPEC 4: never inked. A buy above its order price and a sell below
                it are both positive, and which one helped depends on the side. */}
            <strong className={leg.metric.available ? undefined : 'status-warn'}>
              {leg.metric.available ? formatSlip(leg.metric.value) : 'not available'}
            </strong>
            <small className="muted">{leg.sub}</small>
          </div>
        ))}
      </div>
      {/* A reason is said once, by the section that owns it. */}
      <p className="slippage-reason status-warn">
        These two do not split into limit and market: ClosedTrades stores prices but not order type,
        so the {plural(report.summary.tradeCount, 'trade')} in this window cannot be sorted across
        the four without inventing which prices were sent.
      </p>
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
            <th>bot</th>
            <th>held</th>
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

function Limitations({
  report,
  budgetContext,
}: {
  report: PerformanceReport;
  budgetContext: BudgetContext;
}) {
  const committedCopy =
    budgetContext.committedState === 'loading'
      ? 'loading current committed amount'
      : budgetContext.committedState === 'unavailable' || budgetContext.committed === null
        ? `current committed amount unavailable${
            budgetContext.completeBotsOnly ? ' \u00b7 incomplete bots have no budget read' : ''
          }`
        : `${formatNumber(budgetContext.committed, 0)} currently committed${
            budgetContext.completeBotsOnly ? ' \u00b7 complete bots only' : ''
          }`;
  return (
    <section className="limitations">
      {/* SPEC lists GetBots budget context as a Performance read. It is not a
          result, so it sits with the standing statements rather than among the
          figures the window recomputes. */}
      <article className="card">
        <div className="card-kicker">budget context</div>
        <p>
          <span className="book-inline-value">{formatNumber(budgetContext.limit, 0)}</span>{' '}
          configured across {budgetContext.scopeCopy}.{' '}
          <span className={budgetContext.committedState === 'ready' ? 'muted' : 'status-warn'}>
            {committedCopy}
          </span>
          .
        </p>
      </article>
      <article className="card">
        <div className="card-kicker">what this page cannot say</div>
        <p>
          There is no net result to give: no commission or tax field exists. Every figure above is
          gross; subtracting an invented cost would be less accurate than leaving it unavailable.
        </p>
      </article>
      <article className="card">
        <div className="card-kicker">time boundary</div>
        <p>
          Every figure here is filed by batch: the session the opening buy belongs to, the day the
          Book files the same chain under. A round trip counts in the batch its bot opened it in,
          however many sessions later it closed, so this window holds the batches that opened inside
          it and not the closes that landed there. {report.exclusions.openedAfterHoursCount} were
          written past their own session and count in the next one.{' '}
          {plural(report.exclusions.missingOpeningStampCount, 'row')} carried no opening stamp and{' '}
          {plural(report.exclusions.missingCloseAcknowledgementCount, 'row')} no close
          acknowledgement; neither can be placed in time, and both were excluded. The execute stamps
          behind hold remain acknowledgement times, not fill times.
        </p>
      </article>
      <article className="card">
        <div className="card-kicker">calendar boundary</div>
        <p>
          {report.window.calendarVerified
            ? `The holiday rows cover this range; ${
                report.window.tradingDayCount.available
                  ? plural(report.window.tradingDayCount.value, 'trading day')
                  : 'an unavailable number of trading days'
              } are represented.`
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
        ? `${plural(report.window.tradingDayCount.value, 'trading day')} · holidays applied`
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
function MoneyCell({ value, lead }: { value: number; lead?: boolean }) {
  return (
    <td className={`${signedTone(value) ?? ''}${lead ? ' table-lead' : ''}`}>
      {formatSignedNumber(value)}
    </td>
  );
}

function HoldCell({ metric }: { metric: PerformanceMetric }) {
  return (
    <td className={metric.available ? undefined : 'status-warn'}>
      {metric.available ? formatCompactDuration(metric.value) : 'not available'}
    </td>
  );
}

/** SPEC 4: slip is never inked green or red, on any page. */
function SlipCell({ metric }: { metric: PerformanceMetric }) {
  return (
    <td className={metric.available ? undefined : 'status-warn'}>
      {metric.available ? formatSlip(metric.value) : 'not available'}
    </td>
  );
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
// TOKENS rule 7: a sign is inked only where it means one thing. Zero is not up
// and not down, so it stays in body ink.
function signedTone(value: number): string | undefined {
  if (value === 0) return undefined;
  return value > 0 ? 'number-positive' : 'number-negative';
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
  calendar: HolidayCalendar,
) {
  if (mode === 'today') return { from: today, to: today };
  if (mode === 'week') return { from: shiftDate(today, -6), to: today };
  if (mode === 'range') return { from: rangeFrom, to: rangeTo };
  // `all` reaches back to the oldest batch in scope, which is the report's own unit: an
  // earliest close would leave out the batch of a trade that opened before it.
  const dates = trades
    .flatMap((trade) => {
      const batch = sessionBatchDate(trade.openOrderTime ?? trade.openExecuteTime, calendar);
      return batch === null ? [] : [batch];
    })
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
