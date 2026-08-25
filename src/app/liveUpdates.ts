import type { QueryClient, QueryKey } from '@tanstack/react-query';

import {
  activeOrderSchema,
  canceledOrderSchema,
  closedTradeSchema,
  pendingOrderRequestSchema,
  positionSchema,
  type ActiveOrder,
  type PendingOrderRequest,
  type WriteEvent,
} from '../bistApi/types';
import { bistKeys, selectorIncludes } from './queryKeys';

function stableId(row: { id: number }): number {
  return row.id;
}

function activeOrderId(row: ActiveOrder): string | number {
  return row.clientOrderId.trim()
    ? row.clientOrderId
    : `${row.status === 'Scheduled' ? 'scheduled' : 'active'}:${row.id}`;
}

function updateRows<T>(
  current: T[] | undefined,
  action: WriteEvent['action'],
  nextRow: T,
  identify: (row: T) => string | number,
): T[] | undefined {
  if (!current) return current;
  const key = identify(nextRow);
  if (action === 'delete') return current.filter((row) => identify(row) !== key);
  const index = current.findIndex((row) => identify(row) === key);
  if (index < 0) return [...current, nextRow];
  const copy = [...current];
  copy[index] = nextRow;
  return copy;
}

function normalizeScheduledRow(row: Record<string, unknown>): ActiveOrder {
  return activeOrderSchema.parse({
    matriksOrderId: null,
    matriksOrderId2: null,
    orderTime: null,
    sentTime: null,
    filledQuantity: 0,
    averagePrice: 0,
    status: 'Scheduled',
    cancelSource: null,
    ...row,
    cancelAtFloor: Boolean(row.cancelAtFloor),
  });
}

function normalizePendingRow(row: Record<string, unknown>): PendingOrderRequest {
  let request: unknown = null;
  if (typeof row.requestBody === 'string') {
    try {
      request = JSON.parse(row.requestBody) as unknown;
    } catch {
      request = null;
    }
  } else if ('request' in row) {
    request = row.request;
  }
  return pendingOrderRequestSchema.parse({ ...row, request });
}

function matchingQueries(queryClient: QueryClient, prefix: string, botId: string) {
  return queryClient
    .getQueryCache()
    .findAll({ queryKey: ['bist', prefix] })
    .filter((query) => selectorIncludes((query.queryKey as QueryKey)[2], botId));
}

export function applyWriteEvent(queryClient: QueryClient, event: WriteEvent): void {
  const apply = <T>(prefix: string, row: T, identify: (value: T) => string | number) => {
    for (const query of matchingQueries(queryClient, prefix, event.botId)) {
      queryClient.setQueryData<T[]>(query.queryKey, (current) =>
        updateRows(current, event.action, row, identify),
      );
    }
  };

  switch (event.table) {
    case 'ActiveOrders':
      apply('activeOrders', activeOrderSchema.parse(event.row), activeOrderId);
      break;
    case 'ScheduledOrders':
      apply('activeOrders', normalizeScheduledRow(event.row), activeOrderId);
      break;
    case 'CanceledOrders':
      apply('canceledOrders', canceledOrderSchema.parse(event.row), stableId);
      break;
    case 'Positions':
      apply('positions', positionSchema.parse(event.row), stableId);
      break;
    case 'ClosedTrades':
      apply('closedTrades', closedTradeSchema.parse(event.row), stableId);
      break;
    case 'PendingOrderRequests':
      apply('pendingRequests', normalizePendingRow(event.row), stableId);
      break;
  }

  if (event.table !== 'PendingOrderRequests') {
    void queryClient.invalidateQueries({ queryKey: bistKeys.budget(event.botId), exact: true });
  }
}
