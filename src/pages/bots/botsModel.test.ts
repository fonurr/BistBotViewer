import { describe, expect, it } from 'vitest';

import type { ActiveOrder, Bot, ClosedTrade, Position } from '../../bistApi/types';
import type { ResolvedPrice } from '../../priceApi/types';
import {
  botFormFor,
  calculateUnrealized,
  effectivePerPositionCap,
  getBotCardState,
  newBotForm,
  requestMatchesCreatedBot,
  sameBotStoredRecord,
  statusActionFor,
  summarizeBot,
  validateBotForm,
} from './botsModel';

describe('Bots page model', () => {
  it('uses server complete only after deactivated state takes precedence', () => {
    expect(getBotCardState(bot({ active: false, complete: false }))).toBe('deactivated');
    expect(getBotCardState(bot({ active: true, complete: false }))).toBe('incomplete');
    expect(getBotCardState(bot({ active: true, complete: true }))).toBe('healthy');
  });

  it('counts active, scheduled, cancel-in-flight, positions, sells, and trades exactly', () => {
    const orders = [
      order({ id: 1, direction: 'buy', status: 'New', cancelSource: 'bot' }),
      order({ id: 2, direction: 'buy', status: 'Scheduled' }),
      order({ id: 3, direction: 'sell', status: 'PartiallyFilled' }),
      order({ id: 4, direction: 'sell', status: 'Scheduled' }),
    ];
    const summary = summarizeBot('alpha', orders, [position()], [trade(), trade({ id: 2 })]);

    expect(summary).toMatchObject({
      openBuys: 1,
      scheduledBuys: 1,
      openPositions: 1,
      openSells: 1,
      scheduledSells: 1,
      closedTrades: 2,
      realized: 400,
      realizedPercentage: 20,
      rowCounts: {
        activeOrders: 2,
        scheduledOrders: 2,
        positions: 1,
        closedTrades: 2,
      },
    });
  });

  it('keeps a terminal row out of the card"s open counts but inside the row counts', () => {
    const orders = [
      order({ id: 1, direction: 'buy', status: 'New' }),
      order({ id: 2, direction: 'buy', status: 'Rejected' }),
      order({ id: 3, direction: 'sell', status: 'Filled' }),
    ];
    const summary = summarizeBot('alpha', orders, [], []);

    // The card says what can still execute; the row counts decide delete vs deactivate.
    expect(summary).toMatchObject({ openBuys: 1, openSells: 0 });
    expect(summary.rowCounts.activeOrders).toBe(3);
  });

  it('names the side that binds the effective per-stock cap', () => {
    expect(effectivePerPositionCap(20_000, 100, 1_000_000)).toEqual({
      value: 20_000,
      bound: 'tl',
    });
    expect(effectivePerPositionCap(20_000, 1, 1_000_000)).toEqual({
      value: 10_000,
      bound: 'percentage',
    });
    // Without a portfolio value neither figure predicts the order size.
    expect(effectivePerPositionCap(20_000, 100, null)).toBeNull();
  });

  it('makes unrealized all-or-nothing across feed and required quotes', () => {
    const positions = [position(), position({ id: 2, symbol: 'GARAN', quantity: 5 })];
    const prices = new Map([
      ['THYAO', price({ symbol: 'THYAO', price: 120 })],
      ['GARAN', price({ symbol: 'GARAN', price: 110 })],
    ]);

    expect(calculateUnrealized(positions, prices, true)).toEqual({
      value: 250,
      reason: null,
    });
    expect(calculateUnrealized(positions, prices, false)).toEqual({
      value: null,
      reason: 'feed',
    });
    // A symbol that resolved to neither a quote nor a bar is simply absent, and one absence is
    // enough to withhold the whole figure.
    expect(
      calculateUnrealized(positions, new Map([['THYAO', prices.get('THYAO')!]]), true),
    ).toEqual({
      value: null,
      reason: 'quote',
    });
    prices.delete('GARAN');
    expect(calculateUnrealized(positions, prices, true)).toEqual({
      value: null,
      reason: 'quote',
    });

    // A stored close prices the position exactly as a live quote does; only the header says which.
    expect(
      calculateUnrealized(
        positions,
        new Map([
          ['THYAO', price({ symbol: 'THYAO', price: 120, source: 'bar' })],
          ['GARAN', price({ symbol: 'GARAN', price: 110, source: 'bar' })],
        ]),
        true,
      ),
    ).toEqual({ value: 250, reason: null });
  });

  it('includes partial-buy exposure and removes partial-sell fills from the full Position', () => {
    const partialBuy = order({
      id: 11,
      clientOrderId: 'partial-buy',
      matriksOrderId: 'MX-PB',
      symbol: 'GARAN',
      chainId: 'partial-buy',
      status: 'PartiallyFilled',
      filledQuantity: 5,
      averagePrice: 90,
    });
    const partialSell = order({
      id: 12,
      clientOrderId: 'partial-sell',
      matriksOrderId: 'MX-PS',
      direction: 'sell',
      status: 'PartiallyFilled',
      filledQuantity: 4,
      averagePrice: 115,
      parentClientOrderId: 'client-1',
    });
    const positions = [position({ quantity: 10, averagePrice: 100 })];
    const prices = new Map([
      ['THYAO', price({ price: 120 })],
      ['GARAN', price({ symbol: 'GARAN', price: 100 })],
    ]);

    expect(calculateUnrealized(positions, prices, true, [partialBuy, partialSell])).toEqual({
      // 6 remaining THYAO shares Ã— 20, plus 5 filled GARAN shares Ã— 10.
      value: 170,
      reason: null,
    });

    expect(summarizeBot('alpha', [partialSell], positions, [])).toMatchObject({
      realized: 60,
      realizedPercentage: 15,
    });
  });

  it('builds an id-only incomplete Add payload and blocks duplicates and reserved all-bot id', () => {
    const form = { ...newBotForm(), id: 'fresh' };
    const result = validateBotForm(form, {
      original: null,
      existingBotIds: new Set(),
      accountLocked: false,
      committed: null,
    });
    expect(result.request).toEqual({ id: 'fresh' });
    expect(result.missingFields).toEqual(['algorithm id', 'account and brokerage', 'emails']);

    expect(
      validateBotForm(
        { ...form, id: '*' },
        {
          original: null,
          existingBotIds: new Set(),
          accountLocked: false,
          committed: null,
        },
      ).blockReason,
    ).toContain('reserved');
    expect(
      validateBotForm(form, {
        original: null,
        existingBotIds: new Set(['fresh']),
        accountLocked: false,
        committed: null,
      }).blockReason,
    ).toContain('already exists');
  });

  it('distinguishes unset emails from a deliberately empty array', () => {
    const result = validateBotForm(
      { ...newBotForm(), id: 'fresh', emailsSet: true },
      {
        original: null,
        existingBotIds: new Set(),
        accountLocked: false,
        committed: null,
      },
    );

    expect(result.request).toEqual({ id: 'fresh', emails: [] });
    expect(result.missingFields).toEqual(['algorithm id', 'account and brokerage']);
  });

  it('sends only dirty Edit fields and sends the forbidden list whole', () => {
    const original = bot();
    const form = {
      ...botFormFor(original),
      description: 'changed verbatim\nsecond line',
      forbiddenStocks: ['THYAO', 'GARAN'],
    };
    const result = validateBotForm(form, {
      original,
      existingBotIds: new Set([original.id]),
      accountLocked: false,
      committed: 2_000,
    });

    expect(result.request).toEqual({
      id: 'alpha',
      forbiddenStocks: ['THYAO', 'GARAN'],
      description: 'changed verbatim\nsecond line',
    });
  });

  it('blocks account movement with rows and a total limit below committed money', () => {
    const original = bot();
    const moved = { ...botFormFor(original), accountId: '0~999' };
    expect(
      validateBotForm(moved, {
        original,
        existingBotIds: new Set([original.id]),
        accountLocked: true,
        committed: 2_000,
      }).blockReason,
    ).toContain('locked');

    expect(
      validateBotForm(
        { ...botFormFor(original), limit: '1.999,99' },
        {
          original,
          existingBotIds: new Set([original.id]),
          accountLocked: false,
          committed: 2_000,
        },
      ).blockReason,
    ).toContain('already committed');
  });

  it('confirms all omitted create defaults before naming a result Created', () => {
    const request = { id: 'fresh' };
    const created = bot({
      id: 'fresh',
      algoritmId: null,
      accountId: null,
      brokerageId: null,
      emails: null,
      limit: 100_000,
      limitPercentage: 100,
      limitPerPosition: 20_000,
      limitPercentagePerPosition: 100,
      forbiddenStocks: [],
      active: true,
      description: null,
      complete: false,
    });
    expect(requestMatchesCreatedBot(request, created)).toBe(true);
    expect(requestMatchesCreatedBot(request, { ...created, limit: 50_000 })).toBe(false);
  });

  it('uses all four persistent row sources for the delete/deactivate branch', () => {
    const activeBot = bot();
    expect(
      statusActionFor(activeBot, {
        activeOrders: 0,
        scheduledOrders: 0,
        positions: 0,
        closedTrades: 0,
        pendingRequests: 0,
      }),
    ).toBe('delete');
    expect(
      statusActionFor(activeBot, {
        activeOrders: 0,
        scheduledOrders: 0,
        positions: 0,
        closedTrades: 1,
        pendingRequests: 0,
      }),
    ).toBe('deactivate');
    expect(
      statusActionFor(bot({ active: false }), {
        activeOrders: 0,
        scheduledOrders: 0,
        positions: 0,
        closedTrades: 0,
        pendingRequests: 0,
      }),
    ).toBe('reactivate');
  });

  it('detects any concurrent stored-record change for an Edit preflight', () => {
    const original = bot();
    expect(sameBotStoredRecord(original, { ...original })).toBe(true);
    expect(
      sameBotStoredRecord(original, {
        ...original,
        description: 'someone else changed it',
      }),
    ).toBe(false);
    expect(sameBotStoredRecord(original, { ...original, active: false })).toBe(false);
  });
});

