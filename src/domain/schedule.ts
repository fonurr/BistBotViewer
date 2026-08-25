import type { Holiday, ScheduleType } from '../bistApi/types';

const DAY_MS = 86_400_000;
const MAX_DAYS_AHEAD = 366;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

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
  const dayEpoch = realIsoDateEpoch(input.day);
  if (dayEpoch === null) return invalid('Choose a real date in YYYY-MM-DD form.');

  const needsDiff = input.type === 'AfterOpen' || input.type === 'BeforeClose';
  if (needsDiff && (input.diff === undefined || !Number.isFinite(input.diff) || input.diff < 0)) {
    return invalid('The selected moment requires a finite, non-negative difference.');
  }

  const holidayByDay = new Map(holidays.map((holiday) => [holiday.date, holiday.type]));
  let resolvedEpoch = dayEpoch;
  let rolled = 0;
  while (!isTradingDay(resolvedEpoch, holidayByDay)) {
    resolvedEpoch += DAY_MS;
    rolled += 1;
    if (rolled > MAX_DAYS_AHEAD) {
      return invalid('No trading day exists within one year of the requested day.');
    }
  }

  const resolvedDay = new Date(resolvedEpoch).toISOString().slice(0, 10);
  const closeMinute = holidayByDay.get(resolvedDay) === 'half' ? 12 * 60 + 30 : 18 * 60;
  const closeAt = istanbulMinuteAt(resolvedDay, closeMinute);
  let fireTime: number;

  switch (input.type) {
    case 'OpeningAuction':
      fireTime = istanbulMinuteAt(resolvedDay, 9 * 60);
      break;
    case 'AtOpen':
      fireTime = istanbulMinuteAt(resolvedDay, 9 * 60 + 55) + 30_000;
      break;
    case 'AfterOpen':
      fireTime = istanbulMinuteAt(resolvedDay, 10 * 60 + input.diff!);
      if (fireTime >= closeAt) {
        return invalid(`The resolved time is not before the ${resolvedDay} session close.`);
      }
      break;
    case 'BeforeClose':
      fireTime = istanbulMinuteAt(resolvedDay, closeMinute - input.diff!);
      if (fireTime < istanbulMinuteAt(resolvedDay, 9 * 60)) {
        return invalid(`The resolved time is before 09:00 on ${resolvedDay}.`);
      }
      break;
    case 'ClosingAuction':
      fireTime = closeAt + 30_000;
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

function isTradingDay(epoch: number, holidays: ReadonlyMap<string, Holiday['type']>): boolean {
  const weekday = new Date(epoch).getUTCDay();
  const day = new Date(epoch).toISOString().slice(0, 10);
  return weekday !== 0 && weekday !== 6 && holidays.get(day) !== 'full';
}

function istanbulMinuteAt(day: string, minute: number): number {
  const start = Date.parse(`${day}T00:00:00+03:00`);
  return Math.round((start + minute * 60_000) / 1000) * 1000;
}
