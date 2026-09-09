import { describe, expect, it } from 'vitest';

import { isInsideWindow, snapshotDayFor } from './scheduler';

const at = (istanbulWallClock: string): number => Date.parse(`${istanbulWallClock}+03:00`);

describe('the snapshot window', () => {
  it('names a snapshot day by the 23:00 boundary that opened it', () => {
    expect(snapshotDayFor(at('2026-08-25T23:00:00'))).toBe('2026-08-25');
    expect(snapshotDayFor(at('2026-08-25T23:59:59'))).toBe('2026-08-25');
    // Past midnight the window is still the one that opened the night before.
    expect(snapshotDayFor(at('2026-08-26T00:30:00'))).toBe('2026-08-25');
    expect(snapshotDayFor(at('2026-08-26T17:59:00'))).toBe('2026-08-25');
    // Before 23:00 the current day has not opened its own window yet.
    expect(snapshotDayFor(at('2026-08-26T22:59:59'))).toBe('2026-08-25');
  });

  it('opens at 23:00 and keeps retrying until 18:00 the next evening', () => {
    expect(isInsideWindow(at('2026-08-25T23:00:00'))).toBe(true);
    expect(isInsideWindow(at('2026-08-26T03:00:00'))).toBe(true);
    expect(isInsideWindow(at('2026-08-26T17:59:00'))).toBe(true);
    // After 18:00 the viewer waits rather than reaching for DuckDB again: an open
    // connection there locks BistData's own pipeline out of its next sync.
    expect(isInsideWindow(at('2026-08-26T18:00:00'))).toBe(false);
    expect(isInsideWindow(at('2026-08-26T22:00:00'))).toBe(false);
  });
});
