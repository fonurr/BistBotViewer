import type { ActiveOrder, OrderStatus } from '../bistApi/types';

export type StatusRole = 'live' | 'wait' | 'dead' | 'warn' | 'fill' | 'done';

const DISPLAY_STATUS: Record<string, string> = {
  PendingNew: 'New',
  New: 'New',
  PartiallyFilled: 'Partly filled',
  Filled: 'Filled',
  Scheduled: 'Scheduled',
  Unconfirmed: 'Unconfirmed',
  CanceledByBot: 'By bot',
  CanceledByUser: 'By user',
  CanceledByServer: 'By server',
  Canceled: 'Canceled',
  Expired: 'Expired',
  Rejected: 'Rejected',
  Skipped: 'Skipped',
  SkippedForNow: 'SkippedForNow',
  PendingCancel: 'New',
  PendingReplace: 'New',
  AcceptedForBidding: 'New',
  Replaced: 'Unconfirmed',
  Stopped: 'Unconfirmed',
  Suspended: 'Unconfirmed',
  EditRejectTrace: 'Unconfirmed',
  CancelRejectTrace: 'Unconfirmed',
  RemoveFromList: 'Unconfirmed',
  Unknown: 'Unconfirmed',
};

export function displayStatus(status: OrderStatus): string {
  return DISPLAY_STATUS[status] ?? 'Unconfirmed';
}

export function displayActiveOrderStatus(order: ActiveOrder): string {
  if (
    order.status === 'PendingCancel' ||
    order.status === 'PendingReplace' ||
    order.status === 'AcceptedForBidding'
  ) {
    return order.filledQuantity > 0 ? 'Partly filled' : 'New';
  }
  return displayStatus(order.status);
}

export function statusRole(
  status: OrderStatus,
  options: { hasExchangeId?: boolean; cancelInFlight?: boolean } = {},
): StatusRole {
  if (status === 'Unconfirmed') return 'warn';
  if (options.cancelInFlight) return 'wait';
  if (
    status === 'Scheduled' ||
    status === 'PendingNew' ||
    status === 'PendingCancel' ||
    status === 'PendingReplace'
  )
    return 'wait';
  if (status === 'New' || status === 'PartiallyFilled' || status === 'AcceptedForBidding') {
    return options.hasExchangeId ? 'live' : 'wait';
  }
  if (status === 'Filled') return 'done';
  if (DISPLAY_STATUS[status] === undefined || DISPLAY_STATUS[status] === 'Unconfirmed')
    return 'warn';
  return 'dead';
}

export function activeOrderStatusRole(order: ActiveOrder): StatusRole {
  return statusRole(order.status, {
    hasExchangeId: Boolean(order.matriksOrderId),
    cancelInFlight: order.cancelSource !== null,
  });
}

export function cancelSourceCopy(source: NonNullable<ActiveOrder['cancelSource']>): string {
  switch (source) {
    case 'bot':
      return 'asked by the bot';
    case 'server':
      return 'asked by the server';
    case 'user':
      return 'asked by a person, in the terminal';
  }
}

export function statusClass(role: StatusRole): string {
  return `status-${role}`;
}
