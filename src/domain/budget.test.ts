import { describe, expect, it } from 'vitest';

import type { ActiveOrder, CanceledOrder, ClosedTrade, Position } from '../bistApi/types';
import { bookBudget, budgetShare, MARKET_BUY_BUDGET_BUFFER } from './budget';
import { buildBookChains } from './chains';

const at = (iso: string): number => Date.parse(iso);

function active(overrides: Partial<ActiveOrder> = {}): ActiveOrder {
  return {
    id: 1,
    botId: 'bot-a',
    clientOrderId: 'buy-1',
    matriksOrderId: 'mx-1',
    matriksOrderId2: null,
    symbol: 'THYAO',
    orderTime: at('2026-08-24T07:00:00.000Z'),
    sentTime: at('2026-08-24T06:59:59.000Z'),
    orderQuantity: 100,
    filledQuantity: 0,
    direction: 'buy',
    type: 'limit',
    orderPrice: 300,
    averagePrice: 0,
    timeInForce: '0',
    status: 'New',
    cancelSource: null,
    origin: null,
    originData: null,
    intentType: 'limit',
    cancelAtFloor: false,
    chainId: 'buy-1',
    parentClientOrderId: null,
    ...overrides,
  };
}

function canceled(overrides: Partial<CanceledOrder> = {}): CanceledOrder {
  return {
    id: 10,
    botId: 'bot-a',
    clientOrderId: 'buy-1',
    matriksOrderId: 'mx-1',
    matriksOrderId2: null,
    symbol: 'THYAO',
    orderTime: at('2026-08-24T08:00:00.000Z'),
    sentTime: at('2026-08-24T07:59:59.000Z'),
    finalSeenTime: at('2026-08-24T08:01:00.000Z'),
    orderQuantity: 100,
    canceledQuantity: 100,
    direction: 'buy',
    type: 'limit',
    orderPrice: 300,
    timeInForce: '0',
    status: 'Canceled',
    explanation: null,
    reason: null,
    origin: null,
    originData: null,
    intentType: 'limit',
    cancelAtFloor: false,
    chainId: 'buy-1',
    parentClientOrderId: null,
    ...overrides,
  };
}

function position(overrides: Partial<Position> = {}): Position {
  return {
    id: 20,
    botId: 'bot-a',
    clientOrderId: 'buy-1',
    matriksOrderId: 'mx-1',
    matriksOrderId2: null,
    positionId: 'position-1',
    symbol: 'THYAO',
    orderTime: at('2026-08-24T07:00:00.000Z'),
    finalSeenTime: at('2026-08-24T07:01:00.000Z'),
    orderQuantity: 100,
    quantity: 100,
    averagePrice: 300.5,
    orderPrice: 300,
    chainId: 'buy-1',
    origin: null,
    originData: null,
    ...overrides,
  };
}

function trade(overrides: Partial<ClosedTrade> = {}): ClosedTrade {
  return {
    id: 30,
    botId: 'bot-a',
    accountId: 'account-1',
    brokerageId: 'broker-1',
    clientOpenOrderId: 'buy-1',
    matriksOpenOrderId: 'mx-1',
    matriksOpenOrderId2: null,
    clientCloseOrderId: 'sell-1',
    matriksCloseOrderId: 'mx-2',
    matriksCloseOrderId2: null,
    positionId: 'position-1',
    symbol: 'THYAO',
    openOrderTime: at('2026-08-24T07:00:00.000Z'),
    openFinalSeenTime: at('2026-08-24T07:01:00.000Z'),
    closeOrderTime: at('2026-08-25T12:00:00.000Z'),
    closeFinalSeenTime: at('2026-08-25T12:01:00.000Z'),
    quantity: 100,
    averageOpenPrice: 300.5,
    averageClosePrice: 315,
    openOrderPrice: 300,
    closeOrderPrice: 315,
    chainId: 'buy-1',
    openOrigin: null,
    openOriginData: null,
    closeOrigin: null,
    closeOriginData: null,
    ...overrides,
  };
}

function budgetOf(input: {
  activeOrders?: ActiveOrder[];
  canceledOrders?: CanceledOrder[];
  positions?: Position[];
  closedTrades?: ClosedTrade[];
}) {
  return bookBudget(
    buildBookChains({
      activeOrders: input.activeOrders ?? [],
      canceledOrders: input.canceledOrders ?? [],
      positions: input.positions ?? [],
      closedTrades: input.closedTrades ?? [],
    }),
  );
}

