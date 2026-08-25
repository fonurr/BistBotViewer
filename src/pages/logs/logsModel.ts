import type {
  ApiLogRow,
  ErrorLogRow,
  LogExtent,
  LogExtents,
  LogSource,
  StoredErrorType,
  TrafficLogType,
  WireLogRow,
} from '../../bistApi/logTypes';

export type LogsTab = LogSource;
export type SortDirection = 'ascending' | 'descending';

export interface LogRange {
  from: string;
  to: string;
}

export type LogEnvelope =
  | { source: 'errors'; row: ErrorLogRow }
  | { source: 'wire'; row: WireLogRow }
  | { source: 'api'; row: ApiLogRow };

export interface LogColumn {
  key: string;
  label: string;
  defaultWidth: number;
  value: (entry: LogEnvelope) => unknown;
  format?: 'timestamp' | 'integer' | 'payload';
}

export const LOG_TABS: readonly { key: LogsTab; label: string }[] = [
  { key: 'errors', label: 'Errors' },
  { key: 'wire', label: 'Wire log' },
  { key: 'api', label: 'API log' },
];

export const ERROR_TYPES: readonly StoredErrorType[] = [
  'MatriksConnectionError',
  'MatriksFieldNotFound',
  'Unspecified',
  'BarsDataError',
  'AccountNotFound',
  'AccountInformationUnavailable',
  'AccountFeedSilent',
  'OrderAccountMismatch',
];

export const TRAFFIC_TYPES: readonly TrafficLogType[] = [
  'routine',
  'action',
  'unexpected',
  'error',
];

const DAY_MS = 86_400_000;
const ISTANBUL_OFFSET = '+03:00';
const numericCollator = new Intl.Collator('tr-TR', {
  numeric: true,
  sensitivity: 'base',
});
const integerFormatter = new Intl.NumberFormat('tr-TR', {
  maximumFractionDigits: 0,
});

function rawValue(entry: LogEnvelope, key: string): unknown {
  return (entry.row as unknown as Record<string, unknown>)[key];
}

function rawColumn(
  key: string,
  label: string,
  defaultWidth: number,
  format?: LogColumn['format'],
): LogColumn {
  return {
    key,
    label,
    defaultWidth,
    value: (entry) => rawValue(entry, key),
    format,
  };
}

const ERROR_COLUMNS: readonly LogColumn[] = [
  rawColumn('id', 'id', 72, 'integer'),
  rawColumn('time', 'time', 150, 'timestamp'),
  rawColumn('type', 'type', 202),
  rawColumn('information', 'information', 330),
  rawColumn('accountId', 'account id', 160),
  rawColumn('brokerageId', 'brokerage id', 160),
  rawColumn('context', 'context', 240),
];

const WIRE_COLUMNS: readonly LogColumn[] = [
  rawColumn('id', 'id', 72, 'integer'),
  rawColumn('at', 'time', 150, 'timestamp'),
  rawColumn('atText', 'Istanbul time', 188),
  rawColumn('target', 'target', 96),
  rawColumn('direction', 'direction', 92),
  rawColumn('type', 'type', 112),
  rawColumn('operation', 'operation', 190),
  rawColumn('apiCommand', 'API command', 116, 'integer'),
  rawColumn('ref', 'ref', 80, 'integer'),
  rawColumn('latencyMs', 'latency ms', 112, 'integer'),
  rawColumn('accountId', 'account id', 160),
  rawColumn('brokerageId', 'brokerage id', 160),
  rawColumn('symbol', 'symbol', 92),
  rawColumn('clientOrderId', 'client order id', 180),
  rawColumn('orderId', 'order id', 160),
  rawColumn('ordStatus', 'order status', 120),
  rawColumn('note', 'note', 260),
  rawColumn('body', 'payload', 320, 'payload'),
  rawColumn('truncated', 'truncated', 104, 'integer'),
];

const API_COLUMNS: readonly LogColumn[] = [
  rawColumn('id', 'id', 72, 'integer'),
  rawColumn('at', 'time', 150, 'timestamp'),
  rawColumn('atText', 'Istanbul time', 188),
  rawColumn('type', 'type', 112),
  rawColumn('method', 'method', 92),
  rawColumn('path', 'path', 220),
  rawColumn('botId', 'bot id', 180),
  rawColumn('status', 'status', 88, 'integer'),
  rawColumn('durationMs', 'duration ms', 116, 'integer'),
  rawColumn('requestBody', 'request payload', 300, 'payload'),
  rawColumn('responseBody', 'response payload', 300, 'payload'),
  rawColumn('errorType', 'error type', 180),
  rawColumn('note', 'note', 260),
  rawColumn('truncated', 'truncated', 104, 'integer'),
];

export function columnsFor(tab: LogsTab): readonly LogColumn[] {
  if (tab === 'errors') return ERROR_COLUMNS;
  if (tab === 'wire') return WIRE_COLUMNS;
  return API_COLUMNS;
}

export function timestampOf(entry: LogEnvelope): number {
  return entry.source === 'errors' ? entry.row.time : entry.row.at;
}

export function idOf(entry: LogEnvelope): number {
  return entry.row.id;
}

export function rowKey(entry: LogEnvelope): string {
  return `${entry.source}-${entry.row.id}`;
}

export function sourceLogName(source: LogSource): string {
  if (source === 'errors') return 'error log';
  if (source === 'wire') return 'wire log';
  return 'API log';
}

