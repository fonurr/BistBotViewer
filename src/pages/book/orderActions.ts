import type {
  BookActiveOrderRow,
  BookCanceledOrderRow,
  BookChain,
  BookPositionRow,
} from '../../domain/chains';

interface ActionBase {
  disabled?: boolean;
  disabledReason?: string;
}

export type OrderDialogAction =
  | ({ kind: 'edit'; row: BookActiveOrderRow } & ActionBase)
  | ({ kind: 'cancel'; row: BookActiveOrderRow } & ActionBase)
  | ({ kind: 'fire'; row: BookActiveOrderRow } & ActionBase)
  | ({ kind: 'sell'; row: BookPositionRow } & ActionBase)
  | ({ kind: 'resend'; row: BookCanceledOrderRow } & ActionBase);

const ACTIONABLE_ACTIVE_STATUSES = new Set(['New', 'PartiallyFilled', 'AcceptedForBidding']);

export function orderActionsForRow(
  row: BookChain['rows'][number],
  chain: BookChain,
): OrderDialogAction[] {
  if (row.source === 'active' || row.source === 'scheduled') {
    if (row.raw.clientOrderId.trim() === '') return [];
    if (
      row.source === 'active' &&
      (!row.raw.matriksOrderId || !ACTIONABLE_ACTIVE_STATUSES.has(row.status))
    ) {
      return [];
    }

    const held = row.cancelInFlight || row.status === 'PendingCancel';
    const disabledReason = held ? 'A cancel is already in flight.' : undefined;
    // `fire now` leads the row: it is the loudest action a row carries, and
    // the reference puts it ahead of edit and cancel on a scheduled leg.
    const actions: OrderDialogAction[] =
      row.source === 'scheduled' ? [{ kind: 'fire', row, disabled: held, disabledReason }] : [];
    actions.push({ kind: 'edit', row, disabled: held, disabledReason });
    actions.push({ kind: 'cancel', row, disabled: held, disabledReason });
    return actions;
  }
  if (row.source === 'position') {
    return (chain.sellableQuantity ?? 0) > 0 ? [{ kind: 'sell', row }] : [];
  }
  if (row.source === 'canceled') {
    const canResendSell =
      row.direction === 'buy' || (chain.sellableQuantity ?? 0) >= (row.quantity ?? 0);
    return canResendSell ? [{ kind: 'resend', row }] : [];
  }
  return [];
}
