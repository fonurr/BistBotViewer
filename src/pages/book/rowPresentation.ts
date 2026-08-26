import type { BookChain, BookChainRow } from '../../domain/chains';
import {
  formatCompactDuration,
  formatQuantity,
  formatScheduledDistance,
} from '../../domain/format';
import {
  activeOrderStatusRole,
  cancelSourceCopy,
  displayActiveOrderStatus,
  displayStatus,
  type StatusRole,
} from '../../domain/status';

export interface BookRowNote {
  text: string;
  tone: 'wait' | 'muted';
}

export interface BookRowPresentation {
  label: string;
  /**
   * The reference keeps the qualifier on the status cell's own line, muted,
   * after a middle dot — `New . resting 22m`. Only the cancel-in-flight row
   * earns lines of its own, and they sit beneath the row rather than inside
   * the cell (SPEC 5).
   */
  detail?: string;
  notes?: readonly BookRowNote[];
  exposed?: boolean;
  role: StatusRole;
}

export function bookRowPresentation(
  row: BookChainRow,
  chain: BookChain,
  now = Date.now(),
  opener = false,
): BookRowPresentation {
  if (row.source === 'position') {
    const held = heldFor(row.acknowledgementTime ?? row.orderTime, now);
    return chain.hasNoClosingOrder
      ? { label: 'Position — no closing order', role: 'dead', exposed: true }
      : { label: 'Position', detail: held, role: 'fill' };
  }
  if (row.source === 'closed-trade') {
    // SPEC 2: `Filled` is a leg word; the chain's own row carries the round
    // trip, so only the opening leg reads `Closed`.
    return row.leg === 'close'
      ? { label: 'Filled', role: 'done' }
      : { label: 'Closed', detail: closedTradeHold(row, chain), role: 'done' };
  }
  if (row.source === 'canceled') {
    // The stored explanation is the only thing that says why a leg died, and
    // the retry count is what says whether anything will try again (SPEC 2).
    const parts = [
      row.raw.explanation?.trim() || null,
      row.raw.retryCount > 0 ? `attempt ${row.raw.retryCount} of 3` : null,
    ].filter((part): part is string => part !== null);
    return {
      label: displayStatus(row.raw.status),
      detail: parts.length > 0 ? parts.join(' · ') : undefined,
      role: row.raw.status === 'Unconfirmed' ? 'warn' : 'dead',
    };
  }

  const role = activeOrderStatusRole(row.raw);
  let label = displayActiveOrderStatus(row.raw);
  let detail: string | undefined;
  let notes: readonly BookRowNote[] | undefined;
  if (row.source === 'scheduled' && row.scheduledTime !== null) {
    label = `${label} · ${formatScheduledDistance(row.scheduledTime, now)}`;
  }
  if (row.cancelInFlight && row.raw.cancelSource) {
    label = `${displayActiveOrderStatus(row.raw)} · cancel in flight`;
    detail = cancelSourceCopy(row.raw.cancelSource);
    const filled = Math.max(0, row.filledQuantity ?? 0);
    const restingQuantity = row.quantity === null ? null : Math.max(0, row.quantity - filled);
    notes = [
      {
        text:
          row.quantity === null || restingQuantity === null
            ? 'still at the exchange, still fillable — the cancel can only take the resting remainder'
            : `still at the exchange, still fillable — ${formatQuantity(filled)} of ${formatQuantity(
                row.quantity,
              )} filled, so the cancel can only take the ${formatQuantity(
                restingQuantity,
              )} that are resting`,
        tone: 'wait',
      },
      ...(row.raw.cancelSource === 'user'
        ? ([
            {
              text: 'not our cancel: it appeared on the wire, so we know it was asked and not that it landed',
              tone: 'muted',
            },
          ] as const)
        : []),
    ];
  } else if (row.raw.clientOrderId.trim() === '') {
    detail = 'adopted from the exchange without a server order id; manage it in MatriksIQ';
  } else if (chain.hasNoClosingOrder && row.direction === 'buy' && row.isWaiting) {
    detail = 'if it fills, nothing is set to close it';
  } else if ((row.status === 'New' || row.status === 'PendingNew') && !row.raw.matriksOrderId) {
    detail = 'no exchange id — not editable until it confirms';
  } else if (displayStatus(row.status) === 'Unconfirmed') {
    detail = 'the exchange outcome is unknown; its quantity stays claimed';
  } else if (row.source === 'active' && row.isWaiting) {
    // How long it has rested is read off the exchange's own registration
    // stamp, never off the ack column (SPEC 3: ack is an upper bound).
    const resting = heldFor(row.orderTime, now, 'resting');
    const progress =
      opener && row.quantity !== null
        ? `${formatQuantity(Math.max(0, row.filledQuantity ?? 0))} of ${formatQuantity(
            row.quantity,
          )} filled`
        : undefined;
    detail = [resting, progress].filter((part) => part !== undefined).join(' · ') || undefined;
  }
  return { label, detail, notes, role };
}

function heldFor(from: number | null, now: number, word = 'held'): string | undefined {
  if (from === null || from > now) return undefined;
  return `${word} ${formatCompactDuration(now - from)}`;
}

/**
 * A round trip's hold runs open fill to close fill. Both stamps are when this
 * server learned of the fill, so the figure is a duration and never a latency.
 */
function closedTradeHold(row: BookChainRow, chain: BookChain): string | undefined {
  if (row.source !== 'closed-trade' || row.leg !== 'open') return undefined;
  const close = chain.tradeRows.find(
    (candidate) => candidate.leg === 'close' && candidate.rawId === row.rawId,
  );
  if (!close || close.acknowledgementTime === null || row.acknowledgementTime === null) {
    return undefined;
  }
  return heldFor(row.acknowledgementTime, close.acknowledgementTime);
}
