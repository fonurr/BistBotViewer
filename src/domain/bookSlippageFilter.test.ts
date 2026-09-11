import { describe, expect, it } from 'vitest';

import { makeActiveOrder, makeCanceledOrder } from '../test/fixtures';
import {
  BOOK_SLIPPAGE_FIELDS,
  BOOK_SLIPPAGE_SIDES_DEFAULT,
  matchesBookSlippage,
  rowMatchesBookSlippage,
  type BookRowFlagContext,
  type BookSlippageField,
  type BookSlippageSides,
} from './bookSlippageFilter';
import { buildBookChains } from './chains';

const at = Date.parse('2026-08-25T07:30:00.000Z'); // a Tuesday, 10:30 Istanbul
const scheduled = Date.parse('2026-08-25T09:00:00.000Z');
// Registered twenty seconds after the send: an orange `order`.
const slowOrder = { createdTime: at - 1_000, sentTime: at, orderTime: at + 20_000 };

const chains = buildBookChains({
  activeOrders: [
    // A limit buy that filled at a price other than its own: an @created slip.
    makeActiveOrder({
      id: 1,
      clientOrderId: 'created',
      chainId: 'created',
      status: 'PartiallyFilled',
      filledQuantity: 10,
      averagePrice: 68.5,
      marketPrice: null,
    }),
    // A market buy sent inside the session: no @created slip, an @sent one.
    makeActiveOrder({
      id: 2,
      clientOrderId: 'sent',
      chainId: 'sent',
      type: 'market',
      status: 'PartiallyFilled',
      filledQuantity: 10,
      averagePrice: 68.5,
    }),
    // A sell sent 45 seconds after it was created: a red `sent`.
    makeActiveOrder({
      id: 3,
      clientOrderId: 'late',
      chainId: 'late',
      direction: 'sell',
      createdTime: at,
      sentTime: at + 45_000,
      orderTime: at + 46_000,
    }),
    makeActiveOrder({ id: 4, clientOrderId: 'slow', chainId: 'slow', ...slowOrder }),
    // Its @intent slip comes from the context, as the page resolves it.
    makeActiveOrder({ id: 5, clientOrderId: 'intent', chainId: 'intent' }),
    makeActiveOrder({ id: 6, clientOrderId: 'quiet', chainId: 'quiet' }),
  ],
  canceledOrders: [
    // A scheduled sell skipped 15 seconds past its intent: an orange `final`.
    makeCanceledOrder({
      chainId: 'final',
      orderTime: null,
      sentTime: null,
      createdTime: scheduled - 3 * 60 * 60 * 1_000,
      scheduledTime: scheduled,
      finalSeenTime: scheduled + 15_000,
    }),
  ],
  positions: [],
  closedTrades: [],
});

const context: BookRowFlagContext = {
  calendar: new Map(),
  intentSlip: (row) => (row.chainId === 'intent' ? 0.5 : null),
};

function matching(
  fields: readonly BookSlippageField[],
  sides: BookSlippageSides = BOOK_SLIPPAGE_SIDES_DEFAULT,
): string[] {
  return chains
    .filter((chain) => matchesBookSlippage(chain, new Set(fields), sides, context))
    .map((chain) => chain.chainId ?? '')
    .sort();
}

const every = BOOK_SLIPPAGE_FIELDS.map(({ key }) => key);

describe('the Book slippage filter', () => {
  it('lists its fields in the grid column order', () => {
    expect(BOOK_SLIPPAGE_FIELDS.map(({ label }) => label)).toEqual([
      'created price',
      'intent price',
      'sent price',
      'sent time',
      'order time',
      'final time',
    ]);
  });

  it('matches each field on exactly the rows whose cell draws that flag', () => {
    expect(matching(['createdPrice'])).toEqual(['created']);
    expect(matching(['intentPrice'])).toEqual(['intent']);
    expect(matching(['sentPrice'])).toEqual(['sent']);
    expect(matching(['sentTime'])).toEqual(['late']);
    expect(matching(['orderTime'])).toEqual(['slow']);
    expect(matching(['finalTime'])).toEqual(['final']);
  });

  it('keeps a chain on any ticked field, and none with nothing ticked', () => {
    expect(matching(every)).toEqual(['created', 'final', 'intent', 'late', 'sent', 'slow']);
    expect(matching(['sentTime', 'orderTime'])).toEqual(['late', 'slow']);
    expect(matching([])).toEqual([]);
  });

  it('reads only the legs on a ticked side, canceled legs included', () => {
    expect(matching(every, { buys: true, sells: false })).toEqual([
      'created',
      'intent',
      'sent',
      'slow',
    ]);
    expect(matching(every, { buys: false, sells: true })).toEqual(['final', 'late']);
    expect(matching(every, { buys: false, sells: false })).toEqual([]);
  });

  it('answers the same test one leg at a time, for the rows matching orders only draws', () => {
    // A chain whose buy is flagged and whose sell is not.
    const [mixed] = buildBookChains({
      activeOrders: [
        makeActiveOrder({ id: 7, clientOrderId: 'buy', chainId: 'mixed', ...slowOrder }),
        makeActiveOrder({
          id: 8,
          clientOrderId: 'sell',
          chainId: 'mixed',
          parentClientOrderId: 'buy',
          direction: 'sell',
        }),
      ],
      canceledOrders: [],
      positions: [],
      closedTrades: [],
    });
    const flagged = (fields: readonly BookSlippageField[], sides = BOOK_SLIPPAGE_SIDES_DEFAULT) =>
      mixed!.rows.map((row) => [
        row.direction,
        rowMatchesBookSlippage(row, new Set(fields), sides, context),
      ]);

    expect(flagged(every)).toEqual([
      ['buy', true],
      ['sell', false],
    ]);
    expect(flagged(['orderTime'], { buys: false, sells: true })).toEqual([
      ['buy', false],
      ['sell', false],
    ]);
    expect(flagged(['createdPrice'])).toEqual([
      ['buy', false],
      ['sell', false],
    ]);
  });
});
