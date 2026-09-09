import { describe, expect, it } from 'vitest';

import { holidayCalendar } from './calendar';
import {
  intentBarLookup,
  intentPriceFrom,
  intentPriceReference,
  intentSlipAllowed,
} from './intentPrice';

const at = (istanbulWallClock: string): number => Date.parse(`${istanbulWallClock}+03:00`);
const plain = holidayCalendar([]);
// A half day only moves the close, to 12:30, so its closing auction is at 12:35.
const halfDay = holidayCalendar([{ date: '2026-10-28', type: 'half' }]);

describe('which bar answers an intent instant', () => {
  it('reads an auction print off its own minute', () => {
    expect(intentBarLookup(at('2026-08-25T09:55:00'), plain)).toEqual({
      ts: at('2026-08-25T09:55:00'),
      field: 'close',
      isAuction: true,
    });
    expect(intentBarLookup(at('2026-08-25T18:05:00'), plain)).toEqual({
      ts: at('2026-08-25T18:05:00'),
      field: 'close',
      isAuction: true,
    });
  });

  it('puts a half day"s closing auction at its own close plus five', () => {
    // BistData writes the print at 18:05 whatever the day; the snapshot re-stamps
    // it to the session's own close + 5, so this lookup is the same on both.
    expect(intentBarLookup(at('2026-10-28T12:35:00'), halfDay)).toEqual({
      ts: at('2026-10-28T12:35:00'),
      field: 'close',
      isAuction: true,
    });
    // 18:05 is past a half day's close and names nothing.
    expect(intentBarLookup(at('2026-10-28T18:05:00'), halfDay)).toBeNull();
  });

  it('takes the first traded price at the continuous open', () => {
    expect(intentBarLookup(at('2026-08-25T10:00:00'), plain)).toEqual({
      ts: at('2026-08-25T10:00:00'),
      field: 'open',
      isAuction: false,
    });
  });

  it('takes the previous minute"s close at any other whole minute in session', () => {
    // The minute the instant opens has not traded yet at its first tick.
    expect(intentBarLookup(at('2026-08-25T14:30:00'), plain)).toEqual({
      ts: at('2026-08-25T14:29:00'),
      field: 'close',
      isAuction: false,
    });
    expect(intentBarLookup(at('2026-08-25T17:59:00'), plain)).toEqual({
      ts: at('2026-08-25T17:58:00'),
      field: 'close',
      isAuction: false,
    });
  });

  it('prices nothing at an instant carrying seconds', () => {
    // `firstTradeInstant` hands back the raw stamp during trading hours, and a
    // createdTime never lands on a whole minute. No neighbour stands in for it.
    expect(intentBarLookup(at('2026-08-25T14:30:07'), plain)).toBeNull();
    expect(intentBarLookup(at('2026-08-25T14:30:00') + 250, plain)).toBeNull();
  });

  it('prices nothing where the calendar names a minute the tape has no bar for', () => {
    expect(intentBarLookup(at('2026-08-25T18:08:00'), plain)).toBeNull();
    expect(intentBarLookup(at('2026-08-25T09:40:00'), plain)).toBeNull();
    expect(intentBarLookup(null, plain)).toBeNull();
  });
});

describe('the intent price and its scale guard', () => {
  const minute = intentBarLookup(at('2026-08-25T14:30:00'), plain)!;
  const auction = intentBarLookup(at('2026-08-25T09:55:00'), plain)!;

  it('reads the field the lookup names', () => {
    expect(intentPriceFrom({ open: 300, close: 305 }, minute, 304)).toBe(305);
    expect(intentPriceFrom({ open: 300, close: 305 }, { ...minute, field: 'open' }, 304)).toBe(300);
  });

  it('withholds a bar more than 23% from the price the row already carries', () => {
    // A mis-scaled bar, not a market that moved: same instrument, same session.
    expect(intentPriceFrom({ open: 600, close: 610 }, minute, 305)).toBeNull();
    expect(intentPriceFrom({ open: 150, close: 152 }, minute, 305)).toBeNull();
    // Inside the tolerance the bar stands.
    expect(intentPriceFrom({ open: 300, close: 330 }, minute, 305)).toBe(330);
  });

  it('lets a bar stand when the row carries no price to check it against', () => {
    expect(intentPriceFrom({ open: 600, close: 610 }, minute, null)).toBe(610);
  });

  it('has nothing to say about a missing or impossible bar', () => {
    expect(intentPriceFrom(undefined, minute, 305)).toBeNull();
    expect(intentPriceFrom({ open: 0, close: 0 }, auction, 305)).toBeNull();
  });

  it('reads the reference off the tape first, then the fill, then the ask', () => {
    expect(intentPriceReference({ marketPrice: 300, averagePrice: 301, orderPrice: 299 })).toBe(
      300,
    );
    expect(intentPriceReference({ marketPrice: null, averagePrice: 301, orderPrice: 299 })).toBe(
      301,
    );
    expect(intentPriceReference({ marketPrice: null, averagePrice: null, orderPrice: 299 })).toBe(
      299,
    );
    expect(
      intentPriceReference({ marketPrice: null, averagePrice: null, orderPrice: null }),
    ).toBeNull();
  });
});

describe('when an intent price may also carry a slip', () => {
  const intentTime = at('2026-08-25T14:30:00');
  const minute = intentBarLookup(intentTime, plain)!;
  const auction = intentBarLookup(at('2026-08-25T09:55:00'), plain)!;

  it('never off an auction print, which is a match and not a working price', () => {
    expect(intentSlipAllowed(auction, at('2026-08-25T09:55:00'), at('2026-08-25T09:55:01'))).toBe(
      false,
    );
  });

  it('not once the order registered more than ten seconds after the instant', () => {
    expect(intentSlipAllowed(minute, intentTime, intentTime + 9_999)).toBe(true);
    expect(intentSlipAllowed(minute, intentTime, intentTime + 10_000)).toBe(true);
    expect(intentSlipAllowed(minute, intentTime, intentTime + 10_001)).toBe(false);
  });

  it('is untroubled by an order that registered before its intent instant', () => {
    // A plan filed ahead of its own fire time is ordinary, not a reason to withhold.
    expect(intentSlipAllowed(minute, intentTime, intentTime - 3_600_000)).toBe(true);
    expect(intentSlipAllowed(minute, intentTime, null)).toBe(true);
  });
});
