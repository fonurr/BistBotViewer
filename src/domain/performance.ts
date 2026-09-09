import type { ClosedTrade, Holiday } from '../bistApi/types';
import type { AuctionBar, AuctionBarKey } from '../priceApi/types';
import { accountIdentityKey } from './accounts';
import {
  firstTradeInstant,
  holidayCalendar,
  istanbulDay,
  sessionBatchDate,
  type HolidayCalendar,
} from './calendar';
import { intentBarLookup, intentPriceKey, intentSlipAllowed } from './intentPrice';
import { toIstanbulDate } from './chains';

export const PERFORMANCE_WINDOW_DAYS = 90;

export type PerformanceUnavailableReason =
  | 'no-trades'
  | 'no-winning-trades'
  | 'no-losing-trades'
  | 'invalid-cost-basis'
  | 'commission-and-tax-data-not-provided'
  | 'true-fill-times-not-provided'
  | 'order-type-not-stored-on-closed-trades'
  | 'close-order-price-not-stored'
  | 'market-price-not-stored'
  | 'intent-price-not-available'
  | 'final-seen-times-incomplete'
  | 'portfolio-balance-history-not-provided'
  | 'holiday-calendar-coverage-unavailable'
  | 'no-business-days'
  | 'missing-closing-bar'
  | 'ambiguous-closing-bar'
  | 'invalid-closing-bar'
  | 'hold-capital-not-defined';

export type PerformanceMetric =
  | {
      readonly available: true;
      readonly value: number;
      readonly reason: null;
      readonly sampleSize: number;
      readonly missingCount: number;
    }
  | {
      readonly available: false;
      readonly value: null;
      readonly reason: PerformanceUnavailableReason;
      readonly sampleSize: number;
      readonly missingCount: number;
    };

export interface PerformanceTrade {
  readonly key: string;
  readonly raw: ClosedTrade;
  readonly botId: string;
  readonly accountId: string;
  readonly brokerageId: string;
  readonly accountKey: string;
  readonly symbol: string;
  /**
   * The batch this round trip belongs to: the session its opening buy could reach, read the
   * way the Book reads it, so a chain and the trade it became file under one day.
   */
  readonly businessDate: string;
  readonly dateBasis: 'opening-batch';
  readonly quantity: number;
  readonly costBasis: number;
  readonly grossPnl: number;
  readonly grossReturnPercent: PerformanceMetric;
  /**
   * Slippage read two ways per leg, both `(averagePrice - reference) / reference`
   * and both signed by the direction the price moved, never by whether it helped
   * (API.md, Slippage & unrealized P&L):
   *
   * - `*Created` is against the leg's own **order price** - what it was created
   *   with. The opening buy always carries one; the closing sell's is `null` for
   *   a priceless market sell or a manual close, and that leg then yields nothing.
   * - `*Sent` is against the **market price** the leg was decided against - the
   *   tape when the order went out. It carries no order-type guard (the fill
   *   against the tape is the real slippage of a market order) and is unavailable
   *   only where the server stored no market price for that side.
   * - `*Intent` is against the tape at the instant the leg could **first have
   *   traded**, priced from BistData's minute history. It is unavailable wherever
   *   that instant cannot be priced, and deliberately withheld on an auction
   *   print and on a leg that registered more than ten seconds late - see
   *   `domain/intentPrice`.
   */
  readonly entryCreatedSlippagePercent: PerformanceMetric;
  readonly entrySentSlippagePercent: PerformanceMetric;
  readonly entryIntentSlippagePercent: PerformanceMetric;
  readonly exitCreatedSlippagePercent: PerformanceMetric;
  readonly exitSentSlippagePercent: PerformanceMetric;
  readonly exitIntentSlippagePercent: PerformanceMetric;
  /**
   * Each side's `firstTradeInstant`, so the page knows which minutes to ask the
   * history cache for before it builds the report that consumes them.
   */
  readonly openIntentTime: number | null;
  readonly closeIntentTime: number | null;
  /**
   * Close final-seen minus open final-seen. Both stamps come from this
   * server's own clock, so the difference is a hold duration; it is never a
   * time-to-fill or a latency, which API.md rules out deriving.
   */
  readonly holdDurationMs: PerformanceMetric;
}

export interface PerformanceDay {
  readonly date: string;
  readonly calendarVerified: boolean;
  readonly tradeCount: number;
  readonly winningTrades: number;
  readonly losingTrades: number;
  readonly breakevenTrades: number;
  readonly costBasis: number;
  readonly grossPnl: number;
  readonly grossReturnPercent: PerformanceMetric;
  readonly costs: null;
  readonly netPnl: null;
  readonly cumulativeGrossPnl: number;
  readonly cumulativeNetPnl: null;
}

