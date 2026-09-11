import { describe, expect, it } from 'vitest';

import { makeActiveOrder, makeCanceledOrder } from '../test/fixtures';
import {
  BOOK_SIDES_DEFAULT,
  bookSidesNarrowed,
  rowOnBookSides,
  rowsOnBookSides,
  type BookSides,
} from './bookSides';
import { buildBookChains } from './chains';

// One chain: a live buy, its live sell, and a sell that died on the way.
const [chain] = buildBookChains({
  activeOrders: [
    makeActiveOrder({ id: 1, clientOrderId: 'buy', chainId: 'legs' }),
    makeActiveOrder({
      id: 2,
      clientOrderId: 'sell',
      chainId: 'legs',
      parentClientOrderId: 'buy',
      direction: 'sell',
    }),
  ],
  canceledOrders: [
    makeCanceledOrder({
      clientOrderId: 'dead-sell',
      chainId: 'legs',
      symbol: 'AKBNK',
      parentClientOrderId: 'buy',
    }),
  ],
  positions: [],
  closedTrades: [],
});
const rows = chain!.rows;

const read = (sides: Partial<BookSides>) =>
  rowsOnBookSides(rows, { ...BOOK_SIDES_DEFAULT, ...sides })
    .map((row) => row.clientOrderId)
    .sort();

describe('the Book side toggles', () => {
  it('read every order by default, handing back the very same rows', () => {
    expect(bookSidesNarrowed(BOOK_SIDES_DEFAULT)).toBe(false);
    expect(rowsOnBookSides(rows, BOOK_SIDES_DEFAULT)).toBe(rows);
    expect(read({})).toEqual(['buy', 'dead-sell', 'sell']);
  });

  it('read a buy only while buys is ticked and a sell only while sells is', () => {
    expect(read({ sells: false })).toEqual(['buy']);
    expect(read({ buys: false })).toEqual(['dead-sell', 'sell']);
    expect(read({ buys: false, sells: false })).toEqual([]);
  });

  it('read a canceled order only with include canceled, and only while its side is on too', () => {
    expect(read({ includeCanceled: false })).toEqual(['buy', 'sell']);
    const dead = rows.find((row) => row.source === 'canceled')!;
    expect(rowOnBookSides(dead, { buys: true, sells: false, includeCanceled: true })).toBe(false);
    expect(rowOnBookSides(dead, { buys: false, sells: true, includeCanceled: true })).toBe(true);
  });

  it('count as narrowed once any one of the three is off', () => {
    expect(bookSidesNarrowed({ ...BOOK_SIDES_DEFAULT, buys: false })).toBe(true);
    expect(bookSidesNarrowed({ ...BOOK_SIDES_DEFAULT, sells: false })).toBe(true);
    expect(bookSidesNarrowed({ ...BOOK_SIDES_DEFAULT, includeCanceled: false })).toBe(true);
  });
});