export function toIstanbulDateKey(timestamp: number): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Europe/Istanbul',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    })
      .formatToParts(timestamp)
      .filter((part) => part.type !== 'literal')
      .map((part) => [part.type, part.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day}`;
}

export function todayInIstanbul(now = Date.now()): string {
  return toIstanbulDateKey(now);
}

export function shiftDateKey(dateKey: string, days: number): string {
  const date = new Date(`${dateKey}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

export function rangeToMilliseconds(range: LogRange): {
  fromMs: number;
  untilMs: number;
} {
  return {
    fromMs: Date.parse(`${range.from}T00:00:00${ISTANBUL_OFFSET}`),
    untilMs: Date.parse(`${shiftDateKey(range.to, 1)}T00:00:00${ISTANBUL_OFFSET}`),
  };
}

export function formatDateKey(dateKey: string): string {
  const [year, month, day] = dateKey.split('-');
  return `${day}.${month}.${year.slice(-2)}`;
}

export function formatRange(range: LogRange): string {
  return range.from === range.to
    ? formatDateKey(range.from)
    : `${formatDateKey(range.from)} → ${formatDateKey(range.to)}`;
}

export function formatLogTimestamp(timestamp: number): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Europe/Istanbul',
      year: '2-digit',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(timestamp)
      .filter((part) => part.type !== 'literal')
      .map((part) => [part.type, part.value]),
  );
  return `${parts.day}.${parts.month}.${parts.year} ${parts.hour}:${parts.minute}:${parts.second}`;
}

export function extentForTab(extents: LogExtents, tab: LogsTab): LogExtent {
  return extents[tab];
}

export function extentDateBounds(extent: LogExtent): {
  min: string | null;
  max: string | null;
} {
  return {
    min: extent.minMs === null ? null : toIstanbulDateKey(extent.minMs),
    max: extent.maxMs === null ? null : toIstanbulDateKey(extent.maxMs),
  };
}

export function clampRangeToExtent(range: LogRange, extent: LogExtent): LogRange {
  const bounds = extentDateBounds(extent);
  if (!bounds.min || !bounds.max) return range;
  const from =
    range.from < bounds.min ? bounds.min : range.from > bounds.max ? bounds.max : range.from;
  const to = range.to < bounds.min ? bounds.min : range.to > bounds.max ? bounds.max : range.to;
  if (from > to) return { from, to: from };
  return { from, to };
}

export function rangeTriggerLabel(range: LogRange, extent: LogExtent, today: string): string {
  if (range.from === today && range.to === today) return 'Today';
  const bounds = extentDateBounds(extent);
  if (
    bounds.min !== null &&
    bounds.max !== null &&
    range.from === bounds.min &&
    range.to === bounds.max
  ) {
    return `Everything · ${formatRange(range)}`;
  }
  return formatRange(range);
}

export function nearestExtentDay(range: LogRange, extent: LogExtent): string | null {
  if (extent.minMs === null || extent.maxMs === null) return null;
  const bounds = extentDateBounds(extent);
  if (!bounds.min || !bounds.max) return null;
  if (range.to < bounds.min) return bounds.min;
  if (range.from > bounds.max) return bounds.max;
  return null;
}

export function searchableText(entry: LogEnvelope): string {
  return `${entry.source} ${JSON.stringify(entry.row)}`.toLocaleLowerCase('en-US');
}

export function filterLoadedRows(rows: readonly LogEnvelope[], search: string): LogEnvelope[] {
  const query = search.trim().toLocaleLowerCase('en-US');
  if (!query) return [...rows];
  return rows.filter((entry) => searchableText(entry).includes(query));
}

function comparable(value: unknown): string | number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return value;
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

export function sortRows(
  rows: readonly LogEnvelope[],
  column: LogColumn,
  direction: SortDirection,
): LogEnvelope[] {
  const factor = direction === 'ascending' ? 1 : -1;
  return [...rows].sort((left, right) => {
    const a = comparable(column.value(left));
    const b = comparable(column.value(right));
    if (a === null && b === null) return idOf(right) - idOf(left);
    if (a === null) return 1;
    if (b === null) return -1;
    const compared =
      typeof a === 'number' && typeof b === 'number'
        ? a - b
        : numericCollator.compare(String(a), String(b));
    if (compared !== 0) return compared * factor;
    const timeDifference = timestampOf(right) - timestampOf(left);
    if (timeDifference !== 0) return timeDifference;
    return idOf(right) - idOf(left);
  });
}

export function displayCellValue(value: unknown, format?: LogColumn['format']): string {
  if (value === null || value === undefined) return '';
  if (format === 'timestamp' && typeof value === 'number') {
    return formatLogTimestamp(value);
  }
  if (format === 'integer' && typeof value === 'number') {
    return integerFormatter.format(value);
  }
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

export function payloadText(value: unknown): string {
  if (typeof value === 'string') {
    try {
      return JSON.stringify(JSON.parse(value) as unknown, null, 2);
    } catch {
      return value;
    }
  }
  return JSON.stringify(value, null, 2);
}

export function payloadPreview(value: unknown): string {
  const text = payloadText(value).replace(/\s+/g, ' ').trim();
  return text.length > 120 ? `${text.slice(0, 119)}…` : text;
}

export function daysBetween(left: string, right: string): number {
  return Math.round((Date.parse(`${right}T00:00:00Z`) - Date.parse(`${left}T00:00:00Z`)) / DAY_MS);
}