export interface PerformanceSlippageSummary {
  /** The six cells of the leg × reference grid the section draws. */
  readonly entryCreated: PerformanceMetric;
  readonly entrySent: PerformanceMetric;
  readonly entryIntent: PerformanceMetric;
  readonly exitCreated: PerformanceMetric;
  readonly exitSent: PerformanceMetric;
  readonly exitIntent: PerformanceMetric;
  /**
   * Both legs pooled, against the order price (`created`), the market price
   * (`sent`) and the tape at the first tradeable instant (`intent`). Each mixes
   * buy and sell directions, so it sits near zero.
   */
  readonly created: PerformanceMetric;
  readonly sent: PerformanceMetric;
  readonly intent: PerformanceMetric;
  readonly entryCreatedCount: number;
  readonly entrySentCount: number;
  readonly entryIntentCount: number;
  readonly exitCreatedCount: number;
  readonly exitSentCount: number;
  readonly exitIntentCount: number;
  /** `trades.length * 2` - the legs a full grid would have measured. */
  readonly legCount: number;
}

export interface PerformanceDrawdown {
  /** Non-negative distance from an observed cumulative-gross peak to a later daily trough. */
  readonly amount: PerformanceMetric;
  readonly percent: PerformanceMetric;
  readonly peakDate: string | null;
  readonly troughDate: string | null;
}

export interface PerformanceAggregate {
  readonly tradeCount: number;
  readonly winningTrades: number;
  readonly losingTrades: number;
  readonly breakevenTrades: number;
  readonly grossProfit: number;
  /** A negative total, or zero when the set has no losing trade. */
  readonly grossLoss: number;
  readonly grossPnl: number;
  readonly costBasis: number;
  readonly grossReturnPercent: PerformanceMetric;
  readonly costs: PerformanceMetric;
  readonly netPnl: PerformanceMetric;
  readonly winRatePercent: PerformanceMetric;
  readonly profitFactor: PerformanceMetric;
  readonly averageTradePnl: PerformanceMetric;
  readonly averageWinPnl: PerformanceMetric;
  readonly averageLossPnl: PerformanceMetric;
  readonly averageHoldDurationMs: PerformanceMetric;
  /** The middle hold, which a handful of multi-day trades cannot drag. */
  readonly medianHoldDurationMs: PerformanceMetric;
  /** Distinct chains in this set whose open or close leg carries `origin: "Retry"`. */
  readonly retriedChainCount: number;
  readonly drawdown: PerformanceDrawdown;
  readonly slippage: PerformanceSlippageSummary;
  readonly series: readonly PerformanceDay[];
}

export interface BotPerformanceRollup extends PerformanceAggregate {
  readonly botId: string;
}

export interface AccountPerformanceRollup extends PerformanceAggregate {
  readonly key: string;
  readonly accountId: string;
  readonly brokerageId: string;
}

export interface HoldComparison {
  readonly startDate: string | null;
  readonly endDate: string | null;
  readonly startClose: number | null;
  readonly endClose: number | null;
  readonly returnPercent: PerformanceMetric;
  readonly absolutePnl: PerformanceMetric;
  readonly missingDates: readonly string[];
}

export interface SymbolPerformanceRollup extends PerformanceAggregate {
  readonly symbol: string;
  readonly holdComparison: HoldComparison;
}

export interface PerformanceWindow {
  readonly days: number;
  readonly startDate: string;
  readonly endDate: string;
  readonly calendarVerified: boolean;
  readonly tradingDayCount: PerformanceMetric;
  readonly halfTradingDayCount: PerformanceMetric;
  readonly firstBusinessDate: string | null;
  readonly lastBusinessDate: string | null;
}

export interface PerformanceExclusions {
  readonly sourceTradeCount: number;
  readonly includedTradeCount: number;
  readonly beforeWindowCount: number;
  readonly futureCount: number;
  readonly missingCloseFinalSeenCount: number;
  /** Excluded: no opening stamp, so the batch it belongs to cannot be named. */
  readonly missingOpeningStampCount: number;
  /** Included: written after its own day could take an order, so it counts in the next session. */
  readonly openedAfterHoursCount: number;
  readonly calendarUnverifiedTradeCount: number;
}

export interface ClosingBarCoverage {
  readonly requiredCount: number;
  readonly presentCount: number;
  readonly missingCount: number;
  readonly invalidCount: number;
}

export interface PerformanceReport {
  readonly window: PerformanceWindow;
  readonly dateBasis: 'opening-batch';
  readonly trades: readonly PerformanceTrade[];
  readonly summary: PerformanceAggregate;
  readonly byBot: readonly BotPerformanceRollup[];
  readonly byAccount: readonly AccountPerformanceRollup[];
  readonly bySymbol: readonly SymbolPerformanceRollup[];
  readonly requiredClosingBars: readonly AuctionBarKey[];
  readonly closingBarCoverage: ClosingBarCoverage;
  readonly exclusions: PerformanceExclusions;
}

export interface BuildPerformanceReportInput {
  readonly trades: readonly ClosedTrade[];
  readonly closingBars: readonly AuctionBar[];
  readonly holidays: readonly Holiday[];
  /**
   * Epoch milliseconds: the moment the report is read. A round trip whose close
   * was seen to end after it has not happened yet and stays out, whichever
   * batches the window holds.
   */
  readonly asOf: number;
  /** Optional inclusive ISO day for UI-selected ranges; defaults to the trailing 90 days. */
  readonly startDate?: string;
  /**
   * The newest batch the window holds, defaulting to `asOf`'s own Istanbul day.
   * It bounds the batches, never the closes: a trip opened inside the window
   * and closed after it is still the window's, which is what makes this a set
   * of batches rather than a set of closes.
   */
  readonly endDate?: string;
  /**
   * Resolved intent prices, keyed `SYMBOL|ts` by `histApi`'s `intentBarKey`. The
   * page runs this report twice: once with none, to learn which instants it must
   * ask the history cache for, and again with what came back. Absent keys are
   * simply unpriced instants, which is the ordinary case.
   */
  readonly intentPrices?: ReadonlyMap<string, number>;
}

