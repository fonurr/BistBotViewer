import type { ActiveOrder, Position } from '../bistApi/types';
import {
  calculateSellable,
  deriveFilledPnlState,
  realizedPnl,
  reservedBuyCost,
  slippagePercentage,
  unrealizedPnl,
} from './orders';

const position = {
  id: 1,
  botId: 'bot-1',
  clientOrderId: 'buy-1',
  matriksOrderId: 'mx-buy',
  matriksOrderId2: null,
  positionId: 'p-1',
  symbol: 'BURCE',
  orderTime: 1,
  executeTime: 2,
  orderQuantity: 120,
  quantity: 120,
  averagePrice: 38.2,
  orderPrice: 38.16,
  chainId: 'chain-1',
  retryOfClientOrderId: null,
} satisfies Position;

function sell(overrides: Partial<ActiveOrder>): ActiveOrder {
  return {
    id: 2,
    botId: 'bot-1',
    clientOrderId: 'sell-1',
    matriksOrderId: 'mx-sell',
    matriksOrderId2: null,
    symbol: 'BURCE',
    orderTime: 1,
    sentTime: 1,
    orderQuantity: 60,
    filledQuantity: 0,
    direction: 'sell',
    type: 'limit',
    orderPrice: 39.9,
    averagePrice: 0,
    timeInForce: '0',
    status: 'New',
    cancelSource: null,
    retryCount: 0,
    intentType: 'limit',
    cancelAtFloor: false,
    chainId: 'chain-1',
    parentClientOrderId: 'buy-1',
    retryOfClientOrderId: null,
    ...overrides,
  };
}

describe('order arithmetic', () => {
  it('keeps cancel-in-flight sell quantities claimed', () => {
    const result = calculateSellable(position, [sell({ cancelSource: 'bot' })]);
    expect(result.sellable).toBe(60);
    expect(result.activeClaim).toBe(60);
  });

  it('lets a quantity-less schedule claim the whole position', () => {
    const result = calculateSellable(position, [
      sell({ status: 'Scheduled', matriksOrderId: null, orderQuantity: null }),
    ]);
    expect(result.hasSellAllSchedule).toBe(true);
    expect(result.sellable).toBe(0);
  });

  it('excludes captured market prices from slippage', () => {
    expect(
      slippagePercentage({ orderPrice: 38.16, averagePrice: 38.2, type: 'market' }),
    ).toBeNull();
    expect(slippagePercentage({ orderPrice: null, averagePrice: 38.2, type: 'limit' })).toBeNull();
    expect(
      slippagePercentage({ orderPrice: 38.16, averagePrice: 38.2, type: 'limit' }),
    ).toBeCloseTo(0.1048);
  });

  it('derives slippage for a row that stores no type', () => {
    // Positions and ClosedTrades carry no type, and API.md states their stored
    // price is the order (intent) price — null exactly where none existed.
    expect(slippagePercentage({ orderPrice: 38.16, averagePrice: 38.2, type: null })).toBeCloseTo(
      0.1048,
    );
    expect(slippagePercentage({ orderPrice: null, averagePrice: 38.2, type: null })).toBeNull();
  });

  it('reserves the market-buy buffer', () => {
    expect(reservedBuyCost(10, 100, 'market')).toBeCloseTo(1100);
    expect(reservedBuyCost(10, 100, 'limit')).toBe(1000);
  });

  it('treats a partially filled buy as real exposure before a Position exists', () => {
    const partialBuy = sell({
      id: 3,
      clientOrderId: 'buy-partial',
      matriksOrderId: 'mx-buy-partial',
      direction: 'buy',
      status: 'PartiallyFilled',
      orderQuantity: 10,
      filledQuantity: 4,
      averagePrice: 39,
      chainId: 'buy-partial',
      parentClientOrderId: null,
    });

    const state = deriveFilledPnlState([], [partialBuy]);

    expect(state.exposures).toEqual([
      expect.objectContaining({
        source: 'partial-buy',
        sourceId: 3,
        quantity: 4,
        averagePrice: 39,
      }),
    ]);
    expect(unrealizedPnl(state.exposures[0]!, 41)).toBe(8);
  });

  it('moves a partial sell fill from open exposure into realized P and L', () => {
    const partialSell = sell({
      status: 'PartiallyFilled',
      orderQuantity: 60,
      filledQuantity: 20,
      averagePrice: 40,
    });

    const state = deriveFilledPnlState([position], [partialSell]);

    expect(state.exposures).toEqual([
      expect.objectContaining({
        source: 'position',
        sourceId: position.id,
        quantity: 100,
        averagePrice: 38.2,
      }),
    ]);
    expect(state.partialSellFills).toEqual([
      expect.objectContaining({
        sourceId: partialSell.id,
        quantity: 20,
        averageOpenPrice: 38.2,
        averageClosePrice: 40,
      }),
    ]);
    expect(
      realizedPnl(
        state.partialSellFills[0]!.quantity,
        state.partialSellFills[0]!.averageOpenPrice,
        state.partialSellFills[0]!.averageClosePrice,
      ),
    ).toBeCloseTo(36);
    expect(unrealizedPnl(state.exposures[0]!, 41)).toBeCloseTo(280);
  });
});
