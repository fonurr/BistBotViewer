import { describe, expect, it } from 'vitest';

import type { ActiveOrder, CanceledOrder, ClosedTrade, Position } from '../bistApi/types';
import { buildBookChains, toIstanbulDate } from './chains';

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
    retryCount: 0,
    intentType: 'limit',
    cancelAtFloor: false,
    chainId: 'buy-1',
    parentClientOrderId: null,
    retryOfClientOrderId: null,
    ...overrides,
  };
}

function canceled(overrides: Partial<CanceledOrder> = {}): CanceledOrder {
  return {
    id: 10,
    botId: 'bot-a',
    clientOrderId: 'sell-dead-1',
    matriksOrderId: 'mx-dead-1',
    matriksOrderId2: null,
    symbol: 'THYAO',
    orderTime: at('2026-08-24T08:00:00.000Z'),
    sentTime: at('2026-08-24T07:59:59.000Z'),
    cancelTime: at('2026-08-24T08:01:00.000Z'),
    orderQuantity: 100,
    canceledQuantity: 100,
    direction: 'sell',
    type: 'limit',
    orderPrice: 310,
    timeInForce: '0',
    status: 'Canceled',
    explanation: null,
    retryCount: 0,
    intentType: 'limit',
    cancelAtFloor: false,
    chainId: 'buy-1',
    parentClientOrderId: 'buy-1',
    retryOfClientOrderId: null,
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
    executeTime: at('2026-08-24T07:01:00.000Z'),
    orderQuantity: 100,
    quantity: 100,
    averagePrice: 300.5,
    orderPrice: 300,
    chainId: 'buy-1',
    retryOfClientOrderId: null,
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
    openExecuteTime: at('2026-08-24T07:01:00.000Z'),
    closeOrderTime: at('2026-08-25T12:00:00.000Z'),
    closeExecuteTime: at('2026-08-25T12:01:00.000Z'),
    quantity: 100,
    averageOpenPrice: 300.5,
    averageClosePrice: 315,
    openOrderPrice: 300,
    closeOrderPrice: 315,
    chainId: 'buy-1',
    openRetryOfClientOrderId: null,
    closeRetryOfClientOrderId: null,
    ...overrides,
  };
}

function build(overrides: {
  activeOrders?: ActiveOrder[];
  canceledOrders?: CanceledOrder[];
  positions?: Position[];
  closedTrades?: ClosedTrade[];
}) {
  return buildBookChains({
    activeOrders: overrides.activeOrders ?? [],
    canceledOrders: overrides.canceledOrders ?? [],
    positions: overrides.positions ?? [],
    closedTrades: overrides.closedTrades ?? [],
  });
}