describe('bookBudget', () => {
  it('reports nothing for a group that owns no buy', () => {
    expect(budgetOf({})).toEqual({ kind: 'none' });
    expect(
      budgetOf({
        canceledOrders: [canceled({ direction: 'sell', chainId: null, clientOrderId: 'sell-9' })],
      }),
    ).toEqual({ kind: 'none' });
  });

  it('prices a resting limit buy with nothing filled', () => {
    expect(budgetOf({ activeOrders: [active()] })).toEqual({
      kind: 'known',
      committed: 0,
      spent: 0,
      planned: 30_000,
    });
  });

  it('buffers a resting market buy by 10% in both A and C', () => {
    const budget = budgetOf({
      activeOrders: [
        active({ type: 'market', intentType: 'market', filledQuantity: 40, averagePrice: 299 }),
      ],
    });
    expect(budget).toEqual({
      kind: 'known',
      committed: 40 * 300 * MARKET_BUY_BUDGET_BUFFER,
      spent: 40 * 299,
      planned: 100 * 300 * MARKET_BUY_BUDGET_BUFFER,
    });
  });

  it('never buffers what a buy actually paid', () => {
    const budget = budgetOf({
      activeOrders: [
        active({ type: 'market', intentType: 'market', filledQuantity: 100, averagePrice: 330 }),
      ],
    });
    expect(budget.kind === 'known' && budget.spent).toBe(33_000);
  });

  /*
   * The type is gone once the ActiveOrders row is: neither Positions nor
   * ClosedTrades carries it. A filled buy is therefore read as a market buy,
   * which is the reading that cannot understate what the bot committed.
   */
  it('reads a filled buy with no surviving order row as a market buy', () => {
    expect(budgetOf({ positions: [position()] })).toEqual({
      kind: 'known',
      committed: 100 * 300 * MARKET_BUY_BUDGET_BUFFER,
      spent: 100 * 300.5,
      planned: 100 * 300 * MARKET_BUY_BUDGET_BUFFER,
    });
  });

  it('takes the buffer off a filled buy whose canceled remainder still states limit', () => {
    const budget = budgetOf({
      canceledOrders: [canceled({ canceledQuantity: 40 })],
      positions: [position({ quantity: 60, averagePrice: 301 })],
    });
    expect(budget).toEqual({
      kind: 'known',
      committed: 60 * 300,
      spent: 60 * 301,
      planned: 100 * 300,
    });
  });

  it('counts a position and the round trips already sold out of it once each', () => {
    const budget = budgetOf({
      positions: [position({ quantity: 60 })],
      closedTrades: [trade({ quantity: 40 })],
    });
    expect(budget).toEqual({
      kind: 'known',
      committed: 100 * 300 * MARKET_BUY_BUDGET_BUFFER,
      spent: 60 * 300.5 + 40 * 300.5,
      planned: 100 * 300 * MARKET_BUY_BUDGET_BUFFER,
    });
  });

  it('does not buy the same shares twice when a partly filled buy still rests over its position', () => {
    const budget = budgetOf({
      activeOrders: [
        active({ status: 'PartiallyFilled', filledQuantity: 60, averagePrice: 300.5 }),
      ],
      positions: [position({ quantity: 60 })],
    });
    expect(budget).toEqual({
      kind: 'known',
      committed: 60 * 300,
      spent: 60 * 300.5,
      planned: 100 * 300,
    });
  });

  it('assumes a fully closed round trip filled in full when nothing states otherwise', () => {
    expect(budgetOf({ closedTrades: [trade()] })).toEqual({
      kind: 'known',
      committed: 100 * 300 * MARKET_BUY_BUDGET_BUFFER,
      spent: 100 * 300.5,
      planned: 100 * 300 * MARKET_BUY_BUDGET_BUFFER,
    });
  });

  it('counts a retried chain as one budget, not one per attempt', () => {
    const budget = budgetOf({
      canceledOrders: [
        canceled({
          id: 11,
          clientOrderId: 'buy-1',
          status: 'Unconfirmed',
          origin: 'Retry',
          originData: { count: 1 },
        }),
      ],
      activeOrders: [
        active({
          id: 2,
          clientOrderId: 'buy-1-retry',
          status: 'Filled',
          filledQuantity: 100,
          averagePrice: 299,
          orderTime: at('2026-08-24T09:00:00.000Z'),
        }),
      ],
      positions: [position({ clientOrderId: 'buy-1-retry', averagePrice: 299 })],
    });
    expect(budget).toEqual({
      kind: 'known',
      committed: 100 * 300,
      spent: 100 * 299,
      planned: 100 * 300,
    });
  });

  it('sums the chains it is handed and nothing else', () => {
    const budget = budgetOf({
      activeOrders: [
        active(),
        active({
          id: 2,
          clientOrderId: 'buy-2',
          chainId: 'buy-2',
          symbol: 'ASELS',
          orderQuantity: 50,
          orderPrice: 100,
        }),
      ],
    });
    expect(budget).toEqual({ kind: 'known', committed: 0, spent: 0, planned: 30_000 + 5_000 });
  });

  it('withholds the whole figure when one visible buy cannot be priced', () => {
    expect(
      budgetOf({
        activeOrders: [
          active(),
          active({
            id: 2,
            clientOrderId: 'buy-2',
            chainId: 'buy-2',
            status: 'Scheduled',
            orderQuantity: null,
            orderPrice: null,
            scheduledTime: at('2026-08-24T10:00:00.000Z'),
          }),
        ],
      }),
    ).toEqual({ kind: 'unknown' });
  });
});

describe('budgetShare', () => {
  it('reads a part against the plan as a percentage', () => {
    expect(budgetShare(2_280, 3_800)).toBe(60);
  });

  it('has nothing to divide by when the plan was to spend nothing', () => {
    expect(budgetShare(0, 0)).toBeNull();
  });
});
