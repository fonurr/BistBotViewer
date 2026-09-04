import { describe, expect, it } from 'vitest';

import { holidayCalendar } from '../../domain/calendar';
import { buildBookChains } from '../../domain/chains';
import { deriveFilledPnlState } from '../../domain/orders';
import {
  makeActiveOrder,
  makeCanceledOrder,
  makeClosedTrade,
  makePosition,
  makeResolvedPrice,
} from '../../test/fixtures/bist';
import {
  bookRowPnlFigure,
  bookRowTodayFigure,
  summarizeBookToday,
  type RowTodayContext,
} from './BookGrid';
import { bookRowPresentation } from './rowPresentation';

const calendar = holidayCalendar([]);

function todayContext(overrides: Partial<RowTodayContext> = {}): RowTodayContext {
  return {
    marketPrice: null,
    pricesTrustworthy: true,
    todaySessionDate: '2026-08-25',
    calendar,
    prevClose: null,
    ...overrides,
  };
}

describe('Book row P&L', () => {
  it('carries no row P&L on a partial buy — only a Position or a filled sell does', () => {
    const partialBuy = makeActiveOrder({
      status: 'PartiallyFilled',
      orderQuantity: 10,
      filledQuantity: 4,
      averagePrice: 100,
    });
    const [chain] = buildBookChains({
      activeOrders: [partialBuy],
      canceledOrders: [],
      positions: [],
      closedTrades: [],
    });
    const state = deriveFilledPnlState([], [partialBuy]);

    expect(bookRowPnlFigure(chain!.activeRows[0]!, state, 110)).toBeNull();
  });

  it('splits a partial sell into realized fill and remaining Position exposure', () => {
    const position = makePosition({ quantity: 10, averagePrice: 100 });
    const partialSell = makeActiveOrder({
      id: 102,
      clientOrderId: 'client-thyao-sell-partial',
      matriksOrderId: 'mx-thyao-sell-partial',
      symbol: position.symbol,
      chainId: position.chainId,
      parentClientOrderId: position.clientOrderId,
      direction: 'sell',
      status: 'PartiallyFilled',
      orderQuantity: 10,
      filledQuantity: 4,
      averagePrice: 110,
    });
    const [chain] = buildBookChains({
      activeOrders: [partialSell],
      canceledOrders: [],
      positions: [position],
      closedTrades: [],
    });
    const state = deriveFilledPnlState([position], [partialSell]);
    const sellFigure = bookRowPnlFigure(chain!.activeRows[0]!, state, 120);
    const positionFigure = bookRowPnlFigure(chain!.positionRows[0]!, state, 120);

    expect(sellFigure).toEqual({ value: 40, costBasis: 400, marketBased: false });
    expect(positionFigure).toEqual({ value: 120, costBasis: 600, marketBased: true });
    expect(sellFigure!.value! + positionFigure!.value!).toBe(160);
  });
});

describe('Book row today figure', () => {
  const positionChain = () => {
    const position = makePosition({ quantity: 100, averagePrice: 301.5 });
    const [chain] = buildBookChains({
      activeOrders: [],
      canceledOrders: [],
      positions: [position],
      closedTrades: [],
    });
    return { chain: chain!, state: deriveFilledPnlState([position], []) };
  };

  it('measures a position opened today from its own entry, matching the p&l figure', () => {
    const { chain, state } = positionChain();
    const row = chain.positionRows[0]!;
    const today = bookRowTodayFigure(
      row,
      chain,
      state,
      todayContext({ marketPrice: 320, todaySessionDate: chain.batchDate }),
    );

    expect(today).toEqual({ value: 100 * (320 - 301.5), basis: 100 * 301.5 });
    expect(today!.value).toBe(bookRowPnlFigure(row, state, 320)!.value);
  });

  it('measures a carried-over position from the previous close', () => {
    const { chain, state } = positionChain();
    const today = bookRowTodayFigure(
      chain.positionRows[0]!,
      chain,
      state,
      todayContext({ marketPrice: 320, todaySessionDate: '2026-08-26', prevClose: 310 }),
    );

    expect(today).toEqual({ value: 100 * (320 - 310), basis: 100 * 310 });
  });

  it('withholds a carried-over position with no prior close or no trusted price', () => {
    const { chain, state } = positionChain();
    const row = chain.positionRows[0]!;

    expect(
      bookRowTodayFigure(
        row,
        chain,
        state,
        todayContext({ marketPrice: 320, todaySessionDate: '2026-08-26', prevClose: null }),
      ),
    ).toEqual({ value: null, basis: 0 });
    expect(
      bookRowTodayFigure(
        row,
        chain,
        state,
        todayContext({
          marketPrice: 320,
          todaySessionDate: '2026-08-26',
          prevClose: 310,
          pricesTrustworthy: false,
        }),
      ),
    ).toEqual({ value: null, basis: 0 });
  });

  it('measures a round trip closed today, from entry when it also opened today', () => {
    const [chain] = buildBookChains({
      activeOrders: [],
      canceledOrders: [],
      positions: [],
      closedTrades: [
        makeClosedTrade({ quantity: 100, averageOpenPrice: 300, averageClosePrice: 306 }),
      ],
    });
    const closeLeg = chain!.rows.find(
      (candidate) => candidate.source === 'closed-trade' && candidate.leg === 'close',
    )!;

    expect(
      bookRowTodayFigure(
        closeLeg,
        chain!,
        deriveFilledPnlState([], []),
        todayContext({ todaySessionDate: chain!.batchDate }),
      ),
    ).toEqual({ value: 600, basis: 100 * 300 });
  });

  it('measures a round trip that opened earlier and closed today from the previous close', () => {
    const earlier = Date.parse('2026-08-18T06:30:00.000Z');
    const [chain] = buildBookChains({
      activeOrders: [],
      canceledOrders: [],
      positions: [],
      closedTrades: [
        makeClosedTrade({
          quantity: 100,
          averageOpenPrice: 300,
          averageClosePrice: 306,
          openOrderTime: earlier,
          openExecuteTime: earlier + 2_000,
        }),
      ],
    });
    const closeLeg = chain!.rows.find(
      (candidate) => candidate.source === 'closed-trade' && candidate.leg === 'close',
    )!;

    expect(
      bookRowTodayFigure(
        closeLeg,
        chain!,
        deriveFilledPnlState([], []),
        todayContext({ todaySessionDate: '2026-08-25', prevClose: 304 }),
      ),
    ).toEqual({ value: 100 * (306 - 304), basis: 100 * 304 });
  });

  it('says nothing on a round trip closed on an earlier session, or on a buy or canceled row', () => {
    const [tradeChain] = buildBookChains({
      activeOrders: [],
      canceledOrders: [],
      positions: [],
      closedTrades: [makeClosedTrade()],
    });
    const closeLeg = tradeChain!.rows.find(
      (candidate) => candidate.source === 'closed-trade' && candidate.leg === 'close',
    )!;
    expect(
      bookRowTodayFigure(
        closeLeg,
        tradeChain!,
        deriveFilledPnlState([], []),
        todayContext({ todaySessionDate: '2026-08-26', prevClose: 304 }),
      ),
    ).toBeNull();

    const [buyChain] = buildBookChains({
      activeOrders: [makeActiveOrder()],
      canceledOrders: [],
      positions: [],
      closedTrades: [],
    });
    expect(
      bookRowTodayFigure(
        buyChain!.activeRows[0]!,
        buyChain!,
        deriveFilledPnlState([], []),
        todayContext(),
      ),
    ).toBeNull();

    const [canceledChain] = buildBookChains({
      activeOrders: [],
      canceledOrders: [makeCanceledOrder()],
      positions: [],
      closedTrades: [],
    });
    expect(
      bookRowTodayFigure(
        canceledChain!.canceledRows[0]!,
        canceledChain!,
        deriveFilledPnlState([], []),
        todayContext(),
      ),
    ).toBeNull();
  });
});

