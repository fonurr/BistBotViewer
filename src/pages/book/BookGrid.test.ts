import { describe, expect, it } from 'vitest';

import { buildBookChains } from '../../domain/chains';
import { deriveFilledPnlState } from '../../domain/orders';
import { makeActiveOrder, makePosition } from '../../test/fixtures/bist';
import { bookRowPnlFigure } from './BookGrid';
import { bookRowPresentation } from './rowPresentation';

describe('Book row P&L', () => {
  it('shows market P&L on the shares filled by a partial buy', () => {
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

    expect(bookRowPnlFigure(chain!.activeRows[0]!, state, 110)).toEqual({
      value: 40,
      costBasis: 400,
      marketBased: true,
    });
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
