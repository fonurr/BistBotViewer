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
 * the verdict the server reached, so it carries body ink and reads as a fact of
 * the row. `muted` is what this page worked out about the row, and the `origin`
 * key it came in on — the server's word, but a source and not a verdict, so it
 * sits here too. `faint` is Matriks' own words, quoted — true, but the least of
 * the three, and drawn like the seconds on a time cell so it never competes
 * with the reason beside it.
 */
export type BookRowDetailTone = 'reason' | 'muted' | 'faint';

export interface BookRowDetailPart {
  text: string;
  tone: BookRowDetailTone;
}

export interface BookRowPresentation {
  label: string;
  /**
   * Who put the row in that status, said right beside the word and in its ink,
   * because it is part of the same verdict rather than a qualifier of it. Only
   * a stored death carries one; a live order is nobody's doing yet.
   */
  source?: string;
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
    const held = heldFor(row.finalSeenTime ?? row.orderTime, now);
    return chain.hasNoClosingOrder
      ? {
          label: 'Position — no closing order',
          detail: parts(originPart(row.origin, row.originData)),
          role: 'dead',
          exposed: true,
        }
      : {
          label: 'Position',
          detail: parts(originPart(row.origin, row.originData), muted(held)),
          role: 'fill',
        };
  }
  if (row.source === 'closed-trade') {
    // SPEC 2: `Filled` is a leg word; the chain's own row carries the round
    // trip, so only the opening leg reads `Closed`. Why the position was closed
    // rides in on the sell's `origin`, and how long it was held on the buy —
    // neither leg invents the other's fact.
    return row.leg === 'close'
      ? {
          label: 'Filled',
          detail: parts(originPart(row.origin, row.originData)),
          role: 'done',
        }
      : {
          label: 'Closed',
          detail: parts(originPart(row.origin, row.originData), muted(closedTradeHold(row, chain))),
          role: 'done',
        };
  }
  if (row.source === 'canceled') {
    // What says why a leg died: where it came from first (`Retry · count:
    // 2,00`), then the server's own `reason`, then the verbatim wire
    // `explanation` — every part that is stored, joined by middle dots.
    return {
      label: displayStatus(row.raw.status),
      source: row.statusSource ?? undefined,
      detail: parts(
        originPart(row.origin, row.originData),
        reasonPart(row.reason, row.reasonData),
        faint(row.raw.explanation?.trim() || undefined),
      ),
      role: row.raw.status === 'Unconfirmed' ? 'warn' : 'dead',
    };
  }

  const role = activeOrderStatusRole(row.raw);
  let label = displayActiveOrderStatus(row.raw);
  // Where the order came from leads its qualifier line, muted, ahead of
  // whatever the row says about itself — an exit sale names its target here
  // (`TakeProfit`), a retry its attempt count, and the ordinary bot order none.
  const detail: Array<BookRowDetailPart | undefined> = [originPart(row.origin, row.originData)];
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
      ...(row.raw.cancelSource === 'external'
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
    // stamp, never off the final column (SPEC 3: finalSeenTime is an upper bound).
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

/**
 * Where the order came from, said first and muted, in the same `key · pairs`
 * shape a reason takes — `Retry · count: 2,00`, `TakeProfit · limit:
 * ceilingAtClosingDay`, `External`. `null` for the ordinary bot order, which
 * names no origin. It is the server's own key, but it names a source rather
 * than a verdict, so it sits in the muted ink beside this page's own notes.
 * `originData` numbers take the page's Turkish figure form, `count` included.
 */
function originPart(
  origin: string | null,
  originData: ReasonData | null,
): BookRowDetailPart | undefined {
  return origin === null ? undefined : { text: reasonPhrase(origin, originData), tone: 'muted' };
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
  if (!close || close.finalSeenTime === null || row.finalSeenTime === null) {
    return undefined;
  }
  return heldFor(row.finalSeenTime, close.finalSeenTime);
}
