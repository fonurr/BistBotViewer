import type { Holiday } from '../bistApi/types';

const DAY_MS = 86_400_000;
const MAX_DAYS_AHEAD = 366;
/** The close: 18:00, or 12:30 on a half day, which only moves the close. */
const CLOSE_MINUTE = 18 * 60;
const HALF_DAY_CLOSE_MINUTE = 12 * 60 + 30;
/** A session keeps the work written for it until ten minutes past its close. */
const SESSION_GRACE_MINUTES = 10;

export interface TradingDayCount {
  known: boolean;
  days: number | null;
  halfDays: number;
}

export type HolidayCalendar = ReadonlyMap<string, Holiday['type']>;

export function holidayCalendar(holidays: readonly Holiday[]): HolidayCalendar {
  return new Map(holidays.map((holiday) => [holiday.date, holiday.type]));
}

/** The Istanbul day an epoch falls on, in an ISO form that sorts chronologically. */
export function istanbulDay(timestamp: number): string | null {
  if (!Number.isFinite(timestamp)) return null;
  const parts = istanbulDateFormatter.formatToParts(new Date(timestamp));
  const year = parts.find(({ type }) => type === 'year')?.value;
  const month = parts.find(({ type }) => type === 'month')?.value;
  const day = parts.find(({ type }) => type === 'day')?.value;
  return year !== undefined && month !== undefined && day !== undefined
    ? `${year}-${month}-${day}`
    : null;
}

/**
 * A weekend is closed whatever the calendar says; a full holiday is closed only where the
 * calendar covers the day. An absent row is not proof that a weekday was open, so a missing
 * calendar degrades to weekends alone rather than inventing a session.
 */
export function isTradingDay(day: string, holidays: HolidayCalendar): boolean {
  const weekday = new Date(`${day}T00:00:00Z`).getUTCDay();
  return weekday !== 0 && weekday !== 6 && holidays.get(day) !== 'full';
}

/** The epoch of an Istanbul minute on one day, always a whole second. */
export function istanbulMinuteAt(day: string, minute: number): number {
  const start = Date.parse(`${day}T00:00:00+03:00`);
  return Math.round((start + minute * 60_000) / 1000) * 1000;
}

/** A half day only moves the close; it opens like any other trading day. */
export function closeMinuteOn(day: string, holidays: HolidayCalendar): number {
  return holidays.get(day) === 'half' ? HALF_DAY_CLOSE_MINUTE : CLOSE_MINUTE;
}

/** The first trading day at or after `day`, or null when a year of them is closed. */
export function rollToTradingDay(day: string, holidays: HolidayCalendar): string | null {
  let cursor = day;
  for (let rolled = 0; rolled <= MAX_DAYS_AHEAD; rolled += 1) {
    if (isTradingDay(cursor, holidays)) return cursor;
    cursor = nextDay(cursor);
  }
  return null;
}

/**
 * The session an order stamped at this moment could reach — the batch it belongs to.
 *
 * The batch is not the clock day the order was written. An order written more than ten
 * minutes past the close (so after 18:10, or 12:40 on a half day), at the weekend, or on a
 * full holiday waits for the next trading day and is that day's business, which is where a
 * batch heading has to file it.
 */
export function sessionBatchDate(
  timestamp: number | null,
  holidays: HolidayCalendar,
): string | null {
  if (timestamp === null) return null;
  const stamped = istanbulDay(timestamp);
  if (stamped === null) return null;

  // A calendar that closes a year of days says nothing usable, and the stamped day is then
  // the only thing the record still supports.
  if (!isTradingDay(stamped, holidays)) return rollToTradingDay(stamped, holidays) ?? stamped;

  const lastMoment = istanbulMinuteAt(
    stamped,
    closeMinuteOn(stamped, holidays) + SESSION_GRACE_MINUTES,
  );
  if (timestamp <= lastMoment) return stamped;
  return rollToTradingDay(nextDay(stamped), holidays) ?? stamped;
}

function nextDay(day: string): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + DAY_MS).toISOString().slice(0, 10);
}

const istanbulDateFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Europe/Istanbul',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

function datesBetween(from: string, to: string): string[] {
  const dates: string[] = [];
  for (
    let cursor = Date.parse(`${from}T00:00:00Z`), end = Date.parse(`${to}T00:00:00Z`);
    cursor <= end;
    cursor += 86_400_000
  ) {
    dates.push(new Date(cursor).toISOString().slice(0, 10));
  }
  return dates;
}

export function countTradingDays(
  from: string,
  to: string,
  holidays: readonly Holiday[],
): TradingDayCount {
  if (holidays.length === 0) return { known: false, days: null, halfDays: 0 };
  const sorted = [...holidays].sort((left, right) => left.date.localeCompare(right.date));
  // The API exposes no explicit coverage bounds. Outside the observed calendar extent, absence of
  // a row cannot prove a weekday was open.
  if (from < sorted[0].date || to > sorted.at(-1)!.date) {
    return { known: false, days: null, halfDays: 0 };
  }

  const holidayMap = new Map(sorted.map((holiday) => [holiday.date, holiday.type]));
  let days = 0;
  let halfDays = 0;
  for (const date of datesBetween(from, to)) {
    const weekday = new Date(`${date}T00:00:00Z`).getUTCDay();
    if (weekday === 0 || weekday === 6) continue;
    const type = holidayMap.get(date);
    if (type === 'full') continue;
    days += 1;
    if (type === 'half') halfDays += 1;
  }
  return { known: true, days, halfDays };
}
