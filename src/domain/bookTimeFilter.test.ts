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
  bookTimeSliderSteps,
  formatBookTime,
  matchesBookTime,
  parseBookTimeInput,
  rowMatchesBookTime,
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
      1380, 1439,
    ]);
    expect(new Set(BOOK_TIME_STEPS).size).toBe(BOOK_TIME_STEPS.length);
  });

  it('formats each endpoint as a padded time in the same day', () => {
    expect(formatBookTime(0)).toBe('00:00');
    expect(formatBookTime(85)).toBe('01:25');
    expect(formatBookTime(590)).toBe('09:50');
    expect(formatBookTime(1085)).toBe('18:05');
    expect(formatBookTime(1439)).toBe('23:59');
  });

  it('adds precise manual endpoints to the shared scale without duplicates', () => {
    const steps = bookTimeSliderSteps({ from: 85, to: 95 });
    expect(steps.filter((minute) => minute >= 60 && minute <= 120)).toEqual([60, 85, 95, 120]);
    expect(steps).toHaveLength(BOOK_TIME_STEPS.length + 2);
    expect(bookTimeSliderSteps({ from: 85, to: 85 })).toHaveLength(BOOK_TIME_STEPS.length + 1);
    expect(bookTimeSliderSteps({ from: 60, to: 1439 })).toBe(BOOK_TIME_STEPS);
  });

  it('keeps invalid endpoints out of the slider scale', () => {
    expect(bookTimeSliderSteps({ from: -1, to: 1439 })).toBe(BOOK_TIME_STEPS);
    expect(bookTimeSliderSteps({ from: 0, to: 1440 })).toBe(BOOK_TIME_STEPS);
    expect(bookTimeSliderSteps({ from: 85.5, to: 1439 })).toBe(BOOK_TIME_STEPS);
  });
});

describe('manual Book time input', () => {
  it.each([
    ['0000', 0],
    ['0125', 85],
    ['0925', 565],
    ['2359', 1439],
    ['0060', 60],
    ['0160', 120],
    ['2260', 1380],
  ])('accepts %s as minute %s without snapping to a slider stop', (digits, expected) => {
    expect(parseBookTimeInput(digits)).toBe(expected);
  });

  it.each([
    '',
    '125',
    '00125',
    '01:25',
    '01a5',
    ' 125',
    '-125',
    '0125\n',
    '2400',
    '2500',
    '0161',
    '2360',
  ])('rejects incomplete, nonnumeric, or out-of-day input %s', (digits) => {
    expect(parseBookTimeInput(digits)).toBeNull();
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
    expect(stepBookTimeRange({ from: 1085, to: 1439 }, 'both', 1)).toBeNull();
    expect(stepBookTimeRange({ from: 0, to: 1439 }, 'from', -1)).toBeNull();
    expect(stepBookTimeRange({ from: 0, to: 1439 }, 'to', 1)).toBeNull();
    expect(stepBookTimeRange({ from: 1380, to: 1380 }, 'both', 1)).toEqual({
      from: 1439,
      to: 1439,
    });
    expect(stepBookTimeRange({ from: 1439, to: 1439 }, 'both', 1)).toBeNull();
    expect(stepBookTimeRange({ from: 1439, to: 1439 }, 'both', -1)).toEqual({
      from: 1380,
      to: 1380,
    });
  });

  it('steps manual times to their adjacent shared stops and permits endpoints to meet', () => {
    const range = { from: 85, to: 95 };
    expect(stepBookTimeRange(range, 'from', -1)).toEqual({ from: 60, to: 95 });
    expect(stepBookTimeRange(range, 'from', 1)).toEqual({ from: 95, to: 95 });
    expect(stepBookTimeRange(range, 'to', -1)).toEqual({ from: 85, to: 85 });
    expect(stepBookTimeRange(range, 'to', 1)).toEqual({ from: 85, to: 120 });
    expect(stepBookTimeRange(range, 'both', 1)).toEqual({ from: 95, to: 120 });
    expect(stepBookTimeRange(range, 'both', -1)).toEqual({ from: 60, to: 85 });
  });

  it('preserves collapsed ranges at manual times and disables individual crossings', () => {
    const range = { from: 85, to: 85 };
    expect(stepBookTimeRange(range, 'from', 1)).toBeNull();
    expect(stepBookTimeRange(range, 'to', -1)).toBeNull();
    expect(stepBookTimeRange(range, 'both', -1)).toEqual({ from: 60, to: 60 });
    expect(stepBookTimeRange(range, 'both', 1)).toEqual({ from: 120, to: 120 });
  });

  it('refuses invalid minutes and inverted ranges', () => {
    expect(stepBookTimeRange({ from: -1, to: 595 }, 'both', 1)).toBeNull();
    expect(stepBookTimeRange({ from: 0, to: 1440 }, 'both', 1)).toBeNull();
    expect(stepBookTimeRange({ from: 85.5, to: 595 }, 'both', 1)).toBeNull();
    expect(stepBookTimeRange({ from: NaN, to: 595 }, 'both', 1)).toBeNull();
    expect(stepBookTimeRange({ from: 0, to: Infinity }, 'both', 1)).toBeNull();
    expect(stepBookTimeRange({ from: 595, to: 590 }, 'both', -1)).toBeNull();
  });
});

/** A whole chain read on every row it owns, as the page reads it with the side toggles at rest. */
const matchesChain = (
  chain: BookChain,
  fields: ReadonlySet<BookTimeField>,
  from: number,
  to: number,
) => matchesBookTime(chain.rows, fields, from, to);

