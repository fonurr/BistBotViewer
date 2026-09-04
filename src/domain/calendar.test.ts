import { describe, expect, it } from 'vitest';

import type { Holiday } from '../bistApi/types';
import {
  areLivePricesExpected,
  holidayCalendar,
  isProducerExpectedUp,
  lastCompletedSessionDate,
  previousTradingDate,
  sessionBatchDate,
} from './calendar';

const at = (iso: string): number => Date.parse(iso);
const calendar = (...holidays: Holiday[]) => holidayCalendar(holidays);

/**
 * 13.08.2026 is a Thursday, 14.08 a Friday, 15.08 a Saturday and 17.08 a Monday. Times are
 * written in Istanbul's own offset, which is what the rule is stated in.
 */
describe('sessionBatchDate', () => {
  it('keeps an order the exchange could still take on its own day', () => {
    expect(sessionBatchDate(at('2026-08-13T10:30:00+03:00'), calendar())).toBe('2026-08-13');
    expect(sessionBatchDate(at('2026-08-13T00:40:00+03:00'), calendar())).toBe('2026-08-13');
  });

  it('keeps a closing-auction order on its day and moves the one past the grace', () => {
    expect(sessionBatchDate(at('2026-08-13T18:00:31+03:00'), calendar())).toBe('2026-08-13');
    expect(sessionBatchDate(at('2026-08-13T18:10:00+03:00'), calendar())).toBe('2026-08-13');
    expect(sessionBatchDate(at('2026-08-13T18:10:01+03:00'), calendar())).toBe('2026-08-14');
  });

  it('files an order written after hours in the next session', () => {
    expect(sessionBatchDate(at('2026-08-13T21:04:58+03:00'), calendar())).toBe('2026-08-14');
    expect(sessionBatchDate(at('2026-08-13T23:59:59+03:00'), calendar())).toBe('2026-08-14');
  });

  it('rolls over a weekend without a calendar, which cannot close a weekday', () => {
    expect(sessionBatchDate(at('2026-08-14T21:00:00+03:00'), calendar())).toBe('2026-08-17');
    expect(sessionBatchDate(at('2026-08-15T11:00:00+03:00'), calendar())).toBe('2026-08-17');
  });

  it('rolls over a full holiday only where the calendar covers it', () => {
    const holidays = calendar({ date: '2026-08-14', type: 'full' });
    expect(sessionBatchDate(at('2026-08-13T21:04:58+03:00'), holidays)).toBe('2026-08-17');
    expect(sessionBatchDate(at('2026-08-14T11:00:00+03:00'), holidays)).toBe('2026-08-17');
    // The same moment with no calendar loaded: absence of a row is not proof of a session,
    // but it is not proof of a closure either, and the day stands.
    expect(sessionBatchDate(at('2026-08-14T11:00:00+03:00'), calendar())).toBe('2026-08-14');
  });

  it('closes a half day at 12:30, its ten minutes of grace included', () => {
    const holidays = calendar({ date: '2026-08-14', type: 'half' });
    expect(sessionBatchDate(at('2026-08-14T12:40:00+03:00'), holidays)).toBe('2026-08-14');
    expect(sessionBatchDate(at('2026-08-14T12:40:01+03:00'), holidays)).toBe('2026-08-17');
    // A half day opens like any other day.
    expect(sessionBatchDate(at('2026-08-14T09:10:00+03:00'), holidays)).toBe('2026-08-14');
  });

  it('has no batch for a moment that is not one', () => {
    expect(sessionBatchDate(null, calendar())).toBeNull();
    expect(sessionBatchDate(Number.NaN, calendar())).toBeNull();
  });
});

