import { sessionBatchDate, tradingDaysBetween, type HolidayCalendar } from './calendar';

/**
 * How a batch range is read. `batch` — what both pages open on — keeps what was filed under a
 * session inside it: the session its opening order belongs to. `active` keeps whatever was alive
 * on any session inside it, whether it opened before the range, is still open after it, or both —
 * so a position bought last week and still held is in a range of today alone.
 */
export type BatchRangeBasis = 'batch' | 'active';

/**
 * The sessions one chain or round trip was alive in, as batch dates: from the batch it was filed
 * under through the session of the newest thing it recorded. `through` is `null` while it is still
 * alive — holding shares, or with an order still working — since nothing yet says when it ends.
 */
export interface ActiveSpan {
  readonly batch: string;
  readonly through: string | null;
}

export interface BatchRangeBounds {
  readonly from: string | null;
  readonly to: string | null;
}

/**
 * Whether a span belongs in a range read on this basis, both ends inclusive and either unset. A
 * span always holds its own batch, so whatever `batch` keeps, `active` keeps too; a span still
 * alive reaches every range that starts on or after its batch.
 */
export function withinBatchRange(
  span: ActiveSpan,
  range: BatchRangeBounds,
  basis: BatchRangeBasis,
): boolean {
  if (range.to !== null && span.batch > range.to) return false;
  if (range.from === null || span.batch >= range.from) return true;
  return basis === 'active' && (span.through === null || span.through >= range.from);
}

/**
 * The session of the newest stamp given, never before `batch` — where a finished span ends. The
 * batch rule applies to it like to any stamp: a cancel written past the close is the next
 * session's business. A missing stamp is skipped, and with none at all the span ends where it began.
 */
export function lastActiveSession(
  batch: string,
  stamps: readonly (number | null | undefined)[],
  holidays: HolidayCalendar,
): string {
  let newest: number | null = null;
  for (const stamp of stamps) {
    if (stamp === null || stamp === undefined || !Number.isFinite(stamp)) continue;
    if (newest === null || stamp > newest) newest = stamp;
  }
  const session = sessionBatchDate(newest, holidays);
  return session !== null && session > batch ? session : batch;
}

/**
 * Every session some span was alive in, ascending — the days an `active` range can be set to. A
 * span still alive runs through `currentSession`, or through its own batch where that is later (a
 * schedule aimed past the session being worked). Each span's batch is always in, whatever the
 * calendar says about it.
 */
export function activeSessionDates(
  spans: readonly ActiveSpan[],
  currentSession: string,
  holidays: HolidayCalendar,
): string[] {
  const intervals = spans
    .map((span) => {
      const end = span.through ?? currentSession;
      return { from: span.batch, to: end > span.batch ? end : span.batch };
    })
    .sort((left, right) => (left.from < right.from ? -1 : left.from > right.from ? 1 : 0));
  // Merged first, so a year of overlapping spans walks each calendar day once.
  const merged: { from: string; to: string }[] = [];
  for (const interval of intervals) {
    const last = merged.at(-1);
    if (last !== undefined && interval.from <= last.to) {
      if (interval.to > last.to) last.to = interval.to;
    } else {
      merged.push({ ...interval });
    }
  }
  const days = new Set(spans.map((span) => span.batch));
  for (const { from, to } of merged) {
    for (const day of tradingDaysBetween(from, to, holidays)) days.add(day);
  }
  return [...days].sort();
}
