import { describe, expect, it } from 'vitest';

import type { ClosedTrade, Holiday } from '../bistApi/types';
import type { AuctionBar } from '../priceApi/types';
import { buildPerformanceReport, performanceAccountKey } from './performance';

const at = (iso: string): number => Date.parse(iso);

function trade(overrides: Partial<ClosedTrade> = {}): ClosedTrade {
  return {
    id: 1,
    botId: 'bot-a',
    accountId: 'account-1',
    brokerageId: 'broker-1',
    clientOpenOrderId: 'buy-1',
    matriksOpenOrderId: 'mx-open-1',
    matriksOpenOrderId2: null,
    clientCloseOrderId: 'sell-1',
    matriksCloseOrderId: 'mx-close-1',
    matriksCloseOrderId2: null,
    positionId: 'position-1',
    symbol: 'THYAO',
    openOrderTime: at('2026-08-20T07:00:00.000Z'),
    openExecuteTime: at('2026-08-20T07:01:00.000Z'),
    closeOrderTime: at('2026-08-24T12:00:00.000Z'),
    closeExecuteTime: at('2026-08-24T12:01:00.000Z'),
    quantity: 10,
    averageOpenPrice: 100,
    averageClosePrice: 110,
    openOrderPrice: 99,
    closeOrderPrice: 111,
    chainId: 'buy-1',
    openRetryOfClientOrderId: null,
    closeRetryOfClientOrderId: null,
    ...overrides,
  };
}

function bar(symbol: string, sessionDate: string, close: number, barTs = 1): AuctionBar {
  return { symbol, sessionDate, close, volume: 0, barTs };
}

const calendarCoverage: Holiday[] = [
  { date: '2026-01-01', type: 'full' },
  { date: '2026-10-29', type: 'full' },
];

function report(options: {
  trades?: ClosedTrade[];
  closingBars?: AuctionBar[];
  holidays?: Holiday[];
  asOf?: number;
}) {
  return buildPerformanceReport({
    trades: options.trades ?? [],
    closingBars: options.closingBars ?? [],
    holidays: options.holidays ?? calendarCoverage,
    asOf: options.asOf ?? at('2026-08-25T12:00:00.000Z'),
  });
}