interface CalendarWindow {
  readonly verified: boolean;
  readonly businessDates: readonly string[];
  readonly halfDayCount: number | null;
}

type GroupedTrades = Map<string, PerformanceTrade[]>;

type BarLookup =
  | { readonly kind: 'present'; readonly bar: AuctionBar }
  | { readonly kind: 'missing' }
  | { readonly kind: 'ambiguous' }
  | { readonly kind: 'invalid' };

export function performanceAccountKey(brokerageId: string, accountId: string): string {
  return accountIdentityKey(accountId, brokerageId);
}

export function buildPerformanceReport(input: BuildPerformanceReportInput): PerformanceReport {
  if (!Number.isFinite(input.asOf)) {
    throw new RangeError('Performance asOf must be a finite epoch-millisecond value.');
  }

  const readDate = toIstanbulDate(input.asOf);
  if (readDate === null) {
    throw new RangeError('Performance asOf is outside the supported Date range.');
  }
  const endDate = input.endDate ?? readDate;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(endDate)) {
    throw new RangeError('Performance endDate must be a valid ISO day.');
  }
  const startDate = input.startDate ?? shiftIsoDate(endDate, -(PERFORMANCE_WINDOW_DAYS - 1));
  if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate) || startDate > endDate) {
    throw new RangeError('Performance startDate must be a valid ISO day on or before endDate.');
  }
  const windowDays = datesBetween(startDate, endDate).length;
  const fullHolidays = new Set(
    input.holidays.filter(({ type }) => type === 'full').map(({ date }) => date),
  );
  const calendar = buildCalendarWindow(startDate, endDate, input.holidays, fullHolidays);
  const calendarDays = holidayCalendar(input.holidays);
  const barsByKey = indexClosingBars(input.closingBars);
  const barSessionDates = new Set(input.closingBars.map(({ sessionDate }) => sessionDate));

  const included: PerformanceTrade[] = [];
  let beforeWindowCount = 0;
  let futureCount = 0;
  let missingCloseFinalSeenCount = 0;
  let missingOpeningStampCount = 0;
  let openedAfterHoursCount = 0;

  for (const trade of input.trades) {
    // A round trip whose close was never observed cannot be placed in time at all — neither
    // its hold nor the fact that it happened before `asOf` — so it stays out of the report.
    const closeFinalSeen = trade.closeFinalSeenTime;
    if (closeFinalSeen === null || !Number.isFinite(closeFinalSeen)) {
      missingCloseFinalSeenCount += 1;
      continue;
    }
    if (closeFinalSeen > input.asOf) {
      futureCount += 1;
      continue;
    }

    const openingStamp = firstFiniteStamp(trade.openOrderTime, trade.openFinalSeenTime);
    const businessDate = sessionBatchDate(openingStamp, calendarDays);
    if (businessDate === null) {
      missingOpeningStampCount += 1;
      continue;
    }
    if (businessDate < startDate) {
      beforeWindowCount += 1;
      continue;
    }
    if (businessDate > endDate) {
      futureCount += 1;
      continue;
    }
    if (businessDate !== istanbulDay(openingStamp!)) {
      openedAfterHoursCount += 1;
    }

    included.push(normalizePerformanceTrade(trade, businessDate, calendarDays, input.intentPrices));
  }

  included.sort(comparePerformanceTrades);

  const observedDates = uniqueSorted(included.map(({ businessDate }) => businessDate));
  const seriesDates = calendar.verified
    ? uniqueSorted([...calendar.businessDates, ...observedDates])
    : observedDates;
  const isDateVerified = (date: string): boolean => calendar.verified || barSessionDates.has(date);
  const symbols = uniqueSorted(included.map(({ symbol }) => symbol));
  const firstBusinessDate = calendar.verified ? (calendar.businessDates[0] ?? null) : null;
  const lastBusinessDate = calendar.verified ? (calendar.businessDates.at(-1) ?? null) : null;
  const requiredClosingBars = buildRequiredClosingBarKeys(
    symbols,
    firstBusinessDate,
    lastBusinessDate,
  );
  const closingBarCoverage = calculateClosingBarCoverage(requiredClosingBars, barsByKey);

  const summary = aggregatePerformance(included, seriesDates, isDateVerified);
  const byBot = [...groupTrades(included, ({ botId }) => botId)]
    .map(([botId, trades]) => ({
      botId,
      ...aggregatePerformance(trades, seriesDates, isDateVerified),
    }))
    .sort(compareRollups);
  const byAccount = [...groupTrades(included, ({ accountKey }) => accountKey)]
    .map(([key, trades]) => {
      const representative = trades[0];
      if (representative === undefined) throw new Error(`Empty account group ${key}.`);
      return {
        key,
        accountId: representative.accountId,
        brokerageId: representative.brokerageId,
        ...aggregatePerformance(trades, seriesDates, isDateVerified),
      };
    })
    .sort(compareRollups);
  const bySymbol = [...groupTrades(included, ({ symbol }) => symbol)]
    .map(([symbol, trades]) => ({
      symbol,
      ...aggregatePerformance(trades, seriesDates, isDateVerified),
      holdComparison: buildHoldComparison(
        symbol,
        calendar.verified,
        firstBusinessDate,
        lastBusinessDate,
        barsByKey,
      ),
    }))
    .sort(compareRollups);

  const calendarUnverifiedTradeCount = calendar.verified
    ? 0
    : included.filter(({ businessDate }) => !barSessionDates.has(businessDate)).length;
  const tradingDayCount = calendar.verified
    ? availableMetric(calendar.businessDates.length, calendar.businessDates.length)
    : unavailableMetric('holiday-calendar-coverage-unavailable');
  const halfTradingDayCount = calendar.verified
    ? availableMetric(calendar.halfDayCount ?? 0, calendar.businessDates.length)
    : unavailableMetric('holiday-calendar-coverage-unavailable');

  return {
    window: {
      days: windowDays,
      startDate,
      endDate,
      calendarVerified: calendar.verified,
      tradingDayCount,
      halfTradingDayCount,
      firstBusinessDate,
      lastBusinessDate,
    },
    dateBasis: 'opening-batch',
    trades: included,
    summary,
    byBot,
    byAccount,
    bySymbol,
    requiredClosingBars,
    closingBarCoverage,
    exclusions: {
      sourceTradeCount: input.trades.length,
      includedTradeCount: included.length,
      beforeWindowCount,
      futureCount,
      missingCloseFinalSeenCount,
      missingOpeningStampCount,
      openedAfterHoursCount,
      calendarUnverifiedTradeCount,
    },
  };
}

