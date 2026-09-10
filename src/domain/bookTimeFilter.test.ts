import { describe, expect, it } from 'vitest';

import {
  makeActiveOrder,
  makeCanceledOrder,
  makeClosedTrade,
  makePosition,
} from '../test/fixtures';
import {
  BOOK_TIME_FIELDS,
  BOOK_TIME_STEPS,
  formatBookTime,
  matchesBookTime,
  stepBookTimeRange,
  type BookTimeField,
} from './bookTimeFilter';
import { buildBookChains, type BookChain, type BookChainRow } from './chains';

const allFields = new Set(BOOK_TIME_FIELDS.map(({ key }) => key));
const absentClocks: Record<BookTimeField, number | null> = {
  createdTime: null,
  scheduledTime: null,
  intentTime: null,
  sentTime: null,
  orderTime: null,
  finalSeenTime: null,
};
const baseChain = buildBookChains({
  activeOrders: [makeActiveOrder()],
  canceledOrders: [],
  positions: [],
  closedTrades: [],
})[0]!;

function withClocks(...clocks: Partial<typeof absentClocks>[]): BookChain {
  return {
    ...baseChain,
    rows: clocks.map((times) => ({ ...baseChain.rows[0]!, ...absentClocks, ...times })),
  };
}

const stamp = (clock: string, day = '2026-09-10') => Date.parse(`${day}T${clock}+03:00`);

describe('the Book time slider stops', () => {
  it('uses hourly, opening, minute, closing and late-hour steps without duplicates', () => {
    expect(BOOK_TIME_STEPS.filter((minute) => minute <= 595)).toEqual([
      0, 60, 120, 180, 240, 300, 360, 420, 480, 540, 590, 595,
    ]);
    expect(BOOK_TIME_STEPS.filter((minute) => minute >= 595 && minute <= 1085)).toEqual(
      Array.from({ length: 491 }, (_, index) => 595 + index),
    );
    expect(BOOK_TIME_STEPS.filter((minute) => minute >= 1085)).toEqual([
      1085, 1090, 1095, 1100, 1105, 1110, 1115, 1120, 1125, 1130, 1135, 1140, 1200, 1260, 1320,
      1380, 1440,
    ]);
    expect(new Set(BOOK_TIME_STEPS).size).toBe(BOOK_TIME_STEPS.length);
  });

  it('distinguishes the two midnight endpoints', () => {
    expect(formatBookTime(0)).toBe('00:00');
    expect(formatBookTime(590)).toBe('09:50');
    expect(formatBookTime(1085)).toBe('18:05');
    expect(formatBookTime(1440)).toBe('00:00 +1');
  });
});

describe('time range steps', () => {
  it('moves both endpoints by one allowed stop, including changes in clock spacing', () => {
    expect(stepBookTimeRange({ from: 540, to: 595 }, 'both', 1)).toEqual({ from: 590, to: 596 });
    expect(stepBookTimeRange({ from: 590, to: 596 }, 'both', -1)).toEqual({ from: 540, to: 595 });
    expect(stepBookTimeRange({ from: 1084, to: 1140 }, 'both', 1)).toEqual({
      from: 1085,
      to: 1200,
    });
  });

  it('moves either endpoint alone and allows the endpoints to meet', () => {
    const range = { from: 590, to: 595 };
    expect(stepBookTimeRange(range, 'from', -1)).toEqual({ from: 540, to: 595 });
    expect(stepBookTimeRange(range, 'from', 1)).toEqual({ from: 595, to: 595 });
    expect(stepBookTimeRange(range, 'to', -1)).toEqual({ from: 590, to: 590 });
    expect(stepBookTimeRange(range, 'to', 1)).toEqual({ from: 590, to: 596 });
  });

  it('disables inward edge steps on a collapsed range but can still move both endpoints', () => {
    const range = { from: 595, to: 595 };
    expect(stepBookTimeRange(range, 'from', 1)).toBeNull();
    expect(stepBookTimeRange(range, 'to', -1)).toBeNull();
    expect(stepBookTimeRange(range, 'both', 1)).toEqual({ from: 596, to: 596 });
    expect(stepBookTimeRange(range, 'both', -1)).toEqual({ from: 590, to: 590 });
  });

  it('refuses out-of-day moves without shrinking the range', () => {
    expect(stepBookTimeRange({ from: 0, to: 595 }, 'both', -1)).toBeNull();
    expect(stepBookTimeRange({ from: 1085, to: 1440 }, 'both', 1)).toBeNull();
    expect(stepBookTimeRange({ from: 0, to: 1440 }, 'from', -1)).toBeNull();
    expect(stepBookTimeRange({ from: 0, to: 1440 }, 'to', 1)).toBeNull();
    expect(stepBookTimeRange({ from: 1380, to: 1380 }, 'both', 1)).toEqual({
      from: 1440,
      to: 1440,
    });
    expect(stepBookTimeRange({ from: 1440, to: 1440 }, 'both', 1)).toBeNull();
  });

  it('refuses endpoints outside the allowed stops and inverted ranges', () => {
    expect(stepBookTimeRange({ from: 550, to: 595 }, 'both', 1)).toBeNull();
    expect(stepBookTimeRange({ from: 540, to: 585 }, 'both', 1)).toBeNull();
    expect(stepBookTimeRange({ from: 595, to: 590 }, 'both', -1)).toBeNull();
  });
});

