import { describe, expect, it } from 'vitest';

import type { BookRowFlagContext } from '../../domain/bookSlippageFilter';
import { buildBookChains, type BookScope } from '../../domain/chains';
import { makeActiveOrder, makeCanceledOrder } from '../../test/fixtures';
import { narrowingsThatEmptiedTheBook } from './BookPage';
import { defaultBookFilters } from './types';

const chains = buildBookChains({
  activeOrders: [
    makeActiveOrder({ id: 1, clientOrderId: 'a', chainId: 'a', symbol: 'AKBNK' }),
    makeActiveOrder({
      id: 2,
      clientOrderId: 'b',
      chainId: 'b',
      symbol: 'THYAO',
      botId: 'bot-beta',
    }),
  ],
  canceledOrders: [],
  positions: [],
  closedTrades: [],
});

const noAccount = () => null;
const noFlags: BookRowFlagContext = { calendar: new Map(), intentSlip: () => null };

describe('the reason a filter emptied the Book', () => {
  it('names the single narrowing that did it, with what relaxing it brings back', () => {
    const reasons = narrowingsThatEmptiedTheBook(
      chains,
      { ...defaultBookFilters, symbols: new Set(['GARAN']) },
      noAccount,
      noFlags,
    );

    expect(reasons).toHaveLength(1);
    expect(reasons[0]!.key).toBe('symbols');
    expect(reasons[0]!.restored).toBe(2);
    expect(reasons[0]!.sentence).toBe('GARAN has no chain in this view.');
  });

  it('names every narrowing whose removal alone would bring chains back', () => {
    const reasons = narrowingsThatEmptiedTheBook(
      chains,
      {
        ...defaultBookFilters,
        botIds: new Set(['bot-alpha']),
        symbols: new Set(['THYAO']),
      },
      noAccount,
      noFlags,
    );

    expect(reasons.map((reason) => reason.key)).toEqual(['bots', 'symbols']);
  });

  it('names nothing when only the whole combination excludes every chain', () => {
    const reasons = narrowingsThatEmptiedTheBook(
      chains,
      {
        ...defaultBookFilters,
        botIds: new Set(['bot-gamma']),
        symbols: new Set(['GARAN']),
      },
      noAccount,
      noFlags,
    );

    expect(reasons).toEqual([]);
  });

  it('names the canceled status filter, which narrows even with every status ticked', () => {
    const withCanceled = buildBookChains({
      activeOrders: [makeActiveOrder({ id: 1, clientOrderId: 'a', chainId: 'a' })],
      canceledOrders: [
        makeCanceledOrder({ id: 401, clientOrderId: 'dead', chainId: 'b', status: 'Rejected' }),
      ],
      positions: [],
      closedTrades: [],
    });

    const [reason] = narrowingsThatEmptiedTheBook(
      withCanceled,
      {
        ...defaultBookFilters,
        scopes: new Set<BookScope>(['waiting', 'positions', 'trades', 'canceled']),
        canceledStatusFilter: true,
        canceledStatuses: new Set(['By user']),
      },
      noAccount,
      noFlags,
    );

    expect(reason!.key).toBe('canceled-statuses');
    expect(reason!.sentence).toBe(
      'No chain owns a canceled order with one of the selected statuses.',
    );
    // Switching it off is what restores the chains, ticks and all.
    const cleared = reason!.clear(defaultBookFilters);
    expect(cleared.canceledStatusFilter).toBe(false);
    expect(cleared.canceledStatuses).toBeNull();
  });

  it('names the reason filter, which narrows even with every reason ticked', () => {
    const withReasons = buildBookChains({
      activeOrders: [
        makeActiveOrder({ id: 1, clientOrderId: 'a', chainId: 'a', origin: 'TakeProfit' }),
        // A chain the server said nothing about cannot match at all.
        makeActiveOrder({ id: 2, clientOrderId: 'b', chainId: 'b', origin: null }),
      ],
      canceledOrders: [],
      positions: [],
      closedTrades: [],
    });

    const [reason] = narrowingsThatEmptiedTheBook(
      withReasons,
      { ...defaultBookFilters, reasonFilter: true, reasons: new Set(['BuyGuard']) },
      noAccount,
      noFlags,
    );

    expect(reason!.key).toBe('reasons');
    expect(reason!.sentence).toBe('No chain owns a row with one of the selected reasons.');
    expect(reason!.restored).toBe(2);
    const cleared = reason!.clear(defaultBookFilters);
    expect(cleared.reasonFilter).toBe(false);
    expect(cleared.reasons).toBeNull();
  });

  it('names the source filter, which narrows even with every source ticked', () => {
    const withSources = buildBookChains({
      activeOrders: [makeActiveOrder({ id: 1, clientOrderId: 'a', chainId: 'a' })],
      canceledOrders: [
        makeCanceledOrder({ id: 401, clientOrderId: 'dead', chainId: 'b', source: 'User' }),
      ],
      positions: [],
      closedTrades: [],
    });

    const [reason] = narrowingsThatEmptiedTheBook(
      withSources,
      {
        ...defaultBookFilters,
        scopes: new Set<BookScope>(['waiting', 'positions', 'trades', 'canceled']),
        sourceFilter: true,
        sources: new Set(['Broker']),
      },
      noAccount,
      noFlags,
    );

    expect(reason!.key).toBe('sources');
    expect(reason!.sentence).toBe('No chain owns an order ended by one of the selected sources.');
    const cleared = reason!.clear(defaultBookFilters);
    expect(cleared.sourceFilter).toBe(false);
    expect(cleared.sources).toBeNull();
  });

  it('clears exactly the narrowing it names', () => {
    const [reason] = narrowingsThatEmptiedTheBook(
      chains,
      { ...defaultBookFilters, symbols: new Set(['GARAN']), batchFrom: '2020-01-01' },
      noAccount,
      noFlags,
    );

    const cleared = reason!.clear({
      ...defaultBookFilters,
      symbols: new Set(['GARAN']),
      batchFrom: '2020-01-01',
    });
    expect(cleared.symbols.size).toBe(0);
    expect(cleared.batchFrom).toBe('2020-01-01');
  });

  it('names the batch range by the way it is read, and widens it to every day on offer', () => {
    const offered = ['2026-08-20', '2026-08-21', '2026-08-24', '2026-08-25'];
    const filters = {
      ...defaultBookFilters,
      batchFrom: '2026-08-20',
      batchTo: '2026-08-21',
      batchBasis: 'active' as const,
    };
    const [reason] = narrowingsThatEmptiedTheBook(chains, filters, noAccount, noFlags, offered);

    expect(reason!.key).toBe('dates');
    expect(reason!.sentence).toBe('No chain was alive on any day of the selected batch range.');
    expect(reason!.restored).toBe(2);
    // The reading stays: across every day on offer both keep the same chains.
    expect(reason!.clear(filters)).toEqual({
      ...filters,
      batchFrom: '2026-08-20',
      batchTo: '2026-08-25',
    });

    const [byBatch] = narrowingsThatEmptiedTheBook(
      chains,
      { ...filters, batchBasis: 'batch' },
      noAccount,
      noFlags,
      offered,
    );
    expect(byBatch!.sentence).toBe('No chain opened inside the selected batch range.');
  });

  it('does not call a range reaching past every day on offer a narrowing', () => {
    expect(
      narrowingsThatEmptiedTheBook(
        chains,
        { ...defaultBookFilters, symbols: new Set(['GARAN']), batchFrom: '2020-01-01' },
        noAccount,
        noFlags,
      ).map(({ key }) => key),
    ).toEqual(['symbols']);
  });

  it('names an unmatched time range and disables it while retaining the range', () => {
    const filters = {
      ...defaultBookFilters,
      timeFilter: true,
      timeFrom: 600,
      timeTo: 602,
    };
    const [reason] = narrowingsThatEmptiedTheBook(chains, filters, noAccount, noFlags);

    expect(reason!.key).toBe('time');
    expect(reason!.sentence).toBe(
      'No chain owns an order with a selected time inside the time range.',
    );
    expect(reason!.restored).toBe(2);
    expect(reason!.clear(filters)).toEqual({ ...filters, timeFilter: false });
  });

  it('names an empty time-column selection only while time filtering is enabled', () => {
    const filters = { ...defaultBookFilters, timeFilter: true, timeFields: new Set<never>() };
    const [reason] = narrowingsThatEmptiedTheBook(chains, filters, noAccount, noFlags);
    expect(reason!.sentence).toBe('No time column is selected.');
    expect(reason!.restored).toBe(2);
    expect(reason!.clear(filters).timeFields).toEqual(defaultBookFilters.timeFields);
    expect(
      narrowingsThatEmptiedTheBook(chains, reason!.clear(filters), noAccount, noFlags),
    ).toEqual([]);
  });

  it('names an empty side selection and restores both sides when cleared', () => {
    const filters = {
      ...defaultBookFilters,
      timeFilter: true,
      timeBuys: false,
      timeSells: false,
    };
    const [reason] = narrowingsThatEmptiedTheBook(chains, filters, noAccount, noFlags);
    expect(reason!.sentence).toBe('Neither buys nor sells is selected.');
    expect(reason!.restored).toBe(2);
    const cleared = reason!.clear(filters);
    expect(cleared.timeFilter).toBe(false);
    expect(cleared.timeBuys).toBe(true);
    expect(cleared.timeSells).toBe(true);
    expect(cleared.timeIncludeCanceled).toBe(false);
  });

  it('names the slippage filter, which narrows even with every column ticked', () => {
    const filters = { ...defaultBookFilters, slippageFilter: true };
    const [reason] = narrowingsThatEmptiedTheBook(chains, filters, noAccount, noFlags);

    expect(reason!.key).toBe('slippage');
    expect(reason!.sentence).toBe('No chain owns an order flagged in a selected column.');
    expect(reason!.restored).toBe(2);
    expect(reason!.clear(filters)).toEqual(defaultBookFilters);
  });

  it('names an empty slippage column or side selection, and restores both when cleared', () => {
    const noColumn = {
      ...defaultBookFilters,
      slippageFilter: true,
      slippageFields: new Set<never>(),
    };
    const [columnReason] = narrowingsThatEmptiedTheBook(chains, noColumn, noAccount, noFlags);
    expect(columnReason!.sentence).toBe('No slippage column is selected.');
    expect(columnReason!.clear(noColumn)).toEqual(defaultBookFilters);

    const noSide = {
      ...defaultBookFilters,
      slippageFilter: true,
      slippageBuys: false,
      slippageSells: false,
    };
    const [sideReason] = narrowingsThatEmptiedTheBook(chains, noSide, noAccount, noFlags);
    expect(sideReason!.sentence).toBe('Neither buys nor sells is selected.');
    expect(sideReason!.clear(noSide)).toEqual(defaultBookFilters);
  });

  it('keeps the slippage filter applied while it weighs every other narrowing', () => {
    const mixed = buildBookChains({
      activeOrders: [
        makeActiveOrder({ id: 1, clientOrderId: 'a', chainId: 'a', symbol: 'AKBNK' }),
        // Sent 45 seconds after it was written: the `sent time` flag.
        makeActiveOrder({
          id: 2,
          clientOrderId: 'b',
          chainId: 'b',
          symbol: 'THYAO',
          botId: 'bot-beta',
          sentTime: Date.parse('2026-08-25T07:30:45.000Z'),
          orderTime: Date.parse('2026-08-25T07:30:46.000Z'),
        }),
        makeActiveOrder({
          id: 3,
          clientOrderId: 'c',
          chainId: 'c',
          symbol: 'GARAN',
          botId: 'bot-beta',
        }),
      ],
      canceledOrders: [],
      positions: [],
      closedTrades: [],
    });
    const reasons = narrowingsThatEmptiedTheBook(
      mixed,
      { ...defaultBookFilters, botIds: new Set(['bot-alpha']), slippageFilter: true },
      noAccount,
      noFlags,
    );

    // Clearing the bot filter brings back only the flagged beta chain.
    expect(reasons.map(({ key, restored }) => [key, restored])).toEqual([
      ['bots', 1],
      ['slippage', 1],
    ]);
  });
});