function normalizePerformanceTrade(
  trade: ClosedTrade,
  businessDate: string,
  calendarDays: HolidayCalendar,
  intentPrices: ReadonlyMap<string, number> | undefined,
): PerformanceTrade {
  const openIntentTime = firstTradeInstant(
    trade.openScheduledTime ?? trade.openCreatedTime ?? null,
    calendarDays,
  );
  const closeIntentTime = firstTradeInstant(
    trade.closeScheduledTime ?? trade.closeCreatedTime ?? null,
    calendarDays,
  );
  const costBasis = trade.quantity * trade.averageOpenPrice;
  const grossPnl = trade.quantity * (trade.averageClosePrice - trade.averageOpenPrice);
  const grossReturnPercent =
    costBasis > 0
      ? availableMetric((grossPnl / costBasis) * 100, 1)
      : unavailableMetric('invalid-cost-basis', 0, 1);
  return {
    key: `closed-trade:${trade.id}`,
    raw: trade,
    botId: trade.botId,
    accountId: trade.accountId,
    brokerageId: trade.brokerageId,
    accountKey: performanceAccountKey(trade.brokerageId, trade.accountId),
    symbol: trade.symbol,
    businessDate,
    dateBasis: 'opening-batch',
    quantity: trade.quantity,
    costBasis,
    grossPnl,
    grossReturnPercent,
    entryCreatedSlippagePercent: slipMetric(trade.openOrderPrice, trade.averageOpenPrice, 'entry'),
    entrySentSlippagePercent: marketSlipMetric(trade.openMarketPrice, trade.averageOpenPrice),
    entryIntentSlippagePercent: intentSlipMetric({
      intentTime: openIntentTime,
      orderTime: trade.openOrderTime,
      averagePrice: trade.averageOpenPrice,
      reference: trade.openMarketPrice ?? trade.averageOpenPrice,
      symbol: trade.symbol,
      calendarDays,
      intentPrices,
    }),
    exitCreatedSlippagePercent: slipMetric(trade.closeOrderPrice, trade.averageClosePrice, 'exit'),
    exitSentSlippagePercent: marketSlipMetric(trade.closeMarketPrice, trade.averageClosePrice),
    exitIntentSlippagePercent: intentSlipMetric({
      intentTime: closeIntentTime,
      orderTime: trade.closeOrderTime,
      averagePrice: trade.averageClosePrice,
      reference: trade.closeMarketPrice ?? trade.averageClosePrice,
      symbol: trade.symbol,
      calendarDays,
      intentPrices,
    }),
    openIntentTime,
    closeIntentTime,
    holdDurationMs: holdMetric(trade.openFinalSeenTime, trade.closeFinalSeenTime),
  };
}

/**
 * Order price is intent, average price is the actual fill, and the sign is the
 * direction the price moved - never whether the move helped, which depends on
 * the side (SPEC 4). An order price that is `null` or non-positive was never an
 * instruction the exchange saw, so it yields nothing rather than a zero.
 */
