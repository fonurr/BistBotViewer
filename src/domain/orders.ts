import type { ActiveOrder, BotBudget, ClosedTrade, OrderType, Position } from '../bistApi/types';

export interface FilledExposure {
  readonly source: 'position' | 'partial-buy';
  readonly sourceId: number;
  readonly botId: string;
  readonly symbol: string;
  readonly quantity: number;
  readonly averagePrice: number;
}

export interface PartialSellFill {
  readonly sourceId: number;
  readonly botId: string;
  readonly symbol: string;
  readonly quantity: number;
  readonly averageOpenPrice: number;
  readonly averageClosePrice: number;
}

export interface FilledPnlState {
  readonly exposures: readonly FilledExposure[];
  readonly partialSellFills: readonly PartialSellFill[];
}

export interface SellableBreakdown {
  positionQuantity: number;
  activeClaim: number;
  scheduledClaim: number;
  sellable: number;
  hasSellAllSchedule: boolean;
}

export function calculateSellable(
  position: Position,
  activeOrders: readonly ActiveOrder[],
): SellableBreakdown {
  let activeClaim = 0;
  let scheduledClaim = 0;
  let hasSellAllSchedule = false;

  for (const order of activeOrders) {
    if (
      order.botId !== position.botId ||
      order.symbol !== position.symbol ||
      order.direction !== 'sell'
    ) {
      continue;
    }
    if (order.status === 'Scheduled') {
      if (order.orderQuantity === null) {
        hasSellAllSchedule = true;
        scheduledClaim = position.quantity;
      } else if (!hasSellAllSchedule) {
        scheduledClaim += order.orderQuantity;
      }
    } else if (order.orderQuantity !== null) {
      // A cancelSource is still a live claim until refresh confirms the cancellation.
      activeClaim += order.orderQuantity;
    }
  }

  return {
    positionQuantity: position.quantity,
    activeClaim,
    scheduledClaim,
    sellable: Math.max(0, position.quantity - activeClaim - scheduledClaim),
    hasSellAllSchedule,
  };
}

export function realizedPnl(
  quantity: number,
  averageOpenPrice: number,
  averageClosePrice: number,
): number {
  return quantity * (averageClosePrice - averageOpenPrice);
}

/**
 * Reconciles the server's deliberately split representation of in-flight fills.
 *
 * A partially filled buy has real shares but does not become a Positions row until the
 * order is terminal. A partially filled sell is the inverse: its Positions row retains
 * the pre-sell quantity until terminal processing moves the fill to ClosedTrades. The
 * returned state adds the former and subtracts the latter, while exposing the sell fill
 * as realized P&L. Matching terminal rows suppress the brief SSE overlap between an insert
 * and the corresponding ActiveOrders delete.
 */
export function deriveFilledPnlState(
  positions: readonly Position[],
  activeOrders: readonly ActiveOrder[],
  closedTrades: readonly ClosedTrade[] = [],
): FilledPnlState {
  const remainingByPositionId = new Map(
    positions.map((position) => [position.id, nonNegativeQuantity(position.quantity)]),
  );
  const partialOrders = activeOrders
    .filter((order) => order.status === 'PartiallyFilled' && order.filledQuantity > 0)
    .sort((left, right) => left.id - right.id);
  const partialSellFills: PartialSellFill[] = [];

  for (const order of partialOrders) {
    if (order.direction !== 'sell' || hasMatchingCloseTrade(order, closedTrades)) continue;
    const position = matchingPosition(order, positions);
    if (!position) continue;
    const remaining = remainingByPositionId.get(position.id) ?? 0;
    const quantity = Math.min(remaining, nonNegativeQuantity(order.filledQuantity));
    if (quantity === 0) continue;

    partialSellFills.push({
      sourceId: order.id,
      botId: order.botId,
      symbol: order.symbol,
      quantity,
      averageOpenPrice: position.averagePrice,
      averageClosePrice: order.averagePrice,
    });
    remainingByPositionId.set(position.id, remaining - quantity);
  }

  const exposures: FilledExposure[] = positions.flatMap((position) => {
    const quantity = remainingByPositionId.get(position.id) ?? 0;
    return quantity > 0
      ? [
          {
            source: 'position' as const,
            sourceId: position.id,
            botId: position.botId,
            symbol: position.symbol,
            quantity,
            averagePrice: position.averagePrice,
          },
        ]
      : [];
  });

  for (const order of partialOrders) {
    if (
      order.direction !== 'buy' ||
      hasMatchingPosition(order, positions) ||
      hasMatchingOpenTrade(order, closedTrades)
    ) {
      continue;
    }
    const quantity = nonNegativeQuantity(order.filledQuantity);
    if (quantity === 0) continue;
    exposures.push({
      source: 'partial-buy',
      sourceId: order.id,
      botId: order.botId,
      symbol: order.symbol,
      quantity,
      averagePrice: order.averagePrice,
    });
  }

  return { exposures, partialSellFills };
}

