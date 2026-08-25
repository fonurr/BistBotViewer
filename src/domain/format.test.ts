import {
  formatDate,
  formatNumber,
  formatPercentage,
  formatRelativeAge,
  formatRowTime,
  formatSignedNumber,
  parseTurkishNumber,
  toIstanbulDateKey,
} from './format';

describe('Turkish presentation formatting', () => {
  it('uses Turkish grouping, decimal commas, and a true minus', () => {
    expect(formatNumber(9315.5, 2)).toBe('9.315,50');
    expect(formatSignedNumber(31204.8, 2)).toBe('+31.204,80');
    expect(formatSignedNumber(-1428, 2)).toBe('−1.428,00');
    expect(formatPercentage(1.9)).toBe('+1,9%');
  });

  it('formats dates and suppresses the batch day in row times', () => {
    const timestamp = Date.parse('2026-08-15T06:41:00Z');
    expect(toIstanbulDateKey(timestamp)).toBe('2026-08-15');
    expect(formatDate(timestamp)).toBe('15.08.26');
    expect(formatRowTime(timestamp, '2026-08-15')).toBe('09:41');
    expect(formatRowTime(timestamp, '2026-08-14')).toBe('15.08 09:41');
  });

  it('uses the fixed relative-age vocabulary', () => {
    const now = Date.parse('2026-08-25T12:00:00Z');
    expect(formatRelativeAge(now - 30_000, now)).toBe('Less than a minute ago');
    expect(formatRelativeAge(now - 120_000, now)).toBe('2 minutes ago');
    expect(formatRelativeAge(now - 3_600_000, now)).toBe('1 hour ago');
  });

  it('parses Turkish input without treating blank as zero', () => {
    expect(parseTurkishNumber('9.315,50')).toBe(9315.5);
    expect(parseTurkishNumber('38,16')).toBe(38.16);
    expect(parseTurkishNumber('100.000')).toBe(100_000);
    expect(parseTurkishNumber('38.16')).toBeNull();
    expect(parseTurkishNumber('')).toBeNull();
  });
});
