import type { BookChain } from './chains';
import { formatTime } from './format';

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

/** Slider positions index this list so the session gets finer clock steps. */
export const BOOK_TIME_STEPS: readonly number[] = (() => {
  const minutes: number[] = [];
  for (let minute = 0; minute <= 540; minute += 60) minutes.push(minute);
  minutes.push(590);
  for (let minute = 595; minute <= 1085; minute++) minutes.push(minute);
  for (let minute = 1090; minute <= 1140; minute += 5) minutes.push(minute);
  for (let minute = 1200; minute <= 1440; minute += 60) minutes.push(minute);
  return minutes;
})();

export function formatBookTime(minute: number): string {
  if (minute === 1440) return '00:00 +1';
  const hour = Math.floor(minute / 60);
  return `${String(hour).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`;
}

export interface BookTimeRange {
  from: number;
  to: number;
}

export type BookTimeRangeEdge = 'from' | 'to' | 'both';

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
  const start = BOOK_TIME_STEPS.indexOf(range.from);
  const end = BOOK_TIME_STEPS.indexOf(range.to);
  if (start < 0 || end < 0 || start > end) return null;
  const from = edge === 'to' ? start : start + by;
  const to = edge === 'from' ? end : end + by;
  if (from < 0 || to >= BOOK_TIME_STEPS.length || from > to) return null;
  return { from: BOOK_TIME_STEPS[from]!, to: BOOK_TIME_STEPS[to]! };
}

/**
 * Select whole chains by any chosen clock on any leg, including hidden canceled
 * legs. Dates stay the batch filter's concern. Both bounds include their whole
 * minute; the final midnight is also allowed to match the next day's 00:00.
 */
export function matchesBookTime(
  chain: BookChain,
  fields: ReadonlySet<BookTimeField>,
  from: number,
  to: number,
): boolean {
  if (!Number.isFinite(from) || !Number.isFinite(to) || from > to) return false;
  return chain.rows.some((row) => {
    for (const field of fields) {
      const timestamp = row[field];
      if (timestamp === null || !Number.isFinite(new Date(timestamp).getTime())) continue;
      const [hour, minute] = formatTime(timestamp).split(':').map(Number);
      const clockMinute = hour! * 60 + minute!;
      if (clockMinute >= from && clockMinute <= to) return true;
      if (clockMinute === 0 && to === 1440) return true;
    }
    return false;
  });
}
