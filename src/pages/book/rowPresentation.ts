import type { BookChain, BookChainRow } from '../../domain/chains';
import { formatQuantity, formatScheduledDistance } from '../../domain/format';
import {
  activeOrderStatusRole,
  cancelSourceCopy,
  displayActiveOrderStatus,
  displayStatus,
  type StatusRole,
} from '../../domain/status';

export interface BookRowPresentation {
  label: string;
  detail?: string;
  role: StatusRole;
}

export function bookRowPresentation(
  row: BookChainRow,
  chain: BookChain,
  now = Date.now(),
): BookRowPresentation {
  if (row.source === 'position') {
    return chain.hasNoClosingOrder
      ? { label: 'Position · no closing order', role: 'dead' }
      : { label: 'Position', role: 'fill' };
  }
  if (row.source === 'closed-trade') return { label: 'Closed', role: 'done' };
  if (row.source === 'canceled') {
    return {
      label: displayStatus(row.raw.status),
      role: row.raw.status === 'Unconfirmed' ? 'warn' : 'dead',
    };
  }

  const role = activeOrderStatusRole(row.raw);
  let label = displayActiveOrderStatus(row.raw);
  let detail: string | undefined;
  if (row.source === 'scheduled' && row.scheduledTime !== null) {
    label = `${label} · ${formatScheduledDistance(row.scheduledTime, now)}`;
  }
  if (row.cancelInFlight && row.raw.cancelSource) {
    label = `${displayActiveOrderStatus(row.raw)} · cancel in flight`;
    const restingQuantity =
      row.quantity === null
        ? null
        : Math.max(0, row.quantity - Math.max(0, row.filledQuantity ?? 0));
    detail = `${cancelSourceCopy(row.raw.cancelSource)}; ${
      restingQuantity === null
        ? 'the resting remainder'
        : `${formatQuantity(restingQuantity)} resting shares`
    } can still fill until cancellation is confirmed`;
  } else if (row.raw.clientOrderId.trim() === '') {
    detail = 'adopted from the exchange without a server order id; manage it in MatriksIQ';
  } else if (chain.hasNoClosingOrder && row.direction === 'buy' && row.isWaiting) {
    detail = 'if it fills, nothing is set to close it';
  } else if ((row.status === 'New' || row.status === 'PendingNew') && !row.raw.matriksOrderId) {
    detail = 'not editable or cancelable until a refresh confirms it';
  } else if (displayStatus(row.status) === 'Unconfirmed') {
    detail = 'the exchange outcome is unknown; its quantity stays claimed';
  }
  return { label, detail, role };
}
