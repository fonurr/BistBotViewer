import { describe, expect, it } from 'vitest';

import { resolveSchedule } from './schedule';

const atIstanbul = (value: string) => Date.parse(`${value}+03:00`);

describe('resolveSchedule', () => {
  it('rolls weekends and full holidays before applying a half-day close', () => {
    const result = resolveSchedule(
      { day: '2026-08-29', type: 'BeforeClose', diff: 30 },
      [
        { date: '2026-08-31', type: 'full' },
        { date: '2026-09-01', type: 'half' },
      ],
      atIstanbul('2026-08-28T10:00:00'),
    );

    expect(result).toEqual({
      ok: true,
      resolvedDay: '2026-09-01',
      fireTime: atIstanbul('2026-09-01T12:00:00'),
    });
  });

  it('rejects impossible dates and session-relative times outside the window', () => {
    expect(
      resolveSchedule({ day: '2026-02-30', type: 'AtOpen' }, [], atIstanbul('2026-01-01T00:00:00'))
        .ok,
    ).toBe(false);
    expect(
      resolveSchedule(
        { day: '2026-09-01', type: 'AfterOpen', diff: 150 },
        [{ date: '2026-09-01', type: 'half' }],
        atIstanbul('2026-08-28T10:00:00'),
      ).ok,
    ).toBe(false);
    expect(
      resolveSchedule(
        { day: '2026-09-01', type: 'BeforeClose', diff: 211 },
        [{ date: '2026-09-01', type: 'half' }],
        atIstanbul('2026-08-28T10:00:00'),
      ).ok,
    ).toBe(false);
  });

  it('rounds fractional minute differences to the nearest second', () => {
    expect(
      resolveSchedule(
        { day: '2026-09-02', type: 'AfterOpen', diff: 0.012 },
        [],
        atIstanbul('2026-08-28T10:00:00'),
      ),
    ).toEqual({
      ok: true,
      resolvedDay: '2026-09-02',
      fireTime: atIstanbul('2026-09-02T10:00:01'),
    });
  });

  it('enforces the exact future and one-year bounds after rolling', () => {
    expect(
      resolveSchedule({ day: '2026-08-25', type: 'AtOpen' }, [], atIstanbul('2026-08-25T09:55:30'))
        .ok,
    ).toBe(false);
    expect(
      resolveSchedule(
        { day: '2027-08-26', type: 'OpeningAuction' },
        [],
        atIstanbul('2026-08-25T08:59:59'),
      ).ok,
    ).toBe(false);
  });
});