describe('summarizeBookToday', () => {
  it('sums every visible chain move against its session-start basis', () => {
    const carried = makePosition({
      id: 210,
      symbol: 'AAA',
      chainId: 'chain-aaa',
      clientOrderId: 'aaa-open',
      quantity: 100,
      averagePrice: 280,
      orderTime: Date.parse('2026-08-18T07:00:00.000Z'),
      executeTime: Date.parse('2026-08-18T07:00:02.000Z'),
    });
    const chains = buildBookChains({
      activeOrders: [],
      canceledOrders: [],
      positions: [carried],
      closedTrades: [
        makeClosedTrade({
          id: 320,
          symbol: 'BBB',
          chainId: 'chain-bbb',
          clientOpenOrderId: 'bbb-open',
          clientCloseOrderId: 'bbb-close',
          quantity: 50,
          averageOpenPrice: 100,
          averageClosePrice: 104,
        }),
      ],
    });
    const summary = summarizeBookToday(
      chains,
      new Map([['AAA', makeResolvedPrice({ symbol: 'AAA', price: 300 })]]),
      true,
      new Map([['AAA', 290]]),
      '2026-08-25',
      calendar,
    );

    // carried position: 100 * (300 - 290) = 1000 against 29 000;
    // round trip opened and closed today: 50 * (104 - 100) = 200 against 5 000.
    expect(summary.available).toBe(true);
    expect(summary.value).toBe(1200);
    expect(summary.percent).toBeCloseTo((1200 / 34_000) * 100);
  });

  it('is not available when a visible position cannot be priced', () => {
    const carried = makePosition({
      quantity: 100,
      averagePrice: 280,
      orderTime: Date.parse('2026-08-18T07:00:00.000Z'),
      executeTime: Date.parse('2026-08-18T07:00:02.000Z'),
    });
    const chains = buildBookChains({
      activeOrders: [],
      canceledOrders: [],
      positions: [carried],
      closedTrades: [],
    });

    expect(
      summarizeBookToday(chains, new Map(), false, new Map(), '2026-08-25', calendar).available,
    ).toBe(false);
  });
});

describe('scheduled row countdown', () => {
  it('reads its distance from the clock it is handed, not from render time', () => {
    const fireTime = Date.parse('2026-08-25T13:00:00.000Z');
    const scheduled = makeActiveOrder({
      status: 'Scheduled',
      matriksOrderId: null,
      orderTime: null,
      sentTime: null,
      scheduledTime: fireTime,
      whenType: 'BeforeClose',
    });
    const [chain] = buildBookChains({
      activeOrders: [scheduled],
      canceledOrders: [],
      positions: [],
      closedTrades: [],
    });
    const row = chain!.rows[0]!;

    expect(bookRowPresentation(row, chain!, fireTime - 2 * 60 * 60 * 1_000).label).toBe(
      'Scheduled · in 2h',
    );
    expect(bookRowPresentation(row, chain!, fireTime - 14 * 60 * 1_000).label).toBe(
      'Scheduled · in 14m',
    );
    expect(bookRowPresentation(row, chain!, fireTime + 1_000).label).toBe('Scheduled · due');
  });
});
