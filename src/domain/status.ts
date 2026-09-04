import type { ActiveOrder, OrderStatus, ReasonData } from '../bistApi/types';
import { formatNumber } from './format';

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

/**
 * A reason and the numbers behind it, as one phrase — `BuyGuard upperLimit
 * 119,34`. The keys are the server's own and print unchanged; a value is either
 * a TL price, which is formatted like every other figure on the page, or the
 * name of the default that produced it, which prints verbatim because a
 * default's number says nothing without it. Anything of another shape is left
 * out rather than guessed at, and a reason with no data is just itself.
 */
export function reasonPhrase(reason: string, data: ReasonData | null): string {
  const numbers = Object.entries(data ?? {}).flatMap(([key, value]) => {
    if (typeof value === 'number' && Number.isFinite(value))
      return [`${key} ${formatNumber(value)}`];
    return typeof value === 'string' && value.trim() !== '' ? [`${key} ${value.trim()}`] : [];
  });
  return numbers.length === 0 ? reason : `${reason} ${numbers.join(' · ')}`;
}
