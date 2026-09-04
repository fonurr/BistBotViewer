import type { ReasonData } from '../../bistApi/types';
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
  reasonPhrase,
  type StatusRole,
} from '../../domain/status';

export interface BookRowNote {
  text: string;
  tone: 'wait' | 'muted';
}

/**
 * One clause of the qualifier line, with the ink it is said in. A `reason` is
 * what the server decided, so it carries body ink and reads as a fact of the
 * row. `muted` is what this page worked out about the row. `faint` is Matriks'
 * own words, quoted — true, but the least of the three, and drawn like the
 * seconds on a time cell so it never competes with the reason beside it.
 */
export type BookRowDetailTone = 'reason' | 'muted' | 'faint';

export interface BookRowDetailPart {
  text: string;
  tone: BookRowDetailTone;
}

export interface BookRowPresentation {
  label: string;
  /**
   * The reference keeps the qualifier on the status cell's own line, muted,
   * after a middle dot — `New . resting 22m`. Only the cancel-in-flight row
   * earns lines of its own, and they sit beneath the row rather than inside
   * the cell (SPEC 5).
   */
  detail?: readonly BookRowDetailPart[];
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
      : { label: 'Position', detail: parts(muted(held)), role: 'fill' };
  }
  if (row.source === 'closed-trade') {
    // SPEC 2: `Filled` is a leg word; the chain's own row carries the round
    // trip, so only the opening leg reads `Closed`. Why the position was closed
    // is stored on the sell, and how long it was held on the buy — neither leg
    // invents the other's fact.
    return row.leg === 'close'
      ? { label: 'Filled', detail: parts(reasonPart(row.reason, row.reasonData)), role: 'done' }
      : { label: 'Closed', detail: parts(muted(closedTradeHold(row, chain))), role: 'done' };
  }
  if (row.source === 'canceled') {
    // What says why a leg died: the server's own `reason` first, then the
    // verbatim wire `explanation` — both when both are stored. The retry count
    // is what says whether anything will try again (SPEC 2).
    return {
      label: displayStatus(row.raw.status),
      detail: parts(
        reasonPart(row.reason, row.reasonData),
        faint(row.raw.explanation?.trim() || undefined),
        muted(row.raw.retryCount > 0 ? `attempt ${row.raw.retryCount} of 3` : undefined),
      ),
      role: row.raw.status === 'Unconfirmed' ? 'warn' : 'dead',
    };
  }

  const role = activeOrderStatusRole(row.raw);
  let label = displayActiveOrderStatus(row.raw);
  // Why the order exists leads its qualifier line, as why a leg died leads a
  // canceled one — the reason filter ticks these keys, so the row prints them.
  const detail: Array<BookRowDetailPart | undefined> = [reasonPart(row.reason, row.reasonData)];
  let notes: readonly BookRowNote[] | undefined;
  if (row.source === 'scheduled' && row.scheduledTime !== null) {
    label = `${label} · ${formatScheduledDistance(row.scheduledTime, now)}`;
  }
  if (row.cancelInFlight && row.raw.cancelSource) {
    label = `${displayActiveOrderStatus(row.raw)} · cancel in flight`;
    // Who asked, and — where the server recorded one — why.
    detail.push(
      muted(cancelSourceCopy(row.raw.cancelSource)),
      reasonPart(row.cancelReason, row.cancelReasonData),
    );
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
    detail.push(
      muted('adopted from the exchange without a server order id; manage it in MatriksIQ'),
    );
  } else if (chain.hasNoClosingOrder && row.direction === 'buy' && row.isWaiting) {
    detail.push(muted('if it fills, nothing is set to close it'));
  } else if ((row.status === 'New' || row.status === 'PendingNew') && !row.raw.matriksOrderId) {
    detail.push(muted('no exchange id — not editable until it confirms'));
  } else if (displayStatus(row.status) === 'Unconfirmed') {
    detail.push(muted('the exchange outcome is unknown; its quantity stays claimed'));
  } else if (row.source === 'active' && row.isWaiting) {
    // How long it has rested is read off the exchange's own registration
    // stamp, never off the ack column (SPEC 3: ack is an upper bound).
    detail.push(muted(heldFor(row.orderTime, now, 'resting')));
    // Only a genuine partial fill earns the `x of y filled` clause: a resting
    // order with nothing filled says so by resting, and a fully filled one is
    // not waiting at all.
    const filled = Math.max(0, row.filledQuantity ?? 0);
    if (opener && row.quantity !== null && filled > 0 && filled < row.quantity) {
      detail.push(muted(`${formatQuantity(filled)} of ${formatQuantity(row.quantity)} filled`));
    }
  }
  return { label, detail: parts(...detail), notes, role };
}

/** The clauses that are actually there, or nothing at all where none is. */
function parts(
  ...candidates: Array<BookRowDetailPart | undefined>
): BookRowDetailPart[] | undefined {
  const present = candidates.filter((part): part is BookRowDetailPart => part !== undefined);
  return present.length > 0 ? present : undefined;
}

function reasonPart(reason: string | null, data: ReasonData | null): BookRowDetailPart | undefined {
  return reason === null ? undefined : { text: reasonPhrase(reason, data), tone: 'reason' };
}

function muted(text: string | undefined): BookRowDetailPart | undefined {
  return text === undefined ? undefined : { text, tone: 'muted' };
}

function faint(text: string | undefined): BookRowDetailPart | undefined {
  return text === undefined ? undefined : { text, tone: 'faint' };
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