function bot(overrides: Partial<Bot> = {}): Bot {
  return {
    id: 'alpha',
    algoritmId: 'algorithm-a',
    accountId: '0~1887087',
    brokerageId: '115',
    limitPercentage: 100,
    limit: 10_000,
    limitPerPosition: 2_000,
    limitPercentagePerPosition: 20,
    emails: ['owner@example.com'],
    forbiddenStocks: ['THYAO'],
    active: true,
    description: 'test bot',
    complete: true,
    ...overrides,
  };
}

function order(overrides: Partial<ActiveOrder> = {}): ActiveOrder {
  return {
    id: 1,
    botId: 'alpha',
    clientOrderId: 'client-1',
    matriksOrderId: 'MX-1',
    matriksOrderId2: null,
    symbol: 'THYAO',
    orderTime: Date.parse('2026-08-24T10:00:00+03:00'),
    sentTime: Date.parse('2026-08-24T10:00:01+03:00'),
    orderQuantity: 10,
    filledQuantity: 0,
    direction: 'buy',
    type: 'limit',
    orderPrice: 100,
    averagePrice: 0,
    timeInForce: 'Day',
    status: 'New',
    cancelSource: null,
    retryCount: 0,
    intentType: 'limit',
    cancelAtFloor: false,
    chainId: 'chain-1',
    parentClientOrderId: null,
    retryOfClientOrderId: null,
    ...overrides,
  };
}