describe('whole-chain time matching', () => {
  it.each([
    ['09:59:59.999', false],
    ['10:00:00.000', true],
    ['10:01:30.123', true],
    ['10:02:59.999', true],
    ['10:03:00.000', false],
  ])('includes full endpoint minutes at %s', (clock, expected) => {
    expect(
      matchesChain(withClocks({ orderTime: stamp(clock) }), new Set(['orderTime']), 600, 602),
    ).toBe(expected);
  });

  it('allows equal bounds and includes the entire selected minute', () => {
    expect(matchesChain(withClocks({ sentTime: stamp('10:02:59.999') }), allFields, 602, 602)).toBe(
      true,
    );
    expect(matchesChain(withClocks({ sentTime: stamp('10:03:00.000') }), allFields, 602, 602)).toBe(
      false,
    );
  });

  it('reads Istanbul clock time independently of the timestamp and batch dates', () => {
    const chain = withClocks({ orderTime: Date.parse('2026-09-11T07:02:59.999Z') });
    expect(chain.batchDate).not.toBe('2026-09-11');
    expect(matchesChain(chain, new Set(['orderTime']), 600, 602)).toBe(true);
  });

  it('matches any selected clock on any leg and ignores unselected clocks', () => {
    const chain = withClocks(
      { orderTime: stamp('09:00:00'), sentTime: stamp('09:00:01') },
      { finalSeenTime: stamp('10:02:59.999'), createdTime: stamp('08:00:00') },
    );
    expect(matchesChain(chain, new Set(['orderTime', 'finalSeenTime']), 600, 602)).toBe(true);
    expect(matchesChain(chain, new Set(['orderTime', 'sentTime']), 600, 602)).toBe(false);
    expect(matchesChain(chain, new Set(), 0, 1439)).toBe(false);
  });

  it('ignores missing, invalid and nonfinite timestamps without interpreting them as midnight', () => {
    const chain = withClocks(
      absentClocks,
      { orderTime: NaN, sentTime: Infinity, createdTime: -Infinity },
      { finalSeenTime: 9e15 },
    );
    expect(matchesChain(chain, allFields, 0, 1439)).toBe(false);
  });

  it('includes the final 23:59 minute without wrapping into midnight', () => {
    const midnight = withClocks({ orderTime: stamp('00:00:59.999', '2026-09-11') });
    expect(matchesChain(midnight, allFields, 0, 0)).toBe(true);
    expect(matchesChain(midnight, allFields, 1380, 1439)).toBe(false);
    expect(matchesChain(midnight, allFields, 1439, 1439)).toBe(false);
    expect(matchesChain(midnight, allFields, 1380, 1380)).toBe(false);
    expect(matchesChain(withClocks({ orderTime: stamp('00:01:00') }), allFields, 1380, 1439)).toBe(
      false,
    );
    expect(
      matchesChain(withClocks({ orderTime: stamp('23:59:59.999') }), allFields, 1439, 1439),
    ).toBe(true);
  });

  it('matches precise manually entered minutes outside the base slider stops', () => {
    expect(matchesChain(withClocks({ orderTime: stamp('01:25:59.999') }), allFields, 85, 85)).toBe(
      true,
    );
    expect(matchesChain(withClocks({ orderTime: stamp('01:26:00') }), allFields, 85, 85)).toBe(
      false,
    );
  });

  it('rejects inverted and invalid bounds', () => {
    const chain = withClocks({ orderTime: stamp('10:00:00') });
    expect(matchesChain(chain, allFields, 602, 600)).toBe(false);
    expect(matchesChain(chain, allFields, NaN, 600)).toBe(false);
    expect(matchesChain(chain, allFields, 600, Infinity)).toBe(false);
    expect(matchesChain(chain, allFields, -1, 1439)).toBe(false);
    expect(matchesChain(chain, allFields, 0, 1440)).toBe(false);
    expect(matchesChain(chain, allFields, 0, 602.5)).toBe(false);
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
        expect(matchesChain(chain, new Set([key]), 600, 602)).toBe(true);
        expect(matchesChain(chain, new Set([key]), 603, 610)).toBe(false);
      }
    },
  );
});

describe('time matching one leg at a time', () => {
  const canceledRow = buildBookChains({
    activeOrders: [],
    canceledOrders: [makeCanceledOrder()],
    positions: [],
    closedTrades: [],
  })[0]!.rows[0]!;
  // A buy leg at 10:00, a sell leg at 11:00, and a canceled buy leg at 12:00.
  const legs: readonly BookChainRow[] = [
    { ...baseChain.rows[0]!, ...absentClocks, direction: 'buy', createdTime: stamp('10:00:30') },
    { ...baseChain.rows[0]!, ...absentClocks, direction: 'sell', createdTime: stamp('11:00:30') },
    { ...canceledRow, ...absentClocks, direction: 'buy', finalSeenTime: stamp('12:00:30') },
  ];
  const matchingLegs = (from: number, to: number) =>
    legs.map((row) => rowMatchesBookTime(row, allFields, from, to));

  it('answers the same test one leg at a time, for the rows matching orders only draws', () => {
    expect(matchingLegs(600, 600)).toEqual([true, false, false]);
    expect(matchingLegs(600, 660)).toEqual([true, true, false]);
    expect(matchingLegs(720, 600)).toEqual([false, false, false]);
  });

  it('reads a canceled leg like any other: which legs are read at all is the side toggles’ call', () => {
    expect(matchingLegs(720, 720)).toEqual([false, false, true]);
    expect(matchesBookTime(legs, allFields, 720, 720)).toBe(true);
    expect(matchesBookTime(legs.slice(0, 2), allFields, 720, 720)).toBe(false);
  });
});
