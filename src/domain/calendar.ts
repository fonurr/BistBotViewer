import type { Holiday } from '../bistApi/types';

export interface TradingDayCount {
  known: boolean;
  days: number | null;
  halfDays: number;
}

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