describe('whole-chain time matching', () => {
  it.each([
    ['09:59:59.999', false],
    ['10:00:00.000', true],
    ['10:01:30.123', true],
    ['10:02:59.999', true],
    ['10:03:00.000', false],
  ])('includes full endpoint minutes at %s', (clock, expected) => {
    expect(
      matchesBookTime(withClocks({ orderTime: stamp(clock) }), new Set(['orderTime']), 600, 602),
    ).toBe(expected);
  });

  it('allows equal bounds and includes the entire selected minute', () => {
    expect(
      matchesBookTime(withClocks({ sentTime: stamp('10:02:59.999') }), allFields, 602, 602),
    ).toBe(true);
    expect(
      matchesBookTime(withClocks({ sentTime: stamp('10:03:00.000') }), allFields, 602, 602),
    ).toBe(false);
  });

  it('reads Istanbul clock time independently of the timestamp and batch dates', () => {
    const chain = withClocks({ orderTime: Date.parse('2026-09-11T07:02:59.999Z') });
    expect(chain.batchDate).not.toBe('2026-09-11');
    expect(matchesBookTime(chain, new Set(['orderTime']), 600, 602)).toBe(true);
  });

  it('matches any selected clock on any leg and ignores unselected clocks', () => {
    const chain = withClocks(
      { orderTime: stamp('09:00:00'), sentTime: stamp('09:00:01') },
      { finalSeenTime: stamp('10:02:59.999'), createdTime: stamp('08:00:00') },
    );
    expect(matchesBookTime(chain, new Set(['orderTime', 'finalSeenTime']), 600, 602)).toBe(true);
    expect(matchesBookTime(chain, new Set(['orderTime', 'sentTime']), 600, 602)).toBe(false);
    expect(matchesBookTime(chain, new Set(), 0, 1440)).toBe(false);
  });

  it('ignores missing, invalid and nonfinite timestamps without interpreting them as midnight', () => {
    const chain = withClocks(
      absentClocks,
      { orderTime: NaN, sentTime: Infinity, createdTime: -Infinity },
      { finalSeenTime: 9e15 },
    );
    expect(matchesBookTime(chain, allFields, 0, 1440)).toBe(false);
  });

  it('includes the next midnight minute at the last stop, without wrapping other times', () => {
    const midnight = withClocks({ orderTime: stamp('00:00:59.999', '2026-09-11') });
    expect(matchesBookTime(midnight, allFields, 0, 0)).toBe(true);
    expect(matchesBookTime(midnight, allFields, 1380, 1440)).toBe(true);
    expect(matchesBookTime(midnight, allFields, 1440, 1440)).toBe(true);
    expect(matchesBookTime(midnight, allFields, 1380, 1380)).toBe(false);
    expect(
      matchesBookTime(withClocks({ orderTime: stamp('00:01:00') }), allFields, 1380, 1440),
    ).toBe(false);
    expect(
      matchesBookTime(withClocks({ orderTime: stamp('23:59:59.999') }), allFields, 1380, 1440),
    ).toBe(true);
  });

  it('rejects inverted and invalid bounds', () => {
    const chain = withClocks({ orderTime: stamp('10:00:00') });
    expect(matchesBookTime(chain, allFields, 602, 600)).toBe(false);
    expect(matchesBookTime(chain, allFields, NaN, 600)).toBe(false);
    expect(matchesBookTime(chain, allFields, 600, Infinity)).toBe(false);
  });

  const rows: readonly BookChainRow[] = buildBookChains({
    activeOrders: [
      makeActiveOrder(),
      makeActiveOrder({ id: 102, clientOrderId: 'scheduled', status: 'Scheduled' }),
    ],
    canceledOrders: [makeCanceledOrder()],
    positions: [makePosition()],
    closedTrades: [makeClosedTrade()],
  }).flatMap((chain) => chain.rows);

  it.each(BOOK_TIME_FIELDS)(
    'reads $label on every Book row kind, including both trade legs',
    ({ key }) => {
      expect(rows.map((row) => row.source).sort()).toEqual([
        'active',
        'canceled',
        'closed-trade',
        'closed-trade',
        'position',
        'scheduled',
      ]);
      for (const row of rows) {
        const chain = {
          ...baseChain,
          rows: [{ ...row, ...absentClocks, [key]: stamp('10:02:59.999') }],
        };
        expect(matchesBookTime(chain, new Set([key]), 600, 602)).toBe(true);
        expect(matchesBookTime(chain, new Set([key]), 603, 610)).toBe(false);
      }
    },
  );
});
