import { describe, expect, it } from 'vitest';

import type { Holiday } from '../bistApi/types';
import { holidayCalendar, sessionBatchDate } from './calendar';

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
    expect(sessionBatchDate(at('2026-08-13T18:05:00+03:00'), calendar())).toBe('2026-08-13');
    expect(sessionBatchDate(at('2026-08-13T18:05:01+03:00'), calendar())).toBe('2026-08-14');
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

  it('closes a half day at 12:30, five minutes of entry included', () => {
    const holidays = calendar({ date: '2026-08-14', type: 'half' });
    expect(sessionBatchDate(at('2026-08-14T12:35:00+03:00'), holidays)).toBe('2026-08-14');
    expect(sessionBatchDate(at('2026-08-14T13:00:00+03:00'), holidays)).toBe('2026-08-17');
    // A half day opens like any other day.
    expect(sessionBatchDate(at('2026-08-14T09:10:00+03:00'), holidays)).toBe('2026-08-14');
  });

  it('has no batch for a moment that is not one', () => {
    expect(sessionBatchDate(null, calendar())).toBeNull();
    expect(sessionBatchDate(Number.NaN, calendar())).toBeNull();
  });
});
