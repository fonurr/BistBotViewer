import type { Holiday, ScheduleType } from '../bistApi/types';
import { closeMinuteOn, holidayCalendar, istanbulMinuteAt, rollToTradingDay } from './calendar';
import { CONTINUOUS_OPEN_MINUTE, OPENING_MATCH_MINUTE } from './sessionHours';

const DAY_MS = 86_400_000;
const MAX_DAYS_AHEAD = 366;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
/*
 * MatriksOrder's own send times rather than exchange hours (its `src/orders/schedule.ts`):
 * `OpeningAuction` goes out at 09:00, the day's earliest legal send, and `AtOpen` and
 * `ClosingAuction` thirty seconds past the opening match and the close respectively.
 */
const PRE_OPEN_SEND_MINUTE = 9 * 60;
const POST_OPENING_MATCH_DELAY_MS = 30_000;
const CLOSING_AUCTION_DELAY_MS = 30_000;

export interface ScheduleInput {
  day: string;
  type: ScheduleType;
  diff?: number;
}

export type ResolvedSchedule =
  { ok: true; fireTime: number; resolvedDay: string } | { ok: false; error: string };

/**
 * Browser-side mirror of MatriksOrder's schedule resolver. This is a refusal aid,
 * not an alternate source of truth: the API resolves and validates the same spec again.
 */
export function resolveSchedule(
  input: ScheduleInput,
  holidays: readonly Holiday[],
  nowMs = Date.now(),
): ResolvedSchedule {
  if (realIsoDateEpoch(input.day) === null) {
    return invalid('Choose a real date in YYYY-MM-DD form.');
  }

  const needsDiff = input.type === 'AfterOpen' || input.type === 'BeforeClose';
  if (needsDiff && (input.diff === undefined || !Number.isFinite(input.diff) || input.diff < 0)) {
    return invalid('The selected moment requires a finite, non-negative difference.');
  }

  const calendar = holidayCalendar(holidays);
  const resolvedDay = rollToTradingDay(input.day, calendar);
  if (resolvedDay === null) {
    return invalid('No trading day exists within one year of the requested day.');
  }

  const closeMinute = closeMinuteOn(resolvedDay, calendar);
  const closeAt = istanbulMinuteAt(resolvedDay, closeMinute);
  let fireTime: number;

  switch (input.type) {
    case 'OpeningAuction':
      fireTime = istanbulMinuteAt(resolvedDay, PRE_OPEN_SEND_MINUTE);
      break;
    case 'AtOpen':
      fireTime = istanbulMinuteAt(resolvedDay, OPENING_MATCH_MINUTE) + POST_OPENING_MATCH_DELAY_MS;
      break;
    case 'AfterOpen':
      fireTime = istanbulMinuteAt(resolvedDay, CONTINUOUS_OPEN_MINUTE + input.diff!);
      if (fireTime >= closeAt) {
        return invalid(`The resolved time is not before the ${resolvedDay} session close.`);
      }
      break;
    case 'BeforeClose':
      fireTime = istanbulMinuteAt(resolvedDay, closeMinute - input.diff!);
      if (fireTime < istanbulMinuteAt(resolvedDay, PRE_OPEN_SEND_MINUTE)) {
        return invalid(`The resolved time is before 09:00 on ${resolvedDay}.`);
      }
      break;
    case 'ClosingAuction':
      fireTime = closeAt + CLOSING_AUCTION_DELAY_MS;
      break;
  }

  if (fireTime <= nowMs) return invalid(`The resolved time on ${resolvedDay} is in the past.`);
  if (fireTime - nowMs > MAX_DAYS_AHEAD * DAY_MS) {
    return invalid(`The resolved time on ${resolvedDay} is more than one year away.`);
  }
  return { ok: true, fireTime, resolvedDay };
}

function invalid(error: string): ResolvedSchedule {
  return { ok: false, error };
}

function realIsoDateEpoch(day: string): number | null {
  if (!ISO_DATE.test(day)) return null;
  const [year, month, date] = day.split('-').map(Number);
  const epoch = Date.UTC(year!, month! - 1, date!, 9);
  const roundTrip = new Date(epoch).toISOString().slice(0, 10);
  return roundTrip === day ? epoch : null;
}
