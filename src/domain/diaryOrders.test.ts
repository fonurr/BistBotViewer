import { describe, expect, it } from 'vitest';

import {
  makeActiveOrder,
  makeCanceledOrder,
  makeClosedTrade,
  makePosition,
  makeBot,
  makeBotHistoryEntry,
} from '../test/fixtures';
import type { BookChainSources } from './chains';
import {
  buildDiary,
  diaryDates,
  diaryKindCounts,
  filterDiary,
  groupDiaryByDate,
  type DiaryEvent,
} from './diary';
import { diaryOrderEvents } from './diaryOrders';
import { accountIdentityKey } from './accounts';

const sources = (overrides: Partial<BookChainSources> = {}): BookChainSources => ({
  activeOrders: [],
  canceledOrders: [],
  positions: [],
  closedTrades: [],
  ...overrides,
});
const say = (event: DiaryEvent) => event.description.map((fragment) => fragment.text).join('');
const eventsFor = (overrides: Partial<BookChainSources>) =>
  diaryOrderEvents(sources(overrides), () => 'account');
const all = {
  kinds: null,
  botFilter: false,
  botIds: null,
  accountFilter: false,
  accountKeys: null,
  from: null,
  to: null,
};

describe('order diary', () => {
  it.each(['Skipped', 'SkippedForNow'])(
    'never draws the hypothetical schedule of a %s order',
    (status) => {
      const order = makeCanceledOrder({
        status,
        createdTime: 100,
        scheduledTime: 200,
        sentTime: null,
        finalSeenTime: 100,
      });
      const events = eventsFor({ canceledOrders: [order] });
      expect(events.map((event) => event.orderStage)).toEqual(['canceled']);
    },
  );

  it('shows the planned day and price, sent market price, and fill price with side colors', () => {
    const order = makePosition({
      createdTime: Date.parse('2026-08-24T21:00:00+03:00'),
      scheduledTime: Date.parse('2026-08-25T09:55:30+03:00'),
      orderPrice: 300,
      marketPrice: 299,
      averagePrice: 300.25,
    });
    const events = eventsFor({ positions: [order] });
    expect(say(events[0]!)).toBe('THYAO buy scheduled for 09:55:30+1, order price 300,00.');
    expect(say(events[1]!)).toBe('THYAO buy sent, market price 299,00.');
    expect(say(events[2]!)).toBe('THYAO buy filled, 100 shares, average fill price 300,25.');
    expect(
      events.every((event) =>
        event.description.some((fragment) => fragment.ink === 'buy' && fragment.text === 'buy'),
      ),
    ).toBe(true);
    expect(events.some((event) => say(event).includes('fill observed'))).toBe(false);
    const sale = eventsFor({
      activeOrders: [makeActiveOrder({ direction: 'sell', marketPrice: null })],
    });
    expect(say(sale[0]!)).toBe('AKBNK sell sent.');
    expect(sale[0]!.description.some((fragment) => fragment.ink === 'sell')).toBe(true);
  });

  it('deduplicates repeated carriers without losing distinct sides, bots or trades', () => {
    const order = makeActiveOrder({ scheduledTime: 200, createdTime: 100 });
    const trade = makeClosedTrade();
    const data = { activeOrders: [order], closedTrades: [trade] };
    expect(eventsFor({ activeOrders: [order, order], closedTrades: [trade, trade] })).toEqual(
      eventsFor(data),
    );
    const buysAndSells = eventsFor({
      activeOrders: [order, { ...order, direction: 'sell' }, { ...order, botId: 'another' }],
    });
    expect(buysAndSells.filter((event) => event.orderStage === 'scheduled')).toHaveLength(3);
  });

  it('does not invent a creation event or missing prices', () => {
    const events = eventsFor({ activeOrders: [makeActiveOrder({ marketPrice: null })] });
    expect(events.map((event) => say(event))).toEqual(['AKBNK buy sent.']);
  });
  it('does not infer a fill from a zero canceled quantity on an unsized order', () => {
    const events = eventsFor({
      canceledOrders: [
        makeCanceledOrder({
          canceledQuantity: 0,
          status: 'Canceled',
          source: 'Server',
          reason: 'BuyGuard',
        }),
      ],
    });
    expect(events.some((event) => event.orderStage === 'filled')).toBe(false);
    expect(say(events.find((event) => event.orderStage === 'canceled')!)).toBe(
      'THYAO sell canceled by server: BuyGuard.',
    );
  });
  it('uses creation for scheduled, send for sent and the observed end for canceled', () => {
    const order = makeCanceledOrder({
      createdTime: 100,
      scheduledTime: 200,
      sentTime: 300,
      finalSeenTime: 400,
      reason: 'BuyGuard',
    });
    const events = eventsFor({ canceledOrders: [order] });
    expect(events.map((event) => [event.orderStage, event.time])).toEqual([
      ['scheduled', 100],
      ['sent', 300],
      ['canceled', 400],
    ]);
    expect(say(events[0]!)).toBe('THYAO sell scheduled for 02:00:00, order price 310,00.');
    expect(say(events[2]!)).toBe('THYAO sell canceled by user: BuyGuard.');
  });

  it.each(['Rejected', 'Expired', 'Skipped', 'SkippedForNow'])(
    'includes %s under canceled without inventing a send',
    (status) => {
      const events = eventsFor({ canceledOrders: [makeCanceledOrder({ status, sentTime: null })] });
      expect(events.map((event) => event.orderStage)).toEqual(['canceled']);
    },
  );

  it('does not turn a cancel request or its rejection trace into a confirmed cancellation', () => {
    const events = eventsFor({
      activeOrders: [makeActiveOrder({ status: 'CancelRejectTrace', cancelSource: 'user' })],
    });
    expect(events.map((event) => event.orderStage)).toEqual(['sent']);
  });

  it('keeps a working partial fill untimed, including an external order with no server stamps', () => {
    const events = eventsFor({
      activeOrders: [
        makeActiveOrder({
          createdTime: null,
          sentTime: null,
          filledQuantity: 10,
          status: 'PartiallyFilled',
          origin: 'External',
        }),
      ],
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ orderStage: 'filled', time: null, date: null });
    expect(say(events[0]!)).toContain(
      'partly filled, 10 of 40 shares, average fill price 0,00; fill time unavailable',
    );
    expect(events[0]!.description.find((fragment) => fragment.text === 'partly filled')?.ink).toBe(
      'wait',
    );
    expect(diaryDates(events)).toEqual([]);
    expect(filterDiary(events, { ...all, from: '2030-01-01' })).toHaveLength(1);
  });

  it('counts a partially canceled buy once and records its remainder separately', () => {
    const events = eventsFor({
      canceledOrders: [
        makeCanceledOrder({
          clientOrderId: 'buy',
          direction: 'buy',
          orderQuantity: 100,
          canceledQuantity: 60,
          reason: 'PartiallyCanceled',
        }),
      ],
      positions: [makePosition({ clientOrderId: 'buy', orderQuantity: 100, quantity: 40 })],
    });
    expect(events.map((event) => event.orderStage)).toEqual(['sent', 'canceled', 'filled']);
    expect(say(events[1]!)).toContain('60 remaining: PartiallyCanceled');
    expect(say(events[2]!)).toContain('partly filled, 40 of 100 shares');
  });

  it('counts a partially canceled sell and its closed trade once', () => {
    const events = eventsFor({
      canceledOrders: [
        makeCanceledOrder({ clientOrderId: 'sell', orderQuantity: 100, canceledQuantity: 60 }),
      ],
      closedTrades: [makeClosedTrade({ clientCloseOrderId: 'sell', quantity: 40 })],
    }).filter((event) => say(event).startsWith('THYAO sell'));
    expect(events).toHaveLength(3);
    expect(say(events.find((event) => event.orderStage === 'filled')!)).toContain('40 of 100');
  });

  it('reconstructs an opening buy from remaining holdings and multiple closed slices', () => {
    const events = eventsFor({
      positions: [makePosition({ clientOrderId: 'buy', quantity: 30, orderQuantity: 100 })],
      closedTrades: [
        makeClosedTrade({
          id: 1,
          clientOpenOrderId: 'buy',
          clientCloseOrderId: 'sell1',
          quantity: 20,
        }),
        makeClosedTrade({
          id: 2,
          clientOpenOrderId: 'buy',
          clientCloseOrderId: 'sell2',
          quantity: 50,
        }),
      ],
    });
    const buys = events.filter((event) => say(event).startsWith('THYAO buy'));
    expect(buys).toHaveLength(2);
    expect(say(buys.find((event) => event.orderStage === 'filled')!)).toContain(
      'filled, 100 shares',
    );
    expect(say(buys.find((event) => event.orderStage === 'filled')!)).toContain(
      'average fill price 300,45',
    );
    expect(events.filter((event) => event.orderStage === 'filled')).toHaveLength(3);
  });

  it('keeps attempts in the same chain and blank order ids independent', () => {
    const events = eventsFor({
      activeOrders: [
        makeActiveOrder({ id: 1, clientOrderId: '' }),
        makeActiveOrder({ id: 2, clientOrderId: '' }),
        makeActiveOrder({ id: 3, clientOrderId: 'retry', origin: 'Retry' }),
      ],
    });
    expect(events).toHaveLength(3);
    expect(new Set(events.map((event) => event.id)).size).toBe(3);
  });

  it('never uses registration time as the fill time and places untimed fills last in either sort', () => {
    const events = eventsFor({ positions: [makePosition({ finalSeenTime: null })] });
    const fill = events.find((event) => event.orderStage === 'filled')!;
    expect(fill.time).toBeNull();
    for (const newestFirst of [true, false]) {
      expect(groupDiaryByDate(events, newestFirst).at(-1)?.date).toBeNull();
    }
  });

  it('resolves historical accounts and preserves the explicit closed-trade account', () => {
    const events = buildDiary({
      bots: [makeBot({ accountId: 'new', startTime: 500 })],
      accounts: [],
      botHistory: [makeBotHistoryEntry({ startTime: 0, endTime: 500 })],
      botSnapshots: [],
      accountSnapshots: [],
      accountTransactions: [],
      errors: [],
      orders: sources({
        activeOrders: [makeActiveOrder({ createdTime: 100, scheduledTime: 200, sentTime: 600 })],
        closedTrades: [makeClosedTrade({ accountId: 'stored' })],
      }),
    }).filter((event) => event.kind === 'orders');
    expect(events.find((event) => event.time === 100)?.accountKey).toBe(
      accountIdentityKey('ACC-1', 'BRK-1'),
    );
    expect(events.find((event) => event.time === 600)?.accountKey).toBe(
      accountIdentityKey('new', 'BRK-1'),
    );
    expect(
      events
        .filter((event) => event.symbol === 'THYAO')
        .every((event) => event.accountKey === accountIdentityKey('stored', 'BRK-1')),
    ).toBe(true);
  });

  it('combines symbol, origin and stage filters and scopes the Orders type count', () => {
    const events = eventsFor({
      activeOrders: [
        makeActiveOrder({ origin: 'User' }),
        makeActiveOrder({ id: 2, clientOrderId: 'other', symbol: 'GARAN' }),
      ],
    });
    const filter = {
      ...all,
      symbols: new Set(['AKBNK']),
      originFilter: true,
      origins: new Set(['User']),
      orderStageFilter: true,
      orderStages: new Set(['sent']),
    };
    expect(filterDiary(events, filter)).toHaveLength(1);
    expect(diaryKindCounts(events, filter).get('orders')).toBe(1);
    expect(filterDiary(events, { ...filter, orderStages: new Set() })).toEqual([]);
    expect(filterDiary(events, { ...filter, orderStageFilter: false })).toHaveLength(1);
    expect(
      filterDiary(events, { ...all, symbols: new Set(['AKBNK']), symbolsExcluded: true }),
    ).toHaveLength(1);
    expect(filterDiary(events, { ...all, originFilter: true, origins: null })).toHaveLength(1);
  });
});
