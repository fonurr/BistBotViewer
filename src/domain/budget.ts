import type { ActiveOrder, CanceledOrder } from '../bistApi/types';
import type { BookChain } from './chains';

/**
 * A resting **market** buy reserves 10% extra budget per share, because a market
 * fill can beat the estimate the request was priced with
 * (`../MatriksOrder/API.md` — "Budget and limits": reserved cost is
 * `orderQuantity × price` for limit buys and `orderQuantity × price × 1.1` for
 * `type: "market"` buys).
 */
export const MARKET_BUY_BUDGET_BUFFER = 1.1;

/**
 * What one group of chains meant to spend on its buys and what it spent.
 *
 * - `committed` (A) — the shares actually acquired, priced the way the order
 *   that asked for them was priced: its own `orderPrice`, with the market
 *   buffer when it was a market buy.
 * - `spent` (B) — what those same shares really cost: quantity × average fill
 *   price. Never buffered: once a buy fills there is nothing left to estimate.
 * - `planned` (C) — the whole order at A's unit price, as if every share had
 *   been acquired. The denominator both ratios are read against.
 */
export interface BookBudgetTotals {
  readonly committed: number;
  readonly spent: number;
  readonly planned: number;
}

export type BookBudget =
  /** No chain in the group owns a buy, so there is no budget to report. */
  | { readonly kind: 'none' }
  /**
   * At least one visible chain's opening buy could not be priced — no
   * `orderPrice`, or a scheduled buy that has not been sized yet. The figure is
   * all-or-nothing for the same reason unrealized P&L is: a total that silently
   * drops a chain reads as a smaller commitment than the bot actually made.
   */
  | { readonly kind: 'unknown' }
  | ({ readonly kind: 'known' } & BookBudgetTotals);

/** `null` where `planned` cannot divide — a group that planned to spend nothing. */
export function budgetShare(part: number, planned: number): number | null {
  return planned === 0 ? null : (part / planned) * 100;
}

/**
 * The buy budget of every chain drawn in a group, summed. Callers pass exactly
 * the chains on screen, so filters and scope toggles decide what is counted.
 */
export function bookBudget(chains: readonly BookChain[]): BookBudget {
  let committed = 0;
  let spent = 0;
  let planned = 0;
  let counted = 0;

  for (const chain of chains) {
    const budget = chainBudget(chain);
    if (budget.kind === 'unknown') return { kind: 'unknown' };
    if (budget.kind === 'none') continue;
    committed += budget.committed;
    spent += budget.spent;
    planned += budget.planned;
    counted += 1;
  }

  return counted === 0 ? { kind: 'none' } : { kind: 'known', committed, spent, planned };
}

/** One acquired parcel of the chain's opening buy, wherever it now lives. */
interface FilledParcel {
  readonly quantity: number;
  readonly orderPrice: number | null;
  readonly averagePrice: number;
}

/**
 * A chain is the whole life of **one** buy, so it contributes one budget however
 * many attempts it took: an automatic retry keeps the chain's id and restates
 * the same intent, it does not ask for a second budget.
 */