function slipMetric(
  orderPrice: number | null,
  averagePrice: number,
  leg: 'entry' | 'exit',
): PerformanceMetric {
  if (orderPrice === null || !Number.isFinite(orderPrice) || orderPrice <= 0) {
    return unavailableMetric(
      leg === 'exit' ? 'close-order-price-not-stored' : 'invalid-cost-basis',
      0,
      1,
    );
  }
  if (!Number.isFinite(averagePrice)) return unavailableMetric('invalid-cost-basis', 0, 1);
  return availableMetric(((averagePrice - orderPrice) / orderPrice) * 100, 1);
}

/**
 * The same figure against the market price the leg was decided against. No
 * order-type guard - the fill against the decision-time tape is the real
 * slippage of a market order - so the only thing that withholds it is the
 * server having stored no market price for that side (a sale made outside this
 * server, or a row written before the field existed).
 */
function marketSlipMetric(
  marketPrice: number | null | undefined,
  averagePrice: number,
): PerformanceMetric {
  if (
    marketPrice === null ||
    marketPrice === undefined ||
    !Number.isFinite(marketPrice) ||
    marketPrice <= 0
  ) {
    return unavailableMetric('market-price-not-stored', 0, 1);
  }
  if (!Number.isFinite(averagePrice)) return unavailableMetric('invalid-cost-basis', 0, 1);
  return availableMetric(((averagePrice - marketPrice) / marketPrice) * 100, 1);
}

/**
 * The same figure against the tape at the leg's first tradeable instant. It is
 * unavailable far more often than the other two, and for reasons that are all
 * deliberate: an instant carrying seconds names no minute, an auction print is a
 * match rather than a working price, a leg that registered more than ten seconds
 * late was not competing for that price, and the nightly cache may simply not
 * hold the minute. `domain/intentPrice` owns every one of those rules.
 */
function intentSlipMetric(options: {
  intentTime: number | null;
  orderTime: number | null;
  averagePrice: number;
  reference: number | null;
  symbol: string;
  calendarDays: HolidayCalendar;
  intentPrices: ReadonlyMap<string, number> | undefined;
}): PerformanceMetric {
  const unavailable = unavailableMetric('intent-price-not-available', 0, 1);
  if (options.intentTime === null || !Number.isFinite(options.averagePrice)) return unavailable;
  const lookup = intentBarLookup(options.intentTime, options.calendarDays);
  if (!lookup) return unavailable;
  if (!intentSlipAllowed(lookup, options.intentTime, options.orderTime)) return unavailable;
  const price = options.intentPrices?.get(intentPriceKey(options.symbol, lookup.ts));
  if (price === undefined) return unavailable;
  // The page resolves a bar's own field and applies the scale guard before it
  // hands the price over, so what arrives here is already a price to stand behind.
  if (!Number.isFinite(price) || price <= 0) return unavailable;
  return availableMetric(((options.averagePrice - price) / price) * 100, 1);
}

function holdMetric(
  openFinalSeenTime: number | null,
  closeFinalSeenTime: number | null,
): PerformanceMetric {
  if (
    openFinalSeenTime === null ||
    closeFinalSeenTime === null ||
    closeFinalSeenTime < openFinalSeenTime
  ) {
    return unavailableMetric('final-seen-times-incomplete', 0, 1);
  }
  return availableMetric(closeFinalSeenTime - openFinalSeenTime, 1);
}

function aggregatePerformance(
  trades: readonly PerformanceTrade[],
  seriesDates: readonly string[],
  isDateVerified: (date: string) => boolean,
): PerformanceAggregate {
  const winning = trades.filter(({ grossPnl }) => grossPnl > 0);
  const losing = trades.filter(({ grossPnl }) => grossPnl < 0);
  const breakevenTrades = trades.length - winning.length - losing.length;
  const grossProfit = sum(winning.map(({ grossPnl }) => grossPnl));
  const grossLoss = sum(losing.map(({ grossPnl }) => grossPnl));
  const grossPnl = grossProfit + grossLoss;
  const costBasis = sum(trades.map((trade) => trade.costBasis));
  const series = trades.length === 0 ? [] : buildDailySeries(trades, seriesDates, isDateVerified);
  const drawdown = calculateDrawdown(series, trades.length);
  const holds = availableValues(trades.map((trade) => trade.holdDurationMs));

  return {
    tradeCount: trades.length,
    winningTrades: winning.length,
    losingTrades: losing.length,
    breakevenTrades,
    grossProfit,
    grossLoss,
    grossPnl,
    costBasis,
    grossReturnPercent:
      trades.length === 0
        ? unavailableMetric('no-trades')
        : costBasis > 0
          ? availableMetric((grossPnl / costBasis) * 100, trades.length)
          : unavailableMetric('invalid-cost-basis', 0, trades.length),
    costs: unavailableMetric('commission-and-tax-data-not-provided', 0, trades.length),
    netPnl: unavailableMetric('commission-and-tax-data-not-provided', 0, trades.length),
    winRatePercent:
      trades.length === 0
        ? unavailableMetric('no-trades')
        : availableMetric((winning.length / trades.length) * 100, trades.length),
    profitFactor:
      trades.length === 0
        ? unavailableMetric('no-trades')
        : losing.length === 0
          ? unavailableMetric('no-losing-trades', winning.length)
          : availableMetric(grossProfit / Math.abs(grossLoss), trades.length),
    averageTradePnl:
      trades.length === 0
        ? unavailableMetric('no-trades')
        : availableMetric(grossPnl / trades.length, trades.length),
    averageWinPnl:
      winning.length === 0
        ? unavailableMetric('no-winning-trades')
        : availableMetric(grossProfit / winning.length, winning.length),
    averageLossPnl:
      losing.length === 0
        ? unavailableMetric('no-losing-trades')
        : availableMetric(grossLoss / losing.length, losing.length),
    averageHoldDurationMs: meanMetric(holds, trades.length, 'final-seen-times-incomplete'),
    medianHoldDurationMs: medianMetric(holds, trades.length, 'final-seen-times-incomplete'),
    retriedChainCount: countRetriedChains(trades),
    drawdown,
    slippage: summarizeSlippage(trades),
    series,
  };
}

