import { describe, expect, it } from 'vitest';

import { BOOK_SIDES_DEFAULT } from '../../domain/bookSides';
import { BOOK_SLIPPAGE_FIELDS, type BookRowFlagContext } from '../../domain/bookSlippageFilter';
import { BOOK_TIME_FIELDS } from '../../domain/bookTimeFilter';
import { buildBookChains, type BookScope } from '../../domain/chains';
import { makeActiveOrder, makeCanceledOrder } from '../../test/fixtures';
import { drawnBookView, narrowingsThatEmptiedTheBook } from './BookPage';
import { defaultBookFilters } from './types';

// Every filter behind a switch comes on with nothing ticked; these tick all.
const everyClock = new Set(BOOK_TIME_FIELDS.map(({ key }) => key));
const everySlipColumn = new Set(BOOK_SLIPPAGE_FIELDS.map(({ key }) => key));

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
    // Switching it off is what restores the chains, the ticks back to none.
    const cleared = reason!.clear(defaultBookFilters);
    expect(cleared.canceledStatusFilter).toBe(false);
    expect(cleared.canceledStatuses).toEqual(new Set());
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
    expect(cleared.reasons).toEqual(new Set());
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
    expect(cleared.sources).toEqual(new Set());
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
      timeFields: everyClock,
      timeFrom: 600,
      timeTo: 602,
    };
    const [reason] = narrowingsThatEmptiedTheBook(chains, filters, noAccount, noFlags);

    expect(reason!.key).toBe('time');
    expect(reason!.sentence).toBe(
      'No chain owns an order with a selected time inside the time range.',
    );
    expect(reason!.restored).toBe(2);
    expect(reason!.clear(filters)).toEqual({
      ...filters,
      timeFilter: false,
      timeFields: new Set(),
    });
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

  it('names an empty side selection, and clears the side toggles back to every order', () => {
    const filters = {
      ...defaultBookFilters,
      timeFilter: true,
      timeFields: everyClock,
      sides: { ...BOOK_SIDES_DEFAULT, buys: false, sells: false },
    };
    const reasons = narrowingsThatEmptiedTheBook(chains, filters, noAccount, noFlags);
    expect(reasons.map(({ key, restored }) => [key, restored])).toEqual([
      ['time', 2],
      ['sides', 2],
    ]);
    const sides = reasons.at(-1)!;
    expect(sides.phrase).toBe('the side toggles');
    expect(sides.sentence).toBe('Neither buys nor sells is selected.');
    // The time filter stays: the toggles clear as one, and only they do.
    expect(sides.clear(filters)).toEqual({ ...filters, sides: BOOK_SIDES_DEFAULT });
  });

  it('names the side toggles where they leave out the one leg a filter kept', () => {
    // The only reason on record rides on a dead sell.
    const deadOnly = buildBookChains({
      activeOrders: [makeActiveOrder({ id: 1, clientOrderId: 'a', chainId: 'a' })],
      canceledOrders: [
        makeCanceledOrder({
          clientOrderId: 'dead',
          chainId: 'a',
          symbol: 'AKBNK',
          parentClientOrderId: 'a',
          reason: 'BuyGuard',
        }),
      ],
      positions: [],
      closedTrades: [],
    });
    const filters = {
      ...defaultBookFilters,
      reasonFilter: true,
      reasons: null,
      sides: { ...BOOK_SIDES_DEFAULT, includeCanceled: false },
    };
    const reasons = narrowingsThatEmptiedTheBook(deadOnly, filters, noAccount, noFlags);
    expect(reasons.map(({ key }) => key)).toEqual(['reasons', 'sides']);
    expect(reasons[1]!.sentence).toBe(
      'The side toggles leave out every order the filters would keep.',
    );

    // With no row filter on they read nothing, so they are no narrowing at all.
    expect(
      narrowingsThatEmptiedTheBook(
        chains,
        { ...filters, reasonFilter: false, symbols: new Set(['GARAN']) },
        noAccount,
        noFlags,
      ).map(({ key }) => key),
    ).toEqual(['symbols']);
  });

  it('names the slippage filter, which narrows even with every column ticked', () => {
    const filters = {
      ...defaultBookFilters,
      slippageFilter: true,
      slippageFields: everySlipColumn,
    };
    const [reason] = narrowingsThatEmptiedTheBook(chains, filters, noAccount, noFlags);

    expect(reason!.key).toBe('slippage');
    expect(reason!.sentence).toBe('No chain owns an order flagged in a selected column.');
    expect(reason!.restored).toBe(2);
    expect(reason!.clear(filters)).toEqual(defaultBookFilters);
  });

  it('names an empty slippage column selection, and puts it back to none when cleared', () => {
    const noColumn = {
      ...defaultBookFilters,
      slippageFilter: true,
      slippageFields: new Set<never>(),
    };
    const [columnReason] = narrowingsThatEmptiedTheBook(chains, noColumn, noAccount, noFlags);
    expect(columnReason!.sentence).toBe('No slippage column is selected.');
    expect(columnReason!.clear(noColumn)).toEqual(defaultBookFilters);
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
      {
        ...defaultBookFilters,
        botIds: new Set(['bot-alpha']),
        slippageFilter: true,
        slippageFields: everySlipColumn,
      },
      noAccount,
      noFlags,
    );

    // Clearing the bot filter brings back only the flagged beta chain.
    expect(reasons.map(({ key, restored }) => [key, restored])).toEqual([
      ['bots', 1],
      ['slippage', 1],
    ]);
  });

  it('names matching orders only where each filter keeps the chain on a different row', () => {
    // A resting buy the time range reaches, and a dead sell the status filter
    // does — one chain, but no single order that both of them pass.
    const split = buildBookChains({
      activeOrders: [makeActiveOrder({ id: 1, clientOrderId: 'buy', chainId: 'split' })],
      canceledOrders: [
        makeCanceledOrder({
          id: 401,
          clientOrderId: 'sell',
          chainId: 'split',
          symbol: 'AKBNK',
          parentClientOrderId: 'buy',
          orderTime: Date.parse('2026-08-25T09:00:00.000Z'),
        }),
      ],
      positions: [],
      closedTrades: [],
    });
    const filters = {
      ...defaultBookFilters,
      canceledStatusFilter: true,
      canceledStatuses: null,
      timeFilter: true,
      timeFields: new Set(['orderTime'] as const),
      timeFrom: 630,
      timeTo: 630,
    };
    // Drawn whole, the chain is there.
    expect(drawnBookView(split, filters, noFlags).chains).toHaveLength(1);

    const ordersOnly = { ...filters, ordersOnly: true };
    expect(drawnBookView(split, ordersOnly, noFlags).chains).toEqual([]);
    const reasons = narrowingsThatEmptiedTheBook(split, ordersOnly, noAccount, noFlags);
    expect(reasons.map(({ key, restored }) => [key, restored])).toEqual([
      ['canceled-statuses', 1],
      ['time', 1],
      ['orders-only', 1],
    ]);
    const toggle = reasons.at(-1)!;
    expect(toggle.phrase).toBe('matching orders only');
    expect(toggle.sentence).toBe(
      'No single order passes every filter at once, so matching orders only draws none.',
    );
    expect(toggle.clear(ordersOnly)).toEqual(filters);
  });

  it('draws only the rows that pass every filter, and leaves a chain drawn whole unnamed', () => {
    const [chain] = buildBookChains({
      activeOrders: [
        makeActiveOrder({ id: 1, clientOrderId: 'buy', chainId: 'pair', origin: 'User' }),
        makeActiveOrder({
          id: 2,
          clientOrderId: 'sell',
          chainId: 'pair',
          parentClientOrderId: 'buy',
          direction: 'sell',
        }),
      ],
      canceledOrders: [],
      positions: [],
      closedTrades: [],
    });
    const byOrigin = { ...defaultBookFilters, originFilter: true, origins: null, ordersOnly: true };

    const view = drawnBookView([chain!], byOrigin, noFlags);
    expect(view.chains).toEqual([chain]);
    expect(view.rows.get(chain!.key)?.map((row) => row.clientOrderId)).toEqual(['buy']);

    // A row filter that every row passes leaves nothing to name, and with no row
    // filter on at all the switch has nothing to narrow.
    const byTime = {
      ...defaultBookFilters,
      timeFilter: true,
      timeFields: everyClock,
      ordersOnly: true,
    };
    expect(drawnBookView([chain!], byTime, noFlags).rows.size).toBe(0);
    expect(drawnBookView([chain!], { ...byOrigin, originFilter: false }, noFlags)).toEqual({
      chains: [chain],
      rows: new Map(),
    });

    // The side toggles are asked first, of every row: with sells left out, the
    // filter that every row passes draws the buy alone.
    const buysOnly = { ...byTime, sides: { ...BOOK_SIDES_DEFAULT, sells: false } };
    expect(
      drawnBookView([chain!], buysOnly, noFlags)
        .rows.get(chain!.key)
        ?.map((row) => row.clientOrderId),
    ).toEqual(['buy']);
  });

  it('names the account filter when none is selected, and an excluded symbol by what it leaves', () => {
    const [accounts] = narrowingsThatEmptiedTheBook(
      chains,
      { ...defaultBookFilters, accountIds: new Set<string>() },
      noAccount,
      noFlags,
    );
    expect(accounts!.sentence).toBe('No account is selected.');

    const [symbols] = narrowingsThatEmptiedTheBook(
      chains,
      { ...defaultBookFilters, symbols: new Set(['AKBNK', 'THYAO']), symbolsExcluded: true },
      noAccount,
      noFlags,
    );
    expect(symbols!.sentence).toBe('Excluding AKBNK, THYAO leaves no chain in this view.');
    expect(symbols!.restored).toBe(2);
    expect(
      symbols!.clear({ ...defaultBookFilters, symbols: new Set(['AKBNK']), symbolsExcluded: true }),
    ).toEqual(defaultBookFilters);
  });
});