export function chainBudget(chain: BookChain): BookBudget {
  const { positions, closedTrades } = chain.sources;
  const activeBuys = chain.sources.activeOrders.filter((order) => order.direction === 'buy');
  const canceledBuys = chain.sources.canceledOrders.filter((order) => order.direction === 'buy');

  if (
    positions.length === 0 &&
    closedTrades.length === 0 &&
    activeBuys.length === 0 &&
    canceledBuys.length === 0
  ) {
    return { kind: 'none' };
  }

  const stated = statedOpeningBuy(chain, activeBuys, canceledBuys);
  const buffer = buyBudgetBuffer(stated);

  /*
   * The acquired shares, taken from wherever they ended up. A position holds
   * what is *left* of the opening buy and each round trip holds a slice already
   * sold, so the two compose back into everything that buy ever filled. An
   * active buy's own `filledQuantity` is only read when neither exists: while a
   * position stands for the same order, counting both would buy the shares
   * twice.
   */
  const parcels: FilledParcel[] = [];
  for (const position of positions) {
    if (position.quantity > 0) {
      parcels.push({
        quantity: position.quantity,
        orderPrice: position.orderPrice,
        averagePrice: position.averagePrice,
      });
    }
  }
  for (const trade of closedTrades) {
    if (trade.quantity > 0) {
      parcels.push({
        quantity: trade.quantity,
        orderPrice: trade.openOrderPrice,
        averagePrice: trade.averageOpenPrice,
      });
    }
  }
  if (positions.length === 0 && closedTrades.length === 0) {
    for (const order of activeBuys) {
      if (order.filledQuantity > 0) {
        parcels.push({
          quantity: order.filledQuantity,
          orderPrice: order.orderPrice,
          averagePrice: order.averagePrice,
        });
      }
    }
  }

  let committed = 0;
  let spent = 0;
  let filledQuantity = 0;
  for (const parcel of parcels) {
    if (parcel.orderPrice === null) return { kind: 'unknown' };
    committed += parcel.quantity * parcel.orderPrice * buffer;
    spent += parcel.quantity * parcel.averagePrice;
    filledQuantity += parcel.quantity;
  }

  /*
   * What the buy asked for. A buy that did not fill in full always left a row
   * that still states its size — it is either resting (active) or dead
   * (canceled) — so the fall back to the filled quantity only ever answers for
   * a buy that filled completely, where the two are the same number.
   */
  const orderQuantity =
    stated?.orderQuantity ??
    positions.find((position) => position.orderQuantity > 0)?.orderQuantity ??
    (parcels.length > 0 ? filledQuantity : null);
  if (orderQuantity === null) return { kind: 'unknown' };
  const orderPrice =
    stated?.orderPrice ??
    positions[0]?.orderPrice ??
    closedTrades[0]?.openOrderPrice ??
    parcels[0]?.orderPrice ??
    null;
  if (orderPrice === null) return { kind: 'unknown' };

  return {
    kind: 'known',
    committed,
    spent,
    planned: orderQuantity * orderPrice * buffer,
  };
}

/**
 * The order row that still states the chain's opening buy. A Positions row names
 * the attempt that actually filled (`clientOrderId`), so that is what is matched
 * on; without one, the newest buy the chain owns is the live intent, since every
 * earlier attempt is already dead.
 */
function statedOpeningBuy(
  chain: BookChain,
  activeBuys: readonly ActiveOrder[],
  canceledBuys: readonly CanceledOrder[],
): ActiveOrder | CanceledOrder | null {
  const openedBy =
    chain.sources.positions.find((position) => position.clientOrderId !== null)?.clientOrderId ??
    chain.sources.closedTrades.find((trade) => trade.clientOpenOrderId !== null)
      ?.clientOpenOrderId ??
    null;

  if (openedBy !== null) {
    const matched =
      activeBuys.find((order) => order.clientOrderId === openedBy) ??
      canceledBuys.find((order) => order.clientOrderId === openedBy);
    if (matched) return matched;
  }

  return newest(activeBuys) ?? newest(canceledBuys);
}

function newest<T extends { orderTime: number | null; id: number }>(
  orders: readonly T[],
): T | null {
  let best: T | null = null;
  for (const order of orders) {
    if (best === null) {
      best = order;
      continue;
    }
    const left = order.orderTime ?? Number.NEGATIVE_INFINITY;
    const right = best.orderTime ?? Number.NEGATIVE_INFINITY;
    if (left > right || (left === right && order.id > best.id)) best = order;
  }
  return best;
}

/**
 * ⚠️ **`limit` is the only type that escapes the buffer, and an unknown type is
 * read as a market buy.** Neither `Positions` nor `ClosedTrades` stores the
 * opening buy's `type`, so once a buy fills and its ActiveOrders row is gone,
 * nothing left says how it was priced. Reserving the 10% is the reading that
 * cannot understate what the bot committed. **If MatriksOrder ever carries the
 * buy's `type` onto those two tables, read it here instead** — see
 * `src/pages/book/README.md` and `src/domain/README.md`.
 */
function buyBudgetBuffer(stated: ActiveOrder | CanceledOrder | null): number {
  const type = stated?.type ?? stated?.intentType ?? null;
  return type === 'limit' ? 1 : MARKET_BUY_BUDGET_BUFFER;
}