function buildDailySeries(
  trades: readonly PerformanceTrade[],
  dates: readonly string[],
  isDateVerified: (date: string) => boolean,
): PerformanceDay[] {
  const byDate = groupTrades(trades, ({ businessDate }) => businessDate);
  const effectiveDates = dates.length > 0 ? dates : uniqueSorted([...byDate.keys()]);
  let cumulativeGrossPnl = 0;

  return effectiveDates.map((date) => {
    const dailyTrades = byDate.get(date) ?? [];
    const winningTrades = dailyTrades.filter(({ grossPnl }) => grossPnl > 0).length;
    const losingTrades = dailyTrades.filter(({ grossPnl }) => grossPnl < 0).length;
    const costBasis = sum(dailyTrades.map((trade) => trade.costBasis));
    const grossPnl = sum(dailyTrades.map((trade) => trade.grossPnl));
    cumulativeGrossPnl += grossPnl;

    return {
      date,
      calendarVerified: isDateVerified(date),
      tradeCount: dailyTrades.length,
      winningTrades,
      losingTrades,
      breakevenTrades: dailyTrades.length - winningTrades - losingTrades,
      costBasis,
      grossPnl,
      grossReturnPercent:
        dailyTrades.length === 0
          ? unavailableMetric('no-trades')
          : costBasis > 0
            ? availableMetric((grossPnl / costBasis) * 100, dailyTrades.length)
            : unavailableMetric('invalid-cost-basis', 0, dailyTrades.length),
      costs: null,
      netPnl: null,
      cumulativeGrossPnl,
      cumulativeNetPnl: null,
    };
  });
}

function calculateDrawdown(
  series: readonly PerformanceDay[],
  tradeCount: number,
): PerformanceDrawdown {
  if (tradeCount === 0) {
    return {
      amount: unavailableMetric('no-trades'),
      percent: unavailableMetric('portfolio-balance-history-not-provided'),
      peakDate: null,
      troughDate: null,
    };
  }

  let peak = 0;
  let peakDate: string | null = null;
  let maxDrawdown = 0;
  let maxPeakDate: string | null = null;
  let troughDate: string | null = null;

  for (const day of series) {
    if (day.cumulativeGrossPnl > peak) {
      peak = day.cumulativeGrossPnl;
      peakDate = day.date;
    }
    const drawdown = peak - day.cumulativeGrossPnl;
    if (drawdown > maxDrawdown) {
      maxDrawdown = drawdown;
      maxPeakDate = peakDate;
      troughDate = day.date;
    }
  }

  return {
    amount: availableMetric(maxDrawdown, tradeCount),
    percent: unavailableMetric('portfolio-balance-history-not-provided', 0, tradeCount),
    peakDate: maxPeakDate,
    troughDate,
  };
}

function summarizeSlippage(trades: readonly PerformanceTrade[]): PerformanceSlippageSummary {
  const entryCreated = availableValues(trades.map((trade) => trade.entryCreatedSlippagePercent));
  const entrySent = availableValues(trades.map((trade) => trade.entrySentSlippagePercent));
  const entryIntent = availableValues(trades.map((trade) => trade.entryIntentSlippagePercent));
  const exitCreated = availableValues(trades.map((trade) => trade.exitCreatedSlippagePercent));
  const exitSent = availableValues(trades.map((trade) => trade.exitSentSlippagePercent));
  const exitIntent = availableValues(trades.map((trade) => trade.exitIntentSlippagePercent));
  const legCount = trades.length * 2;

  return {
    entryCreated: meanMetric(entryCreated, trades.length, 'invalid-cost-basis'),
    entrySent: meanMetric(entrySent, trades.length, 'market-price-not-stored'),
    entryIntent: meanMetric(entryIntent, trades.length, 'intent-price-not-available'),
    exitCreated: meanMetric(exitCreated, trades.length, 'close-order-price-not-stored'),
    exitSent: meanMetric(exitSent, trades.length, 'market-price-not-stored'),
    exitIntent: meanMetric(exitIntent, trades.length, 'intent-price-not-available'),
    created: meanMetric(
      [...entryCreated, ...exitCreated],
      legCount,
      'close-order-price-not-stored',
    ),
    sent: meanMetric([...entrySent, ...exitSent], legCount, 'market-price-not-stored'),
    intent: meanMetric([...entryIntent, ...exitIntent], legCount, 'intent-price-not-available'),
    entryCreatedCount: entryCreated.length,
    entrySentCount: entrySent.length,
    entryIntentCount: entryIntent.length,
    exitCreatedCount: exitCreated.length,
    exitSentCount: exitSent.length,
    exitIntentCount: exitIntent.length,
    legCount,
  };
}

