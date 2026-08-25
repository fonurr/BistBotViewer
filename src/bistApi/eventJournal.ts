import {
  activeOrderSchema,
  canceledOrderSchema,
  closedTradeSchema,
  pendingOrderRequestSchema,
  positionSchema,
  type ActiveOrder,
  type BotSelector,
  type CanceledOrder,
  type ClosedTrade,
  type PendingOrderRequest,
  type Position,
  type WriteEvent,
} from './types';

export type JournalKind =
  'activeOrders' | 'canceledOrders' | 'positions' | 'closedTrades' | 'pendingRequests';

export type JournalRows = {
  activeOrders: ActiveOrder;
  canceledOrders: CanceledOrder;
  positions: Position;
  closedTrades: ClosedTrade;
  pendingRequests: PendingOrderRequest;
};

interface JournalEntry {
  sequence: number;
  event: WriteEvent;
}

const MAX_JOURNAL_ENTRIES = 20_000;
let sequence = 0;
let discardedThrough = 0;
const entries: JournalEntry[] = [];

export function recordBistWriteEvent(event: WriteEvent): void {
  entries.push({ sequence: ++sequence, event });
  if (entries.length > MAX_JOURNAL_ENTRIES) {
    const removed = entries.splice(0, entries.length - MAX_JOURNAL_ENTRIES);
    discardedThrough = removed.at(-1)?.sequence ?? discardedThrough;
  }
}

export function bistJournalCheckpoint(): number {
  return sequence;
}

/** Null means the checkpoint fell out of the bounded journal. */
export function bistJournalChangedForBot(checkpoint: number, botId: string): boolean | null {
  if (checkpoint < discardedThrough) return null;
  return entries.some((entry) => entry.sequence > checkpoint && entry.event.botId === botId);
}

/** Null means the journal wrapped while the read was pending; take another full snapshot. */
export function replayBistJournal<Kind extends JournalKind>(
  checkpoint: number,
  kind: Kind,
  selector: BotSelector,
  snapshot: readonly JournalRows[Kind][],
): JournalRows[Kind][] | null {
  if (checkpoint < discardedThrough) return null;
  let rows = [...snapshot];
  for (const entry of entries) {
    if (entry.sequence <= checkpoint || !selectorContains(selector, entry.event.botId)) continue;
    rows = applyBistEventToRows(kind, rows, entry.event);
  }
  return rows;
}

export function kindForWriteEvent(event: WriteEvent): JournalKind {
  if (event.table === 'ActiveOrders' || event.table === 'ScheduledOrders') return 'activeOrders';
  if (event.table === 'CanceledOrders') return 'canceledOrders';
  if (event.table === 'Positions') return 'positions';
  if (event.table === 'ClosedTrades') return 'closedTrades';
  return 'pendingRequests';
}

export function applyBistEventToRows<Kind extends JournalKind>(
  kind: Kind,
  current: readonly JournalRows[Kind][],
  event: WriteEvent,
): JournalRows[Kind][] {
  const eventKind = kindForWriteEvent(event);
  if (eventKind !== kind) return [...current];
  const nextRow = parseEventRow(kind, event);
  const identify = identityFor(kind);
  const key = identify(nextRow);
  if (event.action === 'delete') return current.filter((row) => identify(row) !== key);
  const index = current.findIndex((row) => identify(row) === key);
  if (index < 0) return [...current, nextRow];
  const copy = [...current];
  copy[index] = nextRow;
  return copy;
}

function parseEventRow<Kind extends JournalKind>(kind: Kind, event: WriteEvent): JournalRows[Kind] {
  const parsed =
    kind === 'activeOrders'
      ? event.table === 'ScheduledOrders'
        ? activeOrderSchema.parse({
            matriksOrderId: null,
            matriksOrderId2: null,
            orderTime: null,
            sentTime: null,
            filledQuantity: 0,
            averagePrice: 0,
            status: 'Scheduled',
            cancelSource: null,
            ...event.row,
            cancelAtFloor: Boolean(event.row.cancelAtFloor),
          })
        : activeOrderSchema.parse(event.row)
      : kind === 'canceledOrders'
        ? canceledOrderSchema.parse(event.row)
        : kind === 'positions'
          ? positionSchema.parse(event.row)
          : kind === 'closedTrades'
            ? closedTradeSchema.parse(event.row)
            : pendingOrderRequestSchema.parse({
                ...event.row,
                request: pendingRequestBody(event.row),
              });
  return parsed as JournalRows[Kind];
}

function identityFor<Kind extends JournalKind>(
  kind: Kind,
): (row: JournalRows[Kind]) => string | number {
  if (kind === 'activeOrders') {
    return ((row: ActiveOrder) =>
      row.clientOrderId.trim()
        ? row.clientOrderId
        : `${row.status === 'Scheduled' ? 'scheduled' : 'active'}:${row.id}`) as (
      row: JournalRows[Kind],
    ) => string | number;
  }
  return ((row: { id: number }) => row.id) as (row: JournalRows[Kind]) => string | number;
}

function pendingRequestBody(row: Record<string, unknown>): unknown {
  if (typeof row.requestBody === 'string') {
    try {
      return JSON.parse(row.requestBody) as unknown;
    } catch {
      return null;
    }
  }
  return 'request' in row ? row.request : null;
}

function selectorContains(selector: BotSelector, botId: string): boolean {
  if (selector === '*') return true;
  return typeof selector === 'string' ? selector === botId : selector.includes(botId);
}

export function resetBistJournalForTests(): void {
  sequence = 0;
  discardedThrough = 0;
  entries.splice(0);
}
