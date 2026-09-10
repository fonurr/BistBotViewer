import type { ActiveOrder, Position } from '../bistApi/types';
import { holidayCalendar } from './calendar';
import {
  calculateSellable,
  deriveFilledPnlState,
  intentSlippagePercentage,
  marketSlippagePercentage,
  realizedPnl,
  reservedBuyCost,
  sentSlipAllowed,
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
  finalSeenTime: 2,
  orderQuantity: 120,
  quantity: 120,
  averagePrice: 38.2,
  orderPrice: 38.16,
  chainId: 'chain-1',
  origin: null,
  originData: null,
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
    origin: null,
    originData: null,
    intentType: 'limit',
    cancelAtFloor: false,
    chainId: 'chain-1',
    parentClientOrderId: 'buy-1',
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

  it('measures fill against the decision-time market price, market orders included', () => {
    // Signed by the direction the price moved: a fill above the tape is positive
    // whichever side it was.
    expect(marketSlippagePercentage({ marketPrice: 38.16, averagePrice: 38.2 })).toBeCloseTo(
      0.1048,
    );
    expect(marketSlippagePercentage({ marketPrice: 40, averagePrice: 39.8 })).toBeCloseTo(-0.5);
    // No order-type guard: unlike the intent slip, this one holds for a market order.
    expect(marketSlippagePercentage({ marketPrice: null, averagePrice: 38.2 })).toBeNull();
    expect(marketSlippagePercentage({ marketPrice: 0, averagePrice: 38.2 })).toBeNull();
  });

  it('allows an @sent slip only for a send inside continuous trading, a second clear of each edge', () => {
    // 13.08.2026 is a Thursday, 14.08 a half day, 15.08 a Saturday and 17.08 a full holiday.
    const holidays = holidayCalendar([
      { date: '2026-08-14', type: 'half' },
      { date: '2026-08-17', type: 'full' },
    ]);
    const allowed = (iso: string) => sentSlipAllowed(Date.parse(iso), holidays);

    // Read to the whole second the `sent` column prints: 10:00:00.999 is still the open's own.
    expect(allowed('2026-08-13T10:00:00.999+03:00')).toBe(false);
    expect(allowed('2026-08-13T10:00:01.000+03:00')).toBe(true);
    expect(allowed('2026-08-13T14:30:00.000+03:00')).toBe(true);
    expect(allowed('2026-08-13T17:59:59.999+03:00')).toBe(true);
    expect(allowed('2026-08-13T18:00:00.000+03:00')).toBe(false);
    // Pre-open, the opening match, the closing auction and the evening all worked another tape.
    expect(allowed('2026-08-13T09:00:00.000+03:00')).toBe(false);
    expect(allowed('2026-08-13T09:55:30.000+03:00')).toBe(false);
    expect(allowed('2026-08-13T18:00:30.000+03:00')).toBe(false);
    expect(allowed('2026-08-13T21:06:00.000+03:00')).toBe(false);
    // A half day closes at 12:30, so its last counted second is 12:29:59.
    expect(allowed('2026-08-14T12:29:59.000+03:00')).toBe(true);
    expect(allowed('2026-08-14T12:30:00.000+03:00')).toBe(false);
    expect(allowed('2026-08-14T14:00:00.000+03:00')).toBe(false);
    // A closed day, and a row with no send stamp to place at all.
    expect(allowed('2026-08-15T12:00:00.000+03:00')).toBe(false);
    expect(allowed('2026-08-17T12:00:00.000+03:00')).toBe(false);
    expect(sentSlipAllowed(null, holidays)).toBe(false);
    expect(sentSlipAllowed(Number.NaN, holidays)).toBe(false);
  });

  it('measures fill against the price at the instant the order could first trade', () => {
    expect(intentSlippagePercentage({ intentPrice: 38.16, averagePrice: 38.2 })).toBeCloseTo(
      0.1048,
    );
    expect(intentSlippagePercentage({ intentPrice: 40, averagePrice: 39.8 })).toBeCloseTo(-0.5);
    // Withheld where the minute history could not price the instant at all.
    expect(intentSlippagePercentage({ intentPrice: null, averagePrice: 38.2 })).toBeNull();
    expect(intentSlippagePercentage({ intentPrice: 0, averagePrice: 38.2 })).toBeNull();
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
