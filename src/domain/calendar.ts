import type { Holiday } from '../bistApi/types';
import {
  CLOSE_MINUTE,
  CLOSING_MATCH_OFFSET_MINUTES,
  CONTINUOUS_OPEN_MINUTE,
  HALF_DAY_CLOSE_MINUTE,
  OPENING_MATCH_MINUTE,
  POST_MATCH_RESUME_OFFSET_MINUTES,
  SESSION_GRACE_MINUTES,
} from './sessionHours';

const DAY_MS = 86_400_000;
const MAX_DAYS_AHEAD = 366;
/*
 * The exchange's own hours live in `sessionHours.ts`. The two below are DailyDataAggregator's
 * producer schedule, so they stay with the only rules that read them.
 */
/**
 * The closing auction runs for fifteen minutes past the close (18:15, or 12:45 on a half day) and
 * DailyDataAggregator's producer exits with it, so this is the last minute a price can be live.
 */
const AUCTION_TAIL_MINUTES = 15;
/** The producer's scheduled start; it answers before its first tick, saying the feed is starting. */
const PRODUCER_START_MINUTE = 9 * 60 + 35;

export interface SessionWindow {
  /** The first moment DailyDataAggregator is expected to answer at all. */
  producerStart: number;
  /** The first moment a silent feed is a fault rather than a closed market. */
  liveStart: number;
  /** The last moment of the closing auction, after which the producer exits. */
  end: number;
}

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
 * The trading day immediately before `day`, or null when a year back is closed. Used to name the
 * session whose closing auction is the overnight reference for a position carried into `day`.
 */
export function previousTradingDate(day: string, holidays: HolidayCalendar): string | null {
  let cursor = previousDay(day);
  for (let rolled = 0; rolled <= MAX_DAYS_AHEAD; rolled += 1) {
    if (isTradingDay(cursor, holidays)) return cursor;
    cursor = previousDay(cursor);
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

/**
 * The first instant an order stamped at `timestamp` could have traded — MatriksOrder's "which
 * session an order belongs to" table. An off-hours or pre-open stamp folds forward to the next
 * real trading window; a stamp inside continuous trading is its own first chance. `null` when the
 * timestamp is unusable or a year of trading days ahead is closed. The Istanbul date of the
 * result is the order's trade date, and it always agrees with `sessionBatchDate`.
 */
export function firstTradeInstant(
  timestamp: number | null,
  holidays: HolidayCalendar,
): number | null {
  if (timestamp === null || !Number.isFinite(timestamp)) return null;
  const day = istanbulDay(timestamp);
  if (day === null) return null;

  if (isTradingDay(day, holidays)) {
    const closeMinute = closeMinuteOn(day, holidays);
    const match = istanbulMinuteAt(day, OPENING_MATCH_MINUTE);
    const open = istanbulMinuteAt(day, CONTINUOUS_OPEN_MINUTE);
    const close = istanbulMinuteAt(day, closeMinute);
    const closingMatch = istanbulMinuteAt(day, closeMinute + CLOSING_MATCH_OFFSET_MINUTES);
    const resume = istanbulMinuteAt(day, closeMinute + POST_MATCH_RESUME_OFFSET_MINUTES);
    const sessionEnd = istanbulMinuteAt(day, closeMinute + SESSION_GRACE_MINUTES);

    if (timestamp < match) return match; // before the auction → today's own match
    if (timestamp < open) return open; // in the auction → the continuous open
    if (timestamp < close) return timestamp; // trading hours → its own instant
    if (timestamp < closingMatch) return closingMatch; // just past the close → the closing auction
    if (timestamp < resume) return resume;
    if (timestamp < sessionEnd) return timestamp;
    // T ≥ close+10 min → the next trading day's match, handled below.
  }

  const nextTradingDay = rollToTradingDay(
    isTradingDay(day, holidays) ? nextDay(day) : day,
    holidays,
  );
  return nextTradingDay === null ? null : istanbulMinuteAt(nextTradingDay, OPENING_MATCH_MINUTE);
}

export interface ContinuousTrading {
  /** The continuous open, 10:00. */
  open: number;
  /** The close: 18:00, or 12:30 on a half day. */
  close: number;
}

/**
 * Continuous trading on one day, as the instants of its two edges, or null when the exchange is
 * shut. Whether an edge itself counts is the caller's call.
 */
export function continuousTradingOn(
  day: string,
  holidays: HolidayCalendar,
): ContinuousTrading | null {
  if (!isTradingDay(day, holidays)) return null;
  return {
    open: istanbulMinuteAt(day, CONTINUOUS_OPEN_MINUTE),
    close: istanbulMinuteAt(day, closeMinuteOn(day, holidays)),
  };
}

/**
 * The price window of one day, or null when the exchange is shut. A half day needs no branch of
 * its own: it only moves the close, and both boundaries are read off it.
 */
export function sessionWindowOn(day: string, holidays: HolidayCalendar): SessionWindow | null {
  if (!isTradingDay(day, holidays)) return null;
  const close = closeMinuteOn(day, holidays);
  return {
    producerStart: istanbulMinuteAt(day, PRODUCER_START_MINUTE),
    liveStart: istanbulMinuteAt(day, CONTINUOUS_OPEN_MINUTE),
    end: istanbulMinuteAt(day, close + AUCTION_TAIL_MINUTES),
  };
}

/**
 * Whether DailyDataAggregator should be answering at all. Outside this the producer has exited and
 * every request is refused, so the viewer stops asking rather than failing once a minute all night.
 */
export function isProducerExpectedUp(timestamp: number, holidays: HolidayCalendar): boolean {
  const day = istanbulDay(timestamp);
  if (day === null) return false;
  const window = sessionWindowOn(day, holidays);
  return window !== null && timestamp >= window.producerStart && timestamp <= window.end;
}

/**
 * Whether a live price is owed. Between the producer's start and the continuous open there is
 * nothing to trade, so a silent feed there is the market being shut, not a fault worth colouring.
 */
export function areLivePricesExpected(timestamp: number, holidays: HolidayCalendar): boolean {
  const day = istanbulDay(timestamp);
  if (day === null) return false;
  const window = sessionWindowOn(day, holidays);
  return window !== null && timestamp >= window.liveStart && timestamp <= window.end;
}

/**
 * The most recent session whose closing auction has finished, which is the newest close the stored
 * bars can be expected to hold. Null when a year back is closed or the calendar is unusable.
 */
export function lastCompletedSessionDate(
  timestamp: number,
  holidays: HolidayCalendar,
): string | null {
  let day = istanbulDay(timestamp);
  if (day === null) return null;
  for (let rolled = 0; rolled <= MAX_DAYS_AHEAD; rolled += 1) {
    const window = sessionWindowOn(day, holidays);
    if (window !== null && timestamp >= window.end) return day;
    day = previousDay(day);
  }
  return null;
}

function nextDay(day: string): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + DAY_MS).toISOString().slice(0, 10);
}

function previousDay(day: string): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) - DAY_MS).toISOString().slice(0, 10);
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
