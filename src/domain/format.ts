const TIME_ZONE = 'Europe/Istanbul';

const numberFormatters = new Map<string, Intl.NumberFormat>();

function numberFormatter(
  decimals: number,
  sign: 'always' | 'exceptZero' | 'auto',
): Intl.NumberFormat {
  const key = `${decimals}:${sign}`;
  const cached = numberFormatters.get(key);
  if (cached) return cached;
  const formatter = new Intl.NumberFormat('tr-TR', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
    signDisplay: sign,
    useGrouping: true,
  });
  numberFormatters.set(key, formatter);
  return formatter;
}

function trueMinus(value: string): string {
  return value.replace('-', '−');
}

export function formatNumber(value: number, decimals = 2): string {
  return trueMinus(numberFormatter(decimals, 'auto').format(value));
}

export function formatSignedNumber(value: number, decimals = 2): string {
  return trueMinus(numberFormatter(decimals, 'always').format(value));
}

export function formatPercentage(value: number, decimals = 2, signed = true): string {
  return `${signed ? formatSignedNumber(value, decimals) : formatNumber(value, decimals)}%`;
}

/**
 * Slip is a direction, so a zero carries no sign — a `+0,00%` claims the price
 * moved up when it did not move at all. Two decimals, because the figures it
 * reports live in the second one (`+0,10%`, `−0,16%`).
 */
export function formatSlip(value: number): string {
  return `${trueMinus(numberFormatter(2, 'exceptZero').format(value))}%`;
}

export function formatQuantity(value: number): string {
  return formatNumber(value, 0);
}

/*
 * Building an `Intl.DateTimeFormat` costs far more than using one, and the Book
 * formats two stamps per row and a weekday per batch. Both are built once, the
 * way the number formatters above already are.
 */
const stampFormatter = new Intl.DateTimeFormat('en-GB', {
  timeZone: TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
});

const weekdayFormatter = new Intl.DateTimeFormat('en-GB', {
  timeZone: TIME_ZONE,
  weekday: 'long',
});

function dateParts(timestamp: number): Record<string, string> {
  return Object.fromEntries(
    stampFormatter
      .formatToParts(timestamp)
      .filter((part) => part.type !== 'literal')
      .map((part) => [part.type, part.value]),
  );
}

export function toIstanbulDateKey(timestamp: number): string {
  const parts = dateParts(timestamp);
  return `${parts.year}-${parts.month}-${parts.day}`;
}

export function formatDateKey(dateKey: string): string {
  const [year, month, day] = dateKey.split('-');
  return `${day}.${month}.${year.slice(-2)}`;
}

/**
 * The batch heading names its weekday: the reference reads `batch . friday`,
 * and the day of the week is what tells a reader which session they are on.
 */
export function weekdayName(dateKey: string): string {
  const timestamp = Date.parse(`${dateKey}T12:00:00+03:00`);
  if (!Number.isFinite(timestamp)) return '';
  return weekdayFormatter.format(timestamp);
}

export function formatDate(timestamp: number): string {
  return formatDateKey(toIstanbulDateKey(timestamp));
}

export function formatTime(timestamp: number): string {
  const parts = dateParts(timestamp);
  return `${parts.hour}:${parts.minute}`;
}

/**
 * A row time is read as a minute and settled by its seconds: two orders in the
 * same minute are only told apart by them. So the two are returned separately —
 * the caller that can draw the seconds quieter does, and one that cannot (plain
 * text) joins them or drops them.
 */
export function formatRowTimeParts(
  timestamp: number | null,
  batchDate: string,
): { minute: string; seconds: string } | null {
  if (timestamp === null) return null;
  const parts = dateParts(timestamp);
  const day = toIstanbulDateKey(timestamp) === batchDate ? '' : `${parts.day}.${parts.month} `;
  return { minute: `${day}${parts.hour}:${parts.minute}`, seconds: `:${parts.second}` };
}

export function formatRowTime(timestamp: number | null, batchDate: string): string | null {
  return formatRowTimeParts(timestamp, batchDate)?.minute ?? null;
}

export function formatRelativeAge(timestamp: number | null, now = Date.now()): string {
  if (timestamp === null) return 'Never updated';
  const elapsed = Math.max(0, now - timestamp);
  if (elapsed < 60_000) return 'Less than a minute ago';
  const minutes = Math.floor(elapsed / 60_000);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}

export function formatCompactDuration(milliseconds: number): string {
  const totalMinutes = Math.max(0, Math.floor(milliseconds / 60_000));
  const days = Math.floor(totalMinutes / (24 * 60));
  const hours = Math.floor((totalMinutes % (24 * 60)) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) return `${days}d${hours > 0 ? ` ${hours}h` : ''}`;
  if (hours > 0) return `${hours}h${minutes > 0 ? ` ${minutes}m` : ''}`;
  return `${minutes}m`;
}

export function formatScheduledDistance(timestamp: number, now = Date.now()): string {
  if (timestamp <= now) return 'due';
  return `in ${formatCompactDuration(timestamp - now)}`;
}

export function startOfIstanbulDay(timestamp = Date.now()): number {
  const key = toIstanbulDateKey(timestamp);
  return Date.parse(`${key}T00:00:00+03:00`);
}

export function nextIstanbulDayStart(timestamp = Date.now()): number {
  return startOfIstanbulDay(timestamp) + 24 * 60 * 60 * 1_000;
}

export function parseTurkishNumber(raw: string): number | null {
  const candidate = raw.trim().replace('−', '-');
  if (!candidate) return null;
  const [integer, fraction, ...extra] = candidate.split(',');
  if (extra.length > 0 || integer === undefined) return null;
  if (!/^[+-]?(?:\d+|\d{1,3}(?:\.\d{3})+)$/.test(integer)) return null;
  if (fraction !== undefined && !/^\d+$/.test(fraction)) return null;
  const normalized = `${integer.replaceAll('.', '')}${
    fraction === undefined ? '' : `.${fraction}`
  }`;
  const value = Number(normalized);
  return Number.isFinite(value) ? value : null;
}

/**
 * Counted labels read as prose, so a count of one takes the singular noun.
 * `plural(1, 'chain')` is `1 chain`; `plural(0, 'chain')` is `0 chains`.
 */
export function plural(count: number, one: string, many = `${one}s`): string {
  return `${formatQuantity(count)} ${count === 1 ? one : many}`;
}
