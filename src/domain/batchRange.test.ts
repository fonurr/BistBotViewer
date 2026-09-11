import { describe, expect, it } from 'vitest';

import { activeSessionDates, lastActiveSession, withinBatchRange } from './batchRange';
import { holidayCalendar } from './calendar';

const noHolidays = holidayCalendar([]);
// Monday the 24th through Wednesday the 26th.
const monToWed = { batch: '2026-08-24', through: '2026-08-26' };

describe('withinBatchRange', () => {
  it('reads a batch range by the batch alone unless asked for every day alive', () => {
    const tuesday = { from: '2026-08-25', to: '2026-08-25' };
    expect(withinBatchRange(monToWed, tuesday, 'batch')).toBe(false);
    expect(withinBatchRange(monToWed, tuesday, 'active')).toBe(true);
  });

  it('keeps a span touching the range at either end, and nothing that misses it', () => {
    expect(withinBatchRange(monToWed, { from: '2026-08-26', to: '2026-08-28' }, 'active')).toBe(
      true,
    );
    expect(withinBatchRange(monToWed, { from: '2026-08-20', to: '2026-08-24' }, 'active')).toBe(
      true,
    );
    expect(withinBatchRange(monToWed, { from: '2026-08-27', to: '2026-08-28' }, 'active')).toBe(
      false,
    );
    // Nothing is alive before it opened, whatever the basis.
    expect(withinBatchRange(monToWed, { from: '2026-08-20', to: '2026-08-21' }, 'active')).toBe(
      false,
    );
  });

  it('keeps whatever the batch reading keeps', () => {
    for (const range of [
      { from: '2026-08-24', to: '2026-08-24' },
      { from: null, to: '2026-08-24' },
      { from: '2026-08-20', to: null },
      { from: null, to: null },
    ]) {
      expect(withinBatchRange(monToWed, range, 'batch')).toBe(true);
      expect(withinBatchRange(monToWed, range, 'active')).toBe(true);
    }
  });

  it('reaches every later range while a span is still alive', () => {
    const held = { batch: '2026-08-24', through: null };
    expect(withinBatchRange(held, { from: '2026-09-10', to: '2026-09-11' }, 'active')).toBe(true);
    expect(withinBatchRange(held, { from: '2026-09-10', to: '2026-09-11' }, 'batch')).toBe(false);
  });
});

describe('lastActiveSession', () => {
  it('files the newest stamp by the batch rule, never before the batch', () => {
    // 18:30 on the Tuesday is past the session's last minute: Wednesday's business.
    expect(
      lastActiveSession(
        '2026-08-24',
        [Date.parse('2026-08-24T11:00:00+03:00'), Date.parse('2026-08-25T18:30:00+03:00')],
        noHolidays,
      ),
    ).toBe('2026-08-26');
    // A schedule aimed at Wednesday and called off on the Monday ends where it began.
    expect(
      lastActiveSession('2026-08-26', [Date.parse('2026-08-24T12:00:00+03:00')], noHolidays),
    ).toBe('2026-08-26');
  });

  it('ends a span with no stamp at all where it began', () => {
    expect(lastActiveSession('2026-08-24', [null, undefined], noHolidays)).toBe('2026-08-24');
  });
});

describe('activeSessionDates', () => {
  it('lists every trading day some span was alive in, skipping the weekend', () => {
    expect(
      activeSessionDates(
        [
          { batch: '2026-08-20', through: '2026-08-24' },
          { batch: '2026-08-21', through: '2026-08-21' },
        ],
        '2026-08-28',
        noHolidays,
      ),
    ).toEqual(['2026-08-20', '2026-08-21', '2026-08-24']);
  });

  it('runs a span still alive through the session being worked', () => {
    expect(
      activeSessionDates([{ batch: '2026-08-25', through: null }], '2026-08-27', noHolidays),
    ).toEqual(['2026-08-25', '2026-08-26', '2026-08-27']);
    // A schedule aimed past it still names its own batch.
    expect(
      activeSessionDates([{ batch: '2026-08-31', through: null }], '2026-08-27', noHolidays),
    ).toEqual(['2026-08-31']);
  });

  it('passes over a full holiday the calendar knows', () => {
    expect(
      activeSessionDates(
        [{ batch: '2026-08-28', through: '2026-09-01' }],
        '2026-09-01',
        holidayCalendar([{ date: '2026-08-31', type: 'full' }]),
      ),
    ).toEqual(['2026-08-28', '2026-09-01']);
  });
});