describe('previousTradingDate', () => {
  it('steps back one trading day', () => {
    // 14.08.2026 is a Friday, 13.08 a Thursday.
    expect(previousTradingDate('2026-08-14', calendar())).toBe('2026-08-13');
  });

  it('skips the weekend without a calendar', () => {
    // 17.08 is a Monday; the trading day before it is Friday 14.08.
    expect(previousTradingDate('2026-08-17', calendar())).toBe('2026-08-14');
  });

  it('skips a full holiday where the calendar covers it', () => {
    const holidays = calendar({ date: '2026-08-13', type: 'full' });
    expect(previousTradingDate('2026-08-14', holidays)).toBe('2026-08-12');
    // A half day still trades, so it is not skipped.
    expect(previousTradingDate('2026-08-14', calendar({ date: '2026-08-13', type: 'half' }))).toBe(
      '2026-08-13',
    );
  });
});

/**
 * The price windows. 13.08.2026 is a Thursday; 14.08 is given as a half day, 17.08 as a full
 * holiday, and 15.08 is a Saturday.
 */
describe('the price session windows', () => {
  const holidays = calendar(
    { date: '2026-08-14', type: 'half' },
    { date: '2026-08-17', type: 'full' },
  );

  it('opens with the producer at 09:35 and closes with the auction at 18:15', () => {
    expect(isProducerExpectedUp(at('2026-08-13T09:34:59+03:00'), holidays)).toBe(false);
    expect(isProducerExpectedUp(at('2026-08-13T09:35:00+03:00'), holidays)).toBe(true);
    expect(isProducerExpectedUp(at('2026-08-13T18:15:00+03:00'), holidays)).toBe(true);
    expect(isProducerExpectedUp(at('2026-08-13T18:15:01+03:00'), holidays)).toBe(false);
  });

  it('owes a live price only from the continuous open, not from the producer start', () => {
    expect(areLivePricesExpected(at('2026-08-13T09:40:00+03:00'), holidays)).toBe(false);
    expect(areLivePricesExpected(at('2026-08-13T10:00:00+03:00'), holidays)).toBe(true);
    expect(areLivePricesExpected(at('2026-08-13T18:15:00+03:00'), holidays)).toBe(true);
    expect(areLivePricesExpected(at('2026-08-13T18:15:01+03:00'), holidays)).toBe(false);
  });

  it('moves both ends of a half day with its close', () => {
    expect(areLivePricesExpected(at('2026-08-14T12:45:00+03:00'), holidays)).toBe(true);
    expect(areLivePricesExpected(at('2026-08-14T12:45:01+03:00'), holidays)).toBe(false);
    expect(isProducerExpectedUp(at('2026-08-14T12:45:01+03:00'), holidays)).toBe(false);
    expect(isProducerExpectedUp(at('2026-08-14T14:00:00+03:00'), holidays)).toBe(false);
  });

  it('never opens on a weekend or a full holiday', () => {
    for (const day of ['2026-08-15', '2026-08-17']) {
      expect(isProducerExpectedUp(at(`${day}T12:00:00+03:00`), holidays)).toBe(false);
      expect(areLivePricesExpected(at(`${day}T12:00:00+03:00`), holidays)).toBe(false);
    }
  });
});

describe('lastCompletedSessionDate', () => {
  const holidays = calendar(
    { date: '2026-08-14', type: 'half' },
    { date: '2026-08-17', type: 'full' },
  );

  it('is yesterday until this session s own auction has finished', () => {
    expect(lastCompletedSessionDate(at('2026-08-13T18:14:59+03:00'), holidays)).toBe('2026-08-12');
    expect(lastCompletedSessionDate(at('2026-08-13T18:15:00+03:00'), holidays)).toBe('2026-08-13');
  });

  it('reads a half day s close off its own shorter session', () => {
    expect(lastCompletedSessionDate(at('2026-08-14T12:44:59+03:00'), holidays)).toBe('2026-08-13');
    expect(lastCompletedSessionDate(at('2026-08-14T12:45:00+03:00'), holidays)).toBe('2026-08-14');
  });

  it('skips back over a weekend and a full holiday', () => {
    expect(lastCompletedSessionDate(at('2026-08-17T20:00:00+03:00'), holidays)).toBe('2026-08-14');
  });
});