/**
 * A retry is a stored `origin` on one of the round trip's two sides and nothing
 * else. An order missing from every list is not evidence of one, so it is never
 * inferred.
 */
function countRetriedChains(trades: readonly PerformanceTrade[]): number {
  const chains = new Set<string>();
  for (const { raw } of trades) {
    if (!raw.chainId) continue;
    if (raw.openOrigin === 'Retry' || raw.closeOrigin === 'Retry') chains.add(raw.chainId);
  }
  return chains.size;
}

function availableValues(metrics: readonly PerformanceMetric[]): number[] {
  return metrics.flatMap((metric) => (metric.available ? [metric.value] : []));
}

function meanMetric(
  values: readonly number[],
  population: number,
  reason: PerformanceUnavailableReason,
): PerformanceMetric {
  if (values.length === 0) return unavailableMetric(reason, 0, population);
  return availableMetric(sum(values) / values.length, values.length, population - values.length);
}

function medianMetric(
  values: readonly number[],
  population: number,
  reason: PerformanceUnavailableReason,
): PerformanceMetric {
  if (values.length === 0) return unavailableMetric(reason, 0, population);
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  const value =
    sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
  return availableMetric(value, values.length, population - values.length);
}

function buildHoldComparison(
  symbol: string,
  calendarVerified: boolean,
  startDate: string | null,
  endDate: string | null,
  barsByKey: ReadonlyMap<string, BarLookup>,
): HoldComparison {
  const unavailableAbsolute = unavailableMetric('hold-capital-not-defined');

  if (!calendarVerified) {
    return {
      startDate: null,
      endDate: null,
      startClose: null,
      endClose: null,
      returnPercent: unavailableMetric('holiday-calendar-coverage-unavailable'),
      absolutePnl: unavailableAbsolute,
      missingDates: [],
    };
  }
  if (startDate === null || endDate === null) {
    return {
      startDate,
      endDate,
      startClose: null,
      endClose: null,
      returnPercent: unavailableMetric('no-business-days'),
      absolutePnl: unavailableAbsolute,
      missingDates: [],
    };
  }

  const start = barsByKey.get(barKey(symbol, startDate)) ?? {
    kind: 'missing' as const,
  };
  const end = barsByKey.get(barKey(symbol, endDate)) ?? {
    kind: 'missing' as const,
  };
  const missingDates = [
    ...(start.kind === 'missing' ? [startDate] : []),
    ...(end.kind === 'missing' && endDate !== startDate ? [endDate] : []),
  ];
  const unavailableReason = holdBarUnavailableReason(start, end);

  if (unavailableReason !== null) {
    return {
      startDate,
      endDate,
      startClose: start.kind === 'present' ? start.bar.close : null,
      endClose: end.kind === 'present' ? end.bar.close : null,
      returnPercent: unavailableMetric(unavailableReason, 0, missingDates.length),
      absolutePnl: unavailableAbsolute,
      missingDates,
    };
  }

  const startClose = start.kind === 'present' ? start.bar.close : null;
  const endClose = end.kind === 'present' ? end.bar.close : null;
  if (startClose === null || endClose === null) {
    throw new Error('A present hold boundary lost its closing price.');
  }

  return {
    startDate,
    endDate,
    startClose,
    endClose,
    returnPercent: availableMetric(((endClose - startClose) / startClose) * 100, 2),
    absolutePnl: unavailableAbsolute,
    missingDates: [],
  };
}

function holdBarUnavailableReason(
  start: BarLookup,
  end: BarLookup,
): PerformanceUnavailableReason | null {
  if (start.kind === 'ambiguous' || end.kind === 'ambiguous') {
    return 'ambiguous-closing-bar';
  }
  if (start.kind === 'invalid' || end.kind === 'invalid') return 'invalid-closing-bar';
  if (start.kind === 'missing' || end.kind === 'missing') return 'missing-closing-bar';
  return null;
}

function buildCalendarWindow(
  startDate: string,
  endDate: string,
  holidays: readonly Holiday[],
  fullHolidays: ReadonlySet<string>,
): CalendarWindow {
  const sortedHolidays = [...holidays].sort((left, right) => compareText(left.date, right.date));
  const firstKnownDate = sortedHolidays[0]?.date;
  const lastKnownDate = sortedHolidays.at(-1)?.date;
  const verified =
    firstKnownDate !== undefined &&
    lastKnownDate !== undefined &&
    startDate >= firstKnownDate &&
    endDate <= lastKnownDate;

  if (!verified) return { verified: false, businessDates: [], halfDayCount: null };

  const halfHolidays = new Set(
    holidays.filter(({ type }) => type === 'half').map(({ date }) => date),
  );
  const businessDates = datesBetween(startDate, endDate).filter(
    (date) => !isWeekend(date) && !fullHolidays.has(date),
  );

  return {
    verified: true,
    businessDates,
    halfDayCount: businessDates.filter((date) => halfHolidays.has(date)).length,
  };
}