function position(overrides: Partial<Position> = {}): Position {
  return {
    id: 1,
    botId: 'alpha',
    clientOrderId: 'client-1',
    matriksOrderId: 'MX-1',
    matriksOrderId2: null,
    positionId: 'position-1',
    symbol: 'THYAO',
    orderTime: Date.parse('2026-08-24T10:00:00+03:00'),
    executeTime: Date.parse('2026-08-24T10:01:00+03:00'),
    orderQuantity: 10,
    quantity: 10,
    averagePrice: 100,
    orderPrice: 100,
    chainId: 'chain-1',
    retryOfClientOrderId: null,
    ...overrides,
  };
}

function trade(overrides: Partial<ClosedTrade> = {}): ClosedTrade {
  return {
    id: 1,
    botId: 'alpha',
    accountId: '0~1887087',
    brokerageId: '115',
    clientOpenOrderId: 'open-1',
    matriksOpenOrderId: 'MX-O-1',
    matriksOpenOrderId2: null,
    clientCloseOrderId: 'close-1',
    matriksCloseOrderId: 'MX-C-1',
    matriksCloseOrderId2: null,
    positionId: 'position-1',
    symbol: 'THYAO',
    openOrderTime: Date.parse('2026-08-20T10:00:00+03:00'),
    openExecuteTime: Date.parse('2026-08-20T10:01:00+03:00'),
    closeOrderTime: Date.parse('2026-08-21T16:00:00+03:00'),
    closeExecuteTime: Date.parse('2026-08-21T16:01:00+03:00'),
    quantity: 10,
    averageOpenPrice: 100,
    averageClosePrice: 120,
    openOrderPrice: 100,
    closeOrderPrice: 120,
    chainId: 'chain-1',
    openRetryOfClientOrderId: null,
    closeRetryOfClientOrderId: null,
    ...overrides,
  };
}

function price(overrides: Partial<ResolvedPrice> = {}): ResolvedPrice {
  return {
    symbol: 'THYAO',
    price: 100,
    source: 'live',
    asOf: 1,
    ...overrides,
  };
}