export function unrealizedPnl(
  position: Pick<Position, 'quantity' | 'averagePrice'>,
  marketPrice: number,
): number {
  return position.quantity * (marketPrice - position.averagePrice);
}

export function pnlPercentage(pnl: number, costBasis: number): number | null {
  return costBasis === 0 ? null : (pnl / costBasis) * 100;
}

export function slippagePercentage(options: {
  orderPrice: number | null;
  averagePrice: number;
  type: OrderType | null;
}): number | null {
  // A market order's stored capture was never sent to the exchange and cannot be intent slippage.
  if (
    options.type === null ||
    options.type === 'market' ||
    options.orderPrice === null ||
    options.orderPrice === 0
  )
    return null;
  return ((options.averagePrice - options.orderPrice) / options.orderPrice) * 100;
}

export function reservedBuyCost(quantity: number, price: number, type: OrderType): number {
  return quantity * price * (type === 'market' ? 1.1 : 1);
}

export function effectivePerPositionCap(budget: BotBudget): number {
  return Math.min(
    budget.limitPerPosition,
    budget.portfolioValue * (budget.limitPercentagePerPosition / 100),
  );
}

export function committedAmount(budget: BotBudget): number {
  return Math.max(0, budget.limit - budget.remainingBotBudget);
}

function matchingPosition(
  order: ActiveOrder,
  positions: readonly Position[],
): Position | undefined {
  const candidates = positions.filter(
    (position) => position.botId === order.botId && position.symbol === order.symbol,
  );
  if (order.chainId !== null) {
    const linked = candidates.find((position) => position.chainId === order.chainId);
    if (linked) return linked;
  }
  return candidates.length === 1 ? candidates[0] : undefined;
}

function hasMatchingPosition(order: ActiveOrder, positions: readonly Position[]): boolean {
  return positions.some(
    (position) =>
      position.botId === order.botId &&
      position.symbol === order.symbol &&
      ((order.clientOrderId.trim() !== '' && position.clientOrderId === order.clientOrderId) ||
        (order.matriksOrderId !== null && position.matriksOrderId === order.matriksOrderId) ||
        (order.chainId !== null && position.chainId === order.chainId)),
  );
}

function hasMatchingOpenTrade(order: ActiveOrder, trades: readonly ClosedTrade[]): boolean {
  return trades.some(
    (trade) =>
      trade.botId === order.botId &&
      trade.symbol === order.symbol &&
      ((order.clientOrderId.trim() !== '' && trade.clientOpenOrderId === order.clientOrderId) ||
        (order.matriksOrderId !== null && trade.matriksOpenOrderId === order.matriksOrderId)),
  );
}

function hasMatchingCloseTrade(order: ActiveOrder, trades: readonly ClosedTrade[]): boolean {
  return trades.some(
    (trade) =>
      trade.botId === order.botId &&
      trade.symbol === order.symbol &&
      ((order.clientOrderId.trim() !== '' && trade.clientCloseOrderId === order.clientOrderId) ||
        (order.matriksOrderId !== null && trade.matriksCloseOrderId === order.matriksOrderId)),
  );
}

function nonNegativeQuantity(quantity: number): number {
  return Math.max(0, quantity);
}
