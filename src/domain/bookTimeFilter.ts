import type { BookChain, BookChainRow } from './chains';
import { formatTime } from './format';
import { CLOSE_MINUTE, CLOSING_MATCH_OFFSET_MINUTES, OPENING_MATCH_MINUTE } from './sessionHours';

/** The same clocks, in the same order, as the Book's time columns. */
export const BOOK_TIME_FIELDS = [
  { key: 'createdTime', label: 'created' },
  { key: 'scheduledTime', label: 'sched' },
  { key: 'intentTime', label: 'intent' },
  { key: 'sentTime', label: 'sent' },
  { key: 'orderTime', label: 'order' },
  { key: 'finalSeenTime', label: 'final' },
] as const;

export type BookTimeField = (typeof BOOK_TIME_FIELDS)[number]['key'];

/**
 * Slider positions index this list so the session gets finer clock steps: every minute from the
 * opening match through the closing match (09:55 → 18:05).
 */
export const BOOK_TIME_STEPS: readonly number[] = (() => {
  const sessionFrom = OPENING_MATCH_MINUTE;
  const sessionTo = CLOSE_MINUTE + CLOSING_MATCH_OFFSET_MINUTES;
  const minutes: number[] = [];
  for (let minute = 0; minute <= 540; minute += 60) minutes.push(minute);
  minutes.push(sessionFrom - 5);
  for (let minute = sessionFrom; minute <= sessionTo; minute++) minutes.push(minute);
  for (let minute = sessionTo + 5; minute <= 1140; minute += 5) minutes.push(minute);
  for (let minute = 1200; minute <= 1380; minute += 60) minutes.push(minute);
  minutes.push(1439);
  return minutes;
})();

export function formatBookTime(minute: number): string {
  const hour = Math.floor(minute / 60);
  return `${String(hour).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`;
}

function isBookMinute(minute: number): boolean {
  return Number.isInteger(minute) && minute >= 0 && minute <= 1439;
}

/** Four digits may name any minute; minute 60 carries into the next hour. */
export function parseBookTimeInput(digits: string): number | null {
  if (digits.length !== 4 || !/^\d{4}$/.test(digits)) return null;
  const hour = Number(digits.slice(0, 2));
  const minute = Number(digits.slice(2));
  const clockMinute = hour * 60 + minute;
  return hour <= 23 && minute <= 60 && isBookMinute(clockMinute) ? clockMinute : null;
}

export interface BookTimeRange {
  from: number;
  to: number;
}

/** Keep manually entered minutes on the same scale for both sliders and buttons. */
export function bookTimeSliderSteps(range: BookTimeRange): readonly number[] {
  if (!isBookMinute(range.from) || !isBookMinute(range.to)) return BOOK_TIME_STEPS;
  if (BOOK_TIME_STEPS.includes(range.from) && BOOK_TIME_STEPS.includes(range.to)) {
    return BOOK_TIME_STEPS;
  }
  return [...new Set([...BOOK_TIME_STEPS, range.from, range.to])].sort((a, b) => a - b);
}

export type BookTimeRangeEdge = 'from' | 'to' | 'both';

/**
 * Which of a chain's legs the time filter reads. `buys` and `sells` are an OR —
 * a chain matches on any leg whose side is still ticked — while `includeCanceled`
 * is an AND laid over both: a canceled leg is read only when it is on and its own
 * side is ticked too. All three are their own controls; `all` / `none` never
 * touch them. Default is both sides on and canceled legs left out.
 */
export interface BookTimeSides {
  buys: boolean;
  sells: boolean;
  includeCanceled: boolean;
}

export const BOOK_TIME_SIDES_DEFAULT: BookTimeSides = {
  buys: true,
  sells: true,
  includeCanceled: false,
};

/**
 * Like the batch range, walk positions in the allowed stops. A whole-window
 * step keeps its width in stops; a step past either bound or the other edge
 * is unavailable, so its button is disabled rather than shortening the step.
 */
export function stepBookTimeRange(
  range: BookTimeRange,
  edge: BookTimeRangeEdge,
  by: 1 | -1,
): BookTimeRange | null {
  if (!isBookMinute(range.from) || !isBookMinute(range.to)) return null;
  const steps = bookTimeSliderSteps(range);
  const start = steps.indexOf(range.from);
  const end = steps.indexOf(range.to);
  if (start < 0 || end < 0 || start > end) return null;
  const from = edge === 'to' ? start : start + by;
  const to = edge === 'from' ? end : end + by;
  if (from < 0 || to >= steps.length || from > to) return null;
  return { from: steps[from]!, to: steps[to]! };
}

/**
 * Select whole chains by any chosen clock on any leg. `sides` narrows which legs
 * count: a buy leg only while `buys` is on, a sell leg only while `sells` is on,
 * and a canceled leg only while `includeCanceled` is on and its own side is too.
 * Dates stay the batch filter's concern. Both bounds include their whole minute,
 * including the final 23:59 minute without wrapping into midnight.
 */
export function matchesBookTime(
  chain: BookChain,
  fields: ReadonlySet<BookTimeField>,
  from: number,
  to: number,
  sides: BookTimeSides,
): boolean {
  return chain.rows.some((row) => rowMatchesBookTime(row, fields, from, to, sides));
}

/**
 * The same test for one leg: a leg the sides read that carries a chosen clock
 * inside the range. `matchesBookTime` keeps a chain on any such leg; the Book's
 * `matching orders only` draws just the legs that pass it.
 */
export function rowMatchesBookTime(
  row: BookChainRow,
  fields: ReadonlySet<BookTimeField>,
  from: number,
  to: number,
  sides: BookTimeSides,
): boolean {
  if (!isBookMinute(from) || !isBookMinute(to) || from > to) return false;
  if (row.source === 'canceled' && !sides.includeCanceled) return false;
  if (row.direction === 'buy' ? !sides.buys : !sides.sells) return false;
  for (const field of fields) {
    const timestamp = row[field];
    if (timestamp === null || !Number.isFinite(new Date(timestamp).getTime())) continue;
    const [hour, minute] = formatTime(timestamp).split(':').map(Number);
    const clockMinute = hour! * 60 + minute!;
    if (clockMinute >= from && clockMinute <= to) return true;
  }
  return false;
}
