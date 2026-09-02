import { describe, expect, it } from 'vitest';

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

describe('the reason a filter emptied the Book', () => {
  it('names the single narrowing that did it, with what relaxing it brings back', () => {
    const reasons = narrowingsThatEmptiedTheBook(
      chains,
      { ...defaultBookFilters, symbols: new Set(['GARAN']) },
      noAccount,
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

  it('clears exactly the narrowing it names', () => {
    const [reason] = narrowingsThatEmptiedTheBook(
      chains,
      { ...defaultBookFilters, symbols: new Set(['GARAN']), batchFrom: '2020-01-01' },
      noAccount,
    );

    const cleared = reason!.clear({
      ...defaultBookFilters,
      symbols: new Set(['GARAN']),
      batchFrom: '2020-01-01',
    });
    expect(cleared.symbols.size).toBe(0);
    expect(cleared.batchFrom).toBe('2020-01-01');
  });
});