function buildRequiredClosingBarKeys(
  symbols: readonly string[],
  firstBusinessDate: string | null,
  lastBusinessDate: string | null,
): AuctionBarKey[] {
  if (firstBusinessDate === null || lastBusinessDate === null) return [];

  const dates =
    firstBusinessDate === lastBusinessDate
      ? [firstBusinessDate]
      : [firstBusinessDate, lastBusinessDate];
  return symbols.flatMap((symbol) =>
    dates.map((sessionDate) => ({ symbol: symbol.toUpperCase(), sessionDate })),
  );
}

function calculateClosingBarCoverage(
  required: readonly AuctionBarKey[],
  barsByKey: ReadonlyMap<string, BarLookup>,
): ClosingBarCoverage {
  let presentCount = 0;
  let missingCount = 0;
  let invalidCount = 0;

  for (const key of required) {
    const result = barsByKey.get(barKey(key.symbol, key.sessionDate));
    if (result?.kind === 'present') presentCount += 1;
    else if (result === undefined || result.kind === 'missing') missingCount += 1;
    else invalidCount += 1;
  }

  return {
    requiredCount: required.length,
    presentCount,
    missingCount,
    invalidCount,
  };
}

function indexClosingBars(bars: readonly AuctionBar[]): Map<string, BarLookup> {
  const grouped = new Map<string, AuctionBar[]>();
  for (const bar of bars) {
    const key = barKey(bar.symbol, bar.sessionDate);
    const rows = grouped.get(key) ?? [];
    rows.push(bar);
    grouped.set(key, rows);
  }

  const indexed = new Map<string, BarLookup>();
  for (const [key, rows] of grouped) {
    const valid = rows.filter(({ close }) => Number.isFinite(close) && close > 0);
    if (valid.length !== rows.length || valid.length === 0) {
      indexed.set(key, { kind: 'invalid' });
      continue;
    }
    const distinctCloses = new Set(valid.map(({ close }) => close));
    if (distinctCloses.size > 1) {
      indexed.set(key, { kind: 'ambiguous' });
      continue;
    }
    const newest = [...valid].sort((left, right) => right.barTs - left.barTs)[0];
    if (newest === undefined) {
      indexed.set(key, { kind: 'invalid' });
      continue;
    }
    indexed.set(key, { kind: 'present', bar: newest });
  }
  return indexed;
}

function groupTrades(
  trades: readonly PerformanceTrade[],
  keyOf: (trade: PerformanceTrade) => string,
): GroupedTrades {
  const groups: GroupedTrades = new Map();
  for (const trade of trades) {
    const key = keyOf(trade);
    const group = groups.get(key) ?? [];
    group.push(trade);
    groups.set(key, group);
  }
  return groups;
}

function comparePerformanceTrades(left: PerformanceTrade, right: PerformanceTrade): number {
  const dateComparison = compareText(left.businessDate, right.businessDate);
  if (dateComparison !== 0) return dateComparison;
  return compareText(left.key, right.key);
}

function compareRollups(
  left: PerformanceAggregate & Record<string, unknown>,
  right: PerformanceAggregate & Record<string, unknown>,
): number {
  if (left.grossPnl !== right.grossPnl) return right.grossPnl - left.grossPnl;
  return compareText(rollupIdentity(left), rollupIdentity(right));
}

function rollupIdentity(rollup: Record<string, unknown>): string {
  if (typeof rollup.botId === 'string') return rollup.botId;
  if (typeof rollup.symbol === 'string') return rollup.symbol;
  if (typeof rollup.key === 'string') return rollup.key;
  return '';
}

function availableMetric(value: number, sampleSize: number, missingCount = 0): PerformanceMetric {
  return { available: true, value, reason: null, sampleSize, missingCount };
}

function unavailableMetric(
  reason: PerformanceUnavailableReason,
  sampleSize = 0,
  missingCount = 0,
): PerformanceMetric {
  return { available: false, value: null, reason, sampleSize, missingCount };
}

function datesBetween(startDate: string, endDate: string): string[] {
  const dates: string[] = [];
  const start = Date.parse(`${startDate}T00:00:00Z`);
  const end = Date.parse(`${endDate}T00:00:00Z`);
  for (let timestamp = start; timestamp <= end; timestamp += 86_400_000) {
    dates.push(new Date(timestamp).toISOString().slice(0, 10));
  }
  return dates;
}

function shiftIsoDate(date: string, days: number): string {
  const timestamp = Date.parse(`${date}T00:00:00Z`) + days * 86_400_000;
  return new Date(timestamp).toISOString().slice(0, 10);
}

/** The first stamp the record actually carries, or null when it carries none. */
function firstFiniteStamp(...stamps: readonly (number | null)[]): number | null {
  return stamps.find((stamp): stamp is number => stamp !== null && Number.isFinite(stamp)) ?? null;
}

function isWeekend(date: string): boolean {
  const day = new Date(`${date}T00:00:00Z`).getUTCDay();
  return day === 0 || day === 6;
}

function barKey(symbol: string, sessionDate: string): string {
  return `${symbol.toUpperCase()}|${sessionDate}`;
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort(compareText);
}

function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