describe('buildPerformanceReport', () => {
  it('builds an inclusive trailing 90-day series on the batch each trade opened into', () => {
    const istanbulNextDay = trade({
      id: 1,
      openOrderTime: at('2026-08-24T21:30:00.000Z'),
      closeExecuteTime: at('2026-08-25T11:00:00.000Z'),
    });
    const firstWindowDay = trade({
      id: 2,
      openOrderTime: at('2026-05-28T08:00:00.000Z'),
      openExecuteTime: at('2026-05-28T08:01:00.000Z'),
      averageClosePrice: 105,
    });
    const tooOld = trade({
      id: 3,
      openOrderTime: at('2026-05-27T08:00:00.000Z'),
    });
    const future = trade({
      id: 4,
      closeExecuteTime: at('2026-08-25T13:00:00.000Z'),
    });
    const missingDate = trade({ id: 5, closeExecuteTime: null });
    const missingOpeningStamp = trade({ id: 6, openOrderTime: null, openExecuteTime: null });
    // Written on a Saturday, so its batch is the Monday it could first reach.
    const weekendOpening = trade({
      id: 7,
      openOrderTime: at('2026-08-22T09:00:00.000Z'),
    });
    // Written on a Thursday evening, past the last minute the exchange takes an order.
    const afterHoursOpening = trade({
      id: 8,
      openOrderTime: at('2026-08-20T18:30:00.000Z'),
    });

    const result = report({
      trades: [
        future,
        tooOld,
        missingDate,
        missingOpeningStamp,
        istanbulNextDay,
        weekendOpening,
        afterHoursOpening,
        firstWindowDay,
      ],
    });

    expect(result.window).toMatchObject({
      days: 90,
      startDate: '2026-05-28',
      endDate: '2026-08-25',
      calendarVerified: true,
    });
    expect(result.dateBasis).toBe('opening-batch');
    expect(result.trades.map(({ key, businessDate }) => [key, businessDate])).toEqual([
      ['closed-trade:2', '2026-05-28'],
      ['closed-trade:8', '2026-08-21'],
      ['closed-trade:7', '2026-08-24'],
      ['closed-trade:1', '2026-08-25'],
    ]);
    expect(result.exclusions).toMatchObject({
      missingOpeningStampCount: 1,
      missingCloseAcknowledgementCount: 1,
      beforeWindowCount: 1,
      futureCount: 1,
      openedAfterHoursCount: 2,
    });
    // The Saturday opening is counted in Monday's session, and Saturday holds nothing.
    expect(result.summary.series.find(({ date }) => date === '2026-08-22')).toBeUndefined();
    expect(result.summary.series.find(({ date }) => date === '2026-08-24')).toMatchObject({
      tradeCount: 1,
      grossPnl: 100,
    });
    expect(result.summary.series.find(({ date }) => date === '2026-08-25')).toMatchObject({
      tradeCount: 1,
      grossPnl: 100,
      calendarVerified: true,
    });
    expect(result.exclusions).toMatchObject({
      sourceTradeCount: 8,
      includedTradeCount: 4,
    });
  });

  it('rolls exact gross arithmetic up by bot and brokerage/account', () => {
    const result = report({
      trades: [
        trade({ id: 1, botId: 'bot-a', averageClosePrice: 110 }),
        trade({
          id: 2,
          botId: 'bot-a',
          accountId: 'account-2',
          averageClosePrice: 95,
        }),
        trade({
          id: 3,
          botId: 'bot-b',
          accountId: 'account-1',
          brokerageId: 'broker-2',
          averageClosePrice: 100,
        }),
      ],
    });

    expect(result.summary).toMatchObject({
      tradeCount: 3,
      winningTrades: 1,
      losingTrades: 1,
      breakevenTrades: 1,
      grossProfit: 100,
      grossLoss: -50,
      grossPnl: 50,
      costBasis: 3000,
    });
    expect(result.summary.grossReturnPercent.value).toBeCloseTo((50 / 3000) * 100);
    expect(result.summary.winRatePercent.value).toBeCloseTo(100 / 3);
    expect(result.summary.profitFactor).toMatchObject({
      available: true,
      value: 2,
    });
    expect(result.byBot.map(({ botId, grossPnl }) => [botId, grossPnl])).toEqual([
      ['bot-a', 50],
      ['bot-b', 0],
    ]);
    expect(result.byAccount.map(({ key }) => key)).toEqual([
      performanceAccountKey('broker-1', 'account-1'),
      performanceAccountKey('broker-2', 'account-1'),
      performanceAccountKey('broker-1', 'account-2'),
    ]);
  });

  it('keeps costs, net P&L, and drawdown percentage unavailable', () => {
    const result = report({ trades: [trade()] });

    expect(result.summary.costs).toEqual({
      available: false,
      value: null,
      reason: 'commission-and-tax-data-not-provided',
      sampleSize: 0,
      missingCount: 1,
    });
    expect(result.summary.netPnl).toMatchObject({
      available: false,
      value: null,
      reason: 'commission-and-tax-data-not-provided',
    });
    expect(result.summary.drawdown.percent).toMatchObject({
      available: false,
      value: null,
      reason: 'portfolio-balance-history-not-provided',
    });
    expect(
      result.summary.series.every(({ costs, netPnl }) => costs === null && netPnl === null),
    ).toBe(true);
  });

  it('calculates maximum drawdown from the observable daily gross curve', () => {
    const result = report({
      trades: [
        trade({
          id: 1,
          openOrderTime: at('2026-08-20T07:00:00.000Z'),
          averageClosePrice: 110,
        }),
        trade({
          id: 2,
          openOrderTime: at('2026-08-21T07:00:00.000Z'),
          averageClosePrice: 96,
        }),
        trade({
          id: 3,
          openOrderTime: at('2026-08-24T07:00:00.000Z'),
          averageClosePrice: 92,
        }),
      ],
    });

    expect(
      result.summary.series
        .filter(({ tradeCount }) => tradeCount > 0)
        .map(({ date, grossPnl, cumulativeGrossPnl }) => [date, grossPnl, cumulativeGrossPnl]),
    ).toEqual([
      ['2026-08-20', 100, 100],
      ['2026-08-21', -40, 60],
      ['2026-08-24', -80, -20],
    ]);
    expect(result.summary.drawdown).toMatchObject({
      amount: { available: true, value: 120 },
      peakDate: '2026-08-20',
      troughDate: '2026-08-24',
    });
  });

  it('signs slippage by price direction and leaves a priceless sell out of it', () => {
    const result = report({
      trades: [
        trade({ id: 1, openOrderPrice: 99, closeOrderPrice: 111 }),
        trade({ id: 2, openOrderPrice: 101, closeOrderPrice: null }),
      ],
    });

    // A buy filled above its order price is positive and a sell filled below its
    // own is negative; neither sign says whether the move helped.
    expect(result.trades[0]?.entrySlippagePercent.value).toBeCloseTo(1.0101, 4);
    expect(result.trades[0]?.exitSlippagePercent.value).toBeCloseTo(-0.9009, 4);
    expect(result.trades[1]?.entrySlippagePercent.value).toBeCloseTo(-0.9901, 4);
    expect(result.trades[1]?.exitSlippagePercent).toMatchObject({
      available: false,
      value: null,
      reason: 'close-order-price-not-stored',
    });

    expect(result.summary.slippage.entry.value).toBeCloseTo(0.01, 4);
    expect(result.summary.slippage.exit.value).toBeCloseTo(-0.9009, 4);
    expect(result.summary.slippage).toMatchObject({
      entryOrderPricePresentCount: 2,
      exitOrderPricePresentCount: 1,
      exitOrderPriceMissingCount: 1,
    });
  });

  it('holds a round trip between its two acknowledgement stamps, never a latency', () => {
    const result = report({
      trades: [
        trade({ id: 1 }),
        trade({
          id: 2,
          openExecuteTime: at('2026-08-24T09:00:00.000Z'),
          closeExecuteTime: at('2026-08-24T11:00:00.000Z'),
        }),
        trade({ id: 3, openExecuteTime: null }),
      ],
    });

    const holds = result.trades.map(({ holdDurationMs }) => holdDurationMs.value);
    expect(holds).toContain(2 * 60 * 60 * 1000);
    expect(holds).toContain(null);
    // The unpaired row is excluded from the average, never averaged in as zero.
    expect(result.summary.averageHoldDurationMs).toMatchObject({
      available: true,
      sampleSize: 2,
      missingCount: 1,
    });
    expect(result.summary.medianHoldDurationMs.available).toBe(true);
  });

  it('counts a retried chain once, from its stored retry identifier alone', () => {
    const result = report({
      trades: [
        trade({ id: 1, chainId: 'chain-a', openRetryOfClientOrderId: 'buy-0' }),
        trade({ id: 2, chainId: 'chain-a', closeRetryOfClientOrderId: 'sell-0' }),
        trade({ id: 3, chainId: 'chain-b' }),
      ],
    });

    expect(result.summary.retriedChainCount).toBe(1);
  });

  it('uses exact window boundary bars for hold return and counts gaps instead of zeroing them', () => {
    const trades = [trade({ symbol: 'THYAO' }), trade({ id: 2, symbol: 'GARAN' })];
    const closingBars = [
      bar('THYAO', '2026-05-28', 100),
      bar('THYAO', '2026-08-25', 120),
      bar('GARAN', '2026-05-28', 50),
    ];
    const result = report({ trades, closingBars });

    expect(result.requiredClosingBars).toEqual([
      { symbol: 'GARAN', sessionDate: '2026-05-28' },
      { symbol: 'GARAN', sessionDate: '2026-08-25' },
      { symbol: 'THYAO', sessionDate: '2026-05-28' },
      { symbol: 'THYAO', sessionDate: '2026-08-25' },
    ]);
    expect(result.closingBarCoverage).toEqual({
      requiredCount: 4,
      presentCount: 3,
      missingCount: 1,
      invalidCount: 0,
    });
    const thyao = result.bySymbol.find(({ symbol }) => symbol === 'THYAO');
    expect(thyao?.holdComparison).toMatchObject({
      startClose: 100,
      endClose: 120,
      returnPercent: { available: true, value: 20 },
      absolutePnl: {
        available: false,
        value: null,
        reason: 'hold-capital-not-defined',
      },
      missingDates: [],
    });
    const garan = result.bySymbol.find(({ symbol }) => symbol === 'GARAN');
    expect(garan?.holdComparison).toMatchObject({
      returnPercent: {
        available: false,
        value: null,
        reason: 'missing-closing-bar',
      },
      missingDates: ['2026-08-25'],
    });
  });

  it('does not infer session counts or hold boundaries from an uncovered holiday calendar', () => {
    const result = report({
      trades: [trade()],
      holidays: [],
      closingBars: [bar('THYAO', '2026-05-28', 100), bar('THYAO', '2026-08-25', 120)],
    });

    expect(result.window).toMatchObject({
      calendarVerified: false,
      firstBusinessDate: null,
      lastBusinessDate: null,
      tradingDayCount: {
        available: false,
        value: null,
        reason: 'holiday-calendar-coverage-unavailable',
      },
    });
    expect(result.requiredClosingBars).toEqual([]);
    expect(result.bySymbol[0]?.holdComparison.returnPercent).toMatchObject({
      available: false,
      value: null,
      reason: 'holiday-calendar-coverage-unavailable',
    });
  });

  it('carries an opening on a full holiday into the next session and counts the half session', () => {
    const baseline = report({ trades: [] });
    const holidays: Holiday[] = [
      calendarCoverage[0]!,
      { date: '2026-08-24', type: 'full' },
      { date: '2026-08-25', type: 'half' },
      calendarCoverage[1]!,
    ];
    const result = report({
      holidays,
      trades: [
        // Written while the exchange was shut for the day, so it belongs to the half day after.
        trade({
          id: 1,
          openOrderTime: at('2026-08-24T10:00:00.000Z'),
          closeExecuteTime: at('2026-08-25T11:00:00.000Z'),
        }),
        // Written inside the half day's own session.
        trade({
          id: 2,
          openOrderTime: at('2026-08-25T06:30:00.000Z'),
          closeExecuteTime: at('2026-08-25T11:00:00.000Z'),
        }),
      ],
    });

    expect(result.window.tradingDayCount.value).toBe(
      (baseline.window.tradingDayCount.value ?? 0) - 1,
    );
    expect(result.window.halfTradingDayCount).toMatchObject({
      available: true,
      value: 1,
    });
    expect(result.trades.map(({ key, businessDate }) => [key, businessDate])).toEqual([
      ['closed-trade:1', '2026-08-25'],
      ['closed-trade:2', '2026-08-25'],
    ]);
    expect(result.summary.tradeCount).toBe(2);
    expect(result.exclusions.openedAfterHoursCount).toBe(1);
  });

  it('returns null ratio metrics rather than decorative zeroes for an empty report', () => {
    const result = report({ trades: [] });

    expect(result.summary.tradeCount).toBe(0);
    expect(result.summary.series).toEqual([]);
    expect(result.summary.grossPnl).toBe(0);
    expect(result.summary.winRatePercent).toMatchObject({
      available: false,
      value: null,
      reason: 'no-trades',
    });
    expect(result.summary.profitFactor.value).toBeNull();
  });
});