describe('buildBookChains', () => {
  it('groups retry attempts only by their non-null chainId and retains retry edges', () => {
    const root = canceled({
      id: 1,
      clientOrderId: 'root-buy',
      direction: 'buy',
      chainId: 'root-buy',
      parentClientOrderId: null,
      orderTime: at('2026-08-23T21:30:00.000Z'),
      cancelTime: at('2026-08-23T21:31:00.000Z'),
      status: 'SkippedForNow',
    });
    const retry = active({
      id: 2,
      clientOrderId: 'retry-buy',
      chainId: 'root-buy',
      retryOfClientOrderId: 'root-buy',
      status: 'Scheduled',
      matriksOrderId: null,
      orderTime: null,
      sentTime: null,
      scheduledTime: at('2026-08-25T06:55:00.000Z'),
      whenType: 'Retry',
    });

    const edgeThatMustNotMerge = active({
      id: 3,
      clientOrderId: 'separate-retry',
      chainId: 'separate-chain',
      retryOfClientOrderId: 'root-buy',
    });
    const chains = build({
      activeOrders: [retry, edgeThatMustNotMerge],
      canceledOrders: [root],
    });
    const chain = chains.find(({ key }) => key === 'chain:root-buy');

    expect(chains).toHaveLength(2);
    expect(chain).toMatchObject({
      key: 'chain:root-buy',
      chainId: 'root-buy',
      batchDate: '2026-08-24',
      // A live retry with a dead root has bought nothing yet: it waits.
      scope: 'waiting',
    });
    expect(chain?.activeRows[0]).toMatchObject({
      source: 'scheduled',
      clientOrderId: 'retry-buy',
      retryOfClientOrderId: 'root-buy',
    });
    expect(chain?.canceledRows[0]?.clientOrderId).toBe('root-buy');
  });

  it('keeps every null-linked source record in its own independent chain', () => {
    const chains = build({
      activeOrders: [
        active({ id: 1, clientOrderId: 'orphan-a', chainId: null }),
        active({ id: 2, clientOrderId: 'orphan-b', chainId: null }),
      ],
      canceledOrders: [
        canceled({
          id: 3,
          clientOrderId: null,
          chainId: null,
          parentClientOrderId: null,
        }),
      ],
      positions: [
        position({
          id: 4,
          positionId: null,
          clientOrderId: 'old-buy',
          chainId: null,
        }),
      ],
      closedTrades: [trade({ id: 5, chainId: null })],
    });

    expect(chains).toHaveLength(5);
    expect(new Set(chains.map(({ key }) => key)).size).toBe(5);
    expect(chains.every((chain) => chain.chainId === null)).toBe(true);
    expect(
      chains.every((chain) => {
        const sourceCount =
          chain.sources.activeOrders.length +
          chain.sources.canceledOrders.length +
          chain.sources.positions.length +
          chain.sources.closedTrades.length;
        return sourceCount === 1;
      }),
    ).toBe(true);
    expect(chains.find(({ key }) => key === 'unlinked:closed-trade:5')?.tradeRows).toHaveLength(2);
  });

  it('subtracts every waiting sell, including cancel-in-flight and sell-all schedules', () => {
    const restingCancel = active({
      id: 2,
      clientOrderId: 'sell-resting',
      direction: 'sell',
      parentClientOrderId: 'buy-1',
      orderQuantity: 60,
      cancelSource: 'user',
    });
    const scheduledExplicit = active({
      id: 3,
      clientOrderId: 'sell-scheduled',
      direction: 'sell',
      parentClientOrderId: 'buy-1',
      status: 'Scheduled',
      matriksOrderId: null,
      orderTime: null,
      sentTime: null,
      orderQuantity: 30,
      scheduledTime: at('2026-08-24T14:30:00.000Z'),
    });

    const [partlyClaimed] = build({
      activeOrders: [restingCancel, scheduledExplicit],
      positions: [position({ quantity: 120, orderQuantity: 120 })],
    });

    expect(partlyClaimed).toMatchObject({
      positionQuantity: 120,
      sellableQuantity: 30,
      hasNoClosingOrder: false,
    });
    expect(
      partlyClaimed?.activeRows.find(({ clientOrderId }) => clientOrderId === 'sell-resting'),
    ).toMatchObject({ cancelInFlight: true, isWaiting: true });

    const sellAll = active({
      id: 4,
      clientOrderId: 'sell-all',
      direction: 'sell',
      parentClientOrderId: 'buy-1',
      status: 'Scheduled',
      matriksOrderId: null,
      orderTime: null,
      sentTime: null,
      orderQuantity: null,
      scheduledTime: at('2026-08-24T14:45:00.000Z'),
    });
    const [fullyClaimed] = build({
      activeOrders: [restingCancel, sellAll],
      positions: [position({ quantity: 120, orderQuantity: 120 })],
    });

    expect(fullyClaimed?.sellableQuantity).toBe(0);
  });

  it('keeps unconfirmed and cross-chain sells visible and globally claimed', () => {
    const unconfirmedSell = active({
      id: 41,
      clientOrderId: 'sell-unknown',
      chainId: 'separate-sell-chain',
      direction: 'sell',
      orderQuantity: 75,
      status: 'Unconfirmed',
    });
    const [positionChain, sellChain] = build({
      activeOrders: [unconfirmedSell],
      positions: [position({ quantity: 100, orderQuantity: 100 })],
    });

    expect(positionChain?.key).toBe('chain:buy-1');
    expect(positionChain).toMatchObject({
      positionQuantity: 100,
      sellableQuantity: 25,
      hasNoClosingOrder: false,
    });
    expect(sellChain).toMatchObject({
      key: 'chain:separate-sell-chain',
      positionQuantity: 100,
      sellableQuantity: 25,
      scope: 'waiting',
    });
  });

  it('projects pending buys for scheduled-sell edits and self-excludes the edited sell', () => {
    const pendingBuy = active({
      id: 51,
      clientOrderId: 'buy-pending',
      chainId: 'projected-chain',
      direction: 'buy',
      orderQuantity: 100,
    });
    const scheduledSell = active({
      id: 52,
      clientOrderId: 'sell-after-buy',
      chainId: 'projected-chain',
      parentClientOrderId: 'buy-pending',
      direction: 'sell',
      status: 'Scheduled',
      matriksOrderId: null,
      orderTime: null,
      sentTime: null,
      orderQuantity: 30,
      scheduledTime: at('2026-08-26T14:30:00.000Z'),
    });
    const [chain] = build({ activeOrders: [pendingBuy, scheduledSell] });
    const sellRow = chain?.activeRows.find((row) => row.clientOrderId === 'sell-after-buy');

    expect(chain).toMatchObject({
      positionQuantity: null,
      sellableQuantity: null,
      projectedSellableQuantity: 70,
    });
    expect(chain?.sellEditCeilingByRowKey[sellRow!.key]).toBe(100);
  });

  it('flags a held position with no sell and a waiting buy whose linked exit is canceled', () => {
    const [uncoveredPosition] = build({ positions: [position()] });
    expect(uncoveredPosition?.hasNoClosingOrder).toBe(true);

    const waitingBuy = active({
      clientOrderId: 'buy-waiting',
      chainId: 'chain-waiting',
    });
    const deadExit = canceled({
      clientOrderId: 'exit-dead',
      chainId: 'chain-waiting',
      parentClientOrderId: 'buy-waiting',
      direction: 'sell',
    });
    const [waitingWithoutExit] = build({
      activeOrders: [waitingBuy],
      canceledOrders: [deadExit],
    });
    expect(waitingWithoutExit?.hasNoClosingOrder).toBe(true);
    expect(waitingWithoutExit?.sellableQuantity).toBeNull();

    const replacementExit = active({
      id: 4,
      clientOrderId: 'exit-live',
      chainId: 'chain-waiting',
      parentClientOrderId: 'buy-waiting',
      direction: 'sell',
    });
    const [covered] = build({
      activeOrders: [waitingBuy, replacementExit],
      canceledOrders: [deadExit],
    });
    expect(covered?.hasNoClosingOrder).toBe(false);

    const [unrelatedCanceledSell] = build({
      activeOrders: [waitingBuy],
      canceledOrders: [
        canceled({
          chainId: 'chain-waiting',
          parentClientOrderId: 'some-other-buy',
        }),
      ],
    });
    expect(unrelatedCanceledSell?.hasNoClosingOrder).toBe(false);
  });

  it('normalizes a linked multi-source chain and files it under the stage it reached', () => {
    const chainId = 'history-1';
    const [chain] = build({
      activeOrders: [
        active({
          id: 1,
          chainId,
          clientOrderId: 'exit-scheduled',
          direction: 'sell',
          status: 'Scheduled',
          matriksOrderId: null,
          orderTime: null,
          sentTime: null,
          scheduledTime: at('2026-08-27T14:00:00.000Z'),
        }),
      ],
      canceledOrders: [canceled({ id: 2, chainId, clientOrderId: 'exit-dead' })],
      positions: [
        position({
          id: 3,
          chainId,
          clientOrderId: 'open-filled',
          orderTime: at('2026-08-24T21:30:00.000Z'),
          executeTime: at('2026-08-24T21:31:00.000Z'),
        }),
      ],
      closedTrades: [
        trade({
          id: 4,
          chainId,
          clientOpenOrderId: 'open-filled',
          openOrderTime: at('2026-08-24T21:30:00.000Z'),
        }),
      ],
    });

    expect(chain).toMatchObject({
      key: 'chain:history-1',
      botId: 'bot-a',
      symbol: 'THYAO',
      batchDate: '2026-08-25',
      // It holds shares, so it is a position however many legs it also owns.
      scope: 'positions',
    });
    expect(chain?.sources.activeOrders).toHaveLength(1);
    expect(chain?.sources.canceledOrders).toHaveLength(1);
    expect(chain?.sources.positions).toHaveLength(1);
    expect(chain?.sources.closedTrades).toHaveLength(1);
    expect(
      chain?.rows.reduce<Record<string, number>>((counts, row) => {
        counts[row.source] = (counts[row.source] ?? 0) + 1;
        return counts;
      }, {}),
    ).toEqual({
      position: 1,
      'closed-trade': 2,
      scheduled: 1,
      canceled: 1,
    });
  });

  it('files every chain under exactly one scope, by the stage its own life reached', () => {
    const waitingOnly = build({
      activeOrders: [active({ id: 1, chainId: 'w', clientOrderId: 'w' })],
    });
    const deadOnly = build({
      canceledOrders: [
        canceled({ id: 2, chainId: 'd', clientOrderId: 'd', parentClientOrderId: null }),
      ],
    });
    const held = build({
      activeOrders: [
        active({ id: 3, chainId: 'p', clientOrderId: 'p-sell', direction: 'sell', status: 'New' }),
      ],
      canceledOrders: [
        canceled({ id: 4, chainId: 'p', clientOrderId: 'p-dead', parentClientOrderId: 'p' }),
      ],
      positions: [position({ id: 5, chainId: 'p', clientOrderId: 'p' })],
    });
    const closed = build({
      canceledOrders: [
        canceled({ id: 6, chainId: 't', clientOrderId: 't-dead', parentClientOrderId: 't' }),
      ],
      closedTrades: [trade({ id: 7, chainId: 't', clientOpenOrderId: 't' })],
    });

    expect(waitingOnly[0]?.scope).toBe('waiting');
    // Nothing opened and nothing left to run: only the dead legs remain.
    expect(deadOnly[0]?.scope).toBe('canceled');
    // Shares in hand outrank both a live sell and a dead leg.
    expect(held[0]?.scope).toBe('positions');
    expect(closed[0]?.scope).toBe('trades');
  });

  it('sorts newest batch first, then bot and stable identity independent of input order', () => {
    const newestBotB = active({
      id: 1,
      botId: 'bot-b',
      clientOrderId: 'new-b',
      chainId: 'new-b',
      orderTime: at('2026-08-25T09:00:00.000Z'),
    });
    const older = active({
      id: 2,
      botId: 'bot-a',
      clientOrderId: 'old-a',
      chainId: 'old-a',
      orderTime: at('2026-08-24T09:00:00.000Z'),
    });
    const newestBotASecond = active({
      id: 3,
      botId: 'bot-a',
      symbol: 'YKBNK',
      clientOrderId: 'new-a-2',
      chainId: 'new-a-2',
      orderTime: at('2026-08-25T08:00:00.000Z'),
    });
    const newestBotAFirst = active({
      id: 4,
      botId: 'bot-a',
      symbol: 'AKBNK',
      clientOrderId: 'new-a-1',
      chainId: 'new-a-1',
      orderTime: at('2026-08-25T07:00:00.000Z'),
    });

    const order = build({
      activeOrders: [newestBotB, older, newestBotASecond, newestBotAFirst],
    }).map(({ key }) => key);
    const reversedOrder = build({
      activeOrders: [newestBotAFirst, newestBotASecond, older, newestBotB],
    }).map(({ key }) => key);

    expect(order).toEqual(['chain:new-a-1', 'chain:new-a-2', 'chain:new-b', 'chain:old-a']);
    expect(reversedOrder).toEqual(order);
  });
});

describe('toIstanbulDate', () => {
  it('uses Istanbul midnight rather than the host timezone', () => {
    expect(toIstanbulDate(at('2026-08-24T20:59:59.999Z'))).toBe('2026-08-24');
    expect(toIstanbulDate(at('2026-08-24T21:00:00.000Z'))).toBe('2026-08-25');
    expect(toIstanbulDate(null)).toBeNull();
  });
});
