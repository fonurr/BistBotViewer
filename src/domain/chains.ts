import type {
  ActiveOrder,
  CanceledOrder,
  ClosedTrade,
  Direction,
  OrderStatus,
  OrderType,
  Position,
} from '../bistApi/types';

export type BookScope = 'waiting' | 'positions' | 'trades' | 'canceled';

export type BookRowStatus = OrderStatus | 'Position' | 'Closed';

interface BookChainRowBase {
  readonly key: string;
  readonly rawId: number;
  readonly chainId: string | null;
  readonly botId: string;
  readonly symbol: string;
  readonly clientOrderId: string | null;
  readonly parentClientOrderId: string | null;
  readonly retryOfClientOrderId: string | null;
  readonly direction: Direction;
  readonly quantity: number | null;
  readonly filledQuantity: number | null;
  readonly canceledQuantity: number | null;
  readonly orderType: OrderType | null;
  readonly intentType: OrderType | null;
  readonly orderPrice: number | null;
  readonly averagePrice: number | null;
  readonly orderTime: number | null;
  readonly acknowledgementTime: number | null;
  readonly scheduledTime: number | null;
  readonly status: BookRowStatus;
  readonly isWaiting: boolean;
  readonly cancelInFlight: boolean;
}

export interface BookActiveOrderRow extends BookChainRowBase {
  readonly source: 'active' | 'scheduled';
  readonly raw: ActiveOrder;
}

export interface BookCanceledOrderRow extends BookChainRowBase {
  readonly source: 'canceled';
  readonly raw: CanceledOrder;
}

export interface BookPositionRow extends BookChainRowBase {
  readonly source: 'position';
  readonly status: 'Position';
  readonly raw: Position;
}

export interface BookClosedTradeRow extends BookChainRowBase {
  readonly source: 'closed-trade';
  readonly leg: 'open' | 'close';
  readonly status: 'Closed';
  readonly raw: ClosedTrade;
}

export type BookChainRow =
  BookActiveOrderRow | BookCanceledOrderRow | BookPositionRow | BookClosedTradeRow;

export interface BookChainSources {
  readonly activeOrders: readonly ActiveOrder[];
  readonly canceledOrders: readonly CanceledOrder[];
  readonly positions: readonly Position[];
  readonly closedTrades: readonly ClosedTrade[];
}

/**
 * The scope a chain belongs to. The four scopes are a partition, not four
 * overlapping tags: the reference draws every chain exactly once, under the
 * furthest stage its own life reached (`BotViewer.dc.html` — ASELS under
 * waiting, BURCE under positions, SISE under trades, ADESE under canceled),
 * and toggling a scope adds or removes whole chains with every one of their
 * legs. A chain that holds shares is a position however many orders wait on
 * it; one that bought and sold is a trade however many legs died on the way.
 */
export function classifyBookChain(input: {
  readonly hasPosition: boolean;
  readonly hasTrade: boolean;
  readonly hasWaitingOrder: boolean;
  readonly hasCanceled: boolean;
}): BookScope {
  if (input.hasPosition) return 'positions';
  if (input.hasTrade) return 'trades';
  if (input.hasWaitingOrder) return 'waiting';
  // Only fully dead legs are left. A chain with no canceled row either is an
  // order row the exchange finished without a position or trade behind it;
  // it is not canceled, so it stays where an order row belongs.
  return input.hasCanceled ? 'canceled' : 'waiting';
}

export interface BookChain {
  /** `chain:<chainId>` for linked data; a source identity for one unlinked record. */
  readonly key: string;
  readonly chainId: string | null;
  readonly botId: string;
  readonly symbol: string;
  /** The opening day in Istanbul, in an ISO date form that sorts chronologically. */
  readonly batchDate: string | null;
  readonly batchTimestamp: number | null;
  readonly rows: readonly BookChainRow[];
  readonly activeRows: readonly BookActiveOrderRow[];
  readonly canceledRows: readonly BookCanceledOrderRow[];
  readonly positionRows: readonly BookPositionRow[];
  readonly tradeRows: readonly BookClosedTradeRow[];
  readonly sources: BookChainSources;
  /** The one scope this chain belongs to; the four are a partition. */
  readonly scope: BookScope;
  readonly positionQuantity: number | null;
  readonly sellableQuantity: number | null;
  /** Position plus pending buys, minus every current sell claim. */
  readonly projectedSellableQuantity: number | null;
  /** API-equivalent self-excluded ceiling for an edit, keyed by source-table id. */
  readonly sellEditCeilingByRowKey: Readonly<Record<string, number>>;
  readonly hasNoClosingOrder: boolean;
}

export interface BuildBookChainsInput {
  readonly activeOrders: readonly ActiveOrder[];
  readonly canceledOrders: readonly CanceledOrder[];
  readonly positions: readonly Position[];
  readonly closedTrades: readonly ClosedTrade[];
}

const TERMINAL_STATUSES: ReadonlySet<OrderStatus> = new Set([
  'Filled',
  'CanceledByBot',
  'CanceledByUser',
  'CanceledByServer',
  'Canceled',
  'Expired',
  'Rejected',
  'Skipped',
  'SkippedForNow',
]);

const istanbulDateFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Europe/Istanbul',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

interface MutableChainSources {
  activeOrders: ActiveOrder[];
  canceledOrders: CanceledOrder[];
  positions: Position[];
  closedTrades: ClosedTrade[];
}

interface ChainAccumulator {
  readonly key: string;
  readonly chainId: string | null;
  readonly sources: MutableChainSources;
  readonly rows: BookChainRow[];
}

export function isWaitingOrderStatus(status: OrderStatus): boolean {
  return !TERMINAL_STATUSES.has(status);
}

export function toIstanbulDate(timestamp: number | null): string | null {
  if (timestamp === null || !Number.isFinite(timestamp)) return null;

  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return null;

  const parts = istanbulDateFormatter.formatToParts(date);
  const year = parts.find(({ type }) => type === 'year')?.value;
  const month = parts.find(({ type }) => type === 'month')?.value;
  const day = parts.find(({ type }) => type === 'day')?.value;

  return year !== undefined && month !== undefined && day !== undefined
    ? `${year}-${month}-${day}`
    : null;
}

export function buildBookChains(input: BuildBookChainsInput): BookChain[] {
  const linked = new Map<string, ChainAccumulator>();
  const unlinked: ChainAccumulator[] = [];

  for (const order of input.activeOrders) {
    addRecord(
      linked,
      unlinked,
      order.chainId,
      unlinkedOrderKey(order.clientOrderId, order.id, 'active'),
      { source: 'activeOrders', raw: order },
      [normalizeActiveOrder(order)],
    );
  }

  for (const order of input.canceledOrders) {
    addRecord(
      linked,
      unlinked,
      order.chainId,
      unlinkedOrderKey(order.clientOrderId, order.id, 'canceled'),
      { source: 'canceledOrders', raw: order },
      [normalizeCanceledOrder(order)],
    );
  }

  for (const position of input.positions) {
    addRecord(
      linked,
      unlinked,
      position.chainId,
      `unlinked:position:${stableSourceIdentity(position.clientOrderId, position.id)}`,
      { source: 'positions', raw: position },
      [normalizePosition(position)],
    );
  }

  for (const trade of input.closedTrades) {
    addRecord(
      linked,
      unlinked,
      trade.chainId,
      `unlinked:closed-trade:${trade.id}`,
      { source: 'closedTrades', raw: trade },
      normalizeClosedTrade(trade),
    );
  }

  const chains = [...linked.values(), ...unlinked].map(finalizeChain);
  return applyFleetSellClaims(chains).sort(compareBookChains);
}

/**
 * A sell is submitted for a bot and symbol, not for one Book chain. Keep the
 * safety bound at that same scope so an unlinked or separately-linked sell can
 * never free shares for a second order merely because it is drawn elsewhere.
 */
function applyFleetSellClaims(chains: readonly BookChain[]): BookChain[] {
  interface ClaimGroup {
    positionQuantity: number;
    claimedQuantity: number;
    hasWaitingSell: boolean;
    pendingBuyQuantity: number;
    activeSells: BookActiveOrderRow[];
    scheduledSells: BookActiveOrderRow[];
  }

  const groups = new Map<string, ClaimGroup>();
  const groupFor = (botId: string, symbol: string): ClaimGroup => {
    const key = `${botId}\u0000${symbol}`;
    const existing = groups.get(key);
    if (existing) return existing;
    const created: ClaimGroup = {
      positionQuantity: 0,
      claimedQuantity: 0,
      hasWaitingSell: false,
      pendingBuyQuantity: 0,
      activeSells: [],
      scheduledSells: [],
    };
    groups.set(key, created);
    return created;
  };

  for (const chain of chains) {
    const group = groupFor(chain.botId, chain.symbol);
    for (const row of chain.positionRows) group.positionQuantity += nonNegative(row.quantity);
  }

  for (const chain of chains) {
    const group = groupFor(chain.botId, chain.symbol);
    for (const row of chain.activeRows) {
      if (!row.isWaiting) continue;
      if (row.direction === 'buy') {
        group.pendingBuyQuantity += nonNegative(row.quantity);
        continue;
      }
      group.hasWaitingSell = true;
      group.claimedQuantity +=
        row.quantity === null ? group.positionQuantity : nonNegative(row.quantity);
      (row.source === 'scheduled' ? group.scheduledSells : group.activeSells).push(row);
    }
  }

  return chains.map((chain) => {
    const group = groupFor(chain.botId, chain.symbol);
    const hasPosition = group.positionQuantity > 0;
    const hasProjectedShares = hasPosition || group.pendingBuyQuantity > 0;
    const projectedBase = group.positionQuantity + group.pendingBuyQuantity;
    const projectedSellable = applySellClaims(
      projectedBase,
      group.activeSells,
      group.scheduledSells,
    );
    const sellEditCeilingByRowKey: Record<string, number> = {};
    for (const row of group.activeSells) {
      sellEditCeilingByRowKey[row.key] = applySellClaims(
        group.positionQuantity,
        group.activeSells.filter((candidate) => candidate.rawId !== row.rawId),
        group.scheduledSells,
      );
    }
    for (const row of group.scheduledSells) {
      sellEditCeilingByRowKey[row.key] = applySellClaims(
        projectedBase,
        group.activeSells,
        group.scheduledSells.filter((candidate) => candidate.rawId !== row.rawId),
      );
    }
    const hasOpenPositionWithoutExit =
      chain.positionRows.length > 0 && hasPosition && !group.hasWaitingSell;
    const hasWaitingBuyWithoutExit =
      chain.tradeRows.length === 0 &&
      chain.activeRows.some((row) => row.direction === 'buy' && row.isWaiting) &&
      !chain.activeRows.some((row) => row.direction === 'sell' && row.isWaiting) &&
      chain.canceledRows.some(
        (row) =>
          row.direction === 'sell' &&
          row.parentClientOrderId !== null &&
          chain.activeRows.some(
            (candidate) =>
              candidate.direction === 'buy' &&
              candidate.isWaiting &&
              candidate.clientOrderId === row.parentClientOrderId,
          ),
      );

    return {
      ...chain,
      positionQuantity: hasPosition ? group.positionQuantity : null,
      sellableQuantity: hasPosition
        ? Math.max(0, group.positionQuantity - group.claimedQuantity)
        : null,
      projectedSellableQuantity: hasProjectedShares ? projectedSellable : null,
      sellEditCeilingByRowKey,
      hasNoClosingOrder: hasOpenPositionWithoutExit || hasWaitingBuyWithoutExit,
    };
  });
}

function applySellClaims(
  base: number,
  activeSells: readonly BookActiveOrderRow[],
  scheduledSells: readonly BookActiveOrderRow[],
): number {
  let available = base;
  for (const row of activeSells) available -= nonNegative(row.quantity);
  for (const row of scheduledSells) {
    available =
      row.quantity === null ? Math.min(available, 0) : available - nonNegative(row.quantity);
  }
  return Math.max(0, available);
}

export function compareBookChains(left: BookChain, right: BookChain): number {
  if (left.batchDate === null && right.batchDate !== null) return 1;
  if (left.batchDate !== null && right.batchDate === null) return -1;

  if (left.batchDate !== right.batchDate) {
    return compareText(right.batchDate ?? '', left.batchDate ?? '');
  }

  const botComparison = compareText(left.botId, right.botId);
  if (botComparison !== 0) return botComparison;

  return compareText(left.key, right.key);
}

function addRecord<Source extends keyof MutableChainSources>(
  linked: Map<string, ChainAccumulator>,
  unlinked: ChainAccumulator[],
  chainId: string | null,
  unlinkedKey: string,
  record: { source: Source; raw: MutableChainSources[Source][number] },
  rows: readonly BookChainRow[],
): void {
  let accumulator: ChainAccumulator;

  if (chainId === null) {
    accumulator = createAccumulator(unlinkedKey, null);
    unlinked.push(accumulator);
  } else {
    const key = `chain:${chainId}`;
    accumulator = linked.get(chainId) ?? createAccumulator(key, chainId);
    linked.set(chainId, accumulator);
  }

  // The generic index cannot preserve the correlation between Source and its array here.
  // Each call above supplies a source/raw pair from the matching API contract.
  (accumulator.sources[record.source] as Array<typeof record.raw>).push(record.raw);
  accumulator.rows.push(...rows);
}

function createAccumulator(key: string, chainId: string | null): ChainAccumulator {
  return {
    key,
    chainId,
    sources: {
      activeOrders: [],
      canceledOrders: [],
      positions: [],
      closedTrades: [],
    },
    rows: [],
  };
}

function normalizeActiveOrder(order: ActiveOrder): BookActiveOrderRow {
  const scheduled = order.status === 'Scheduled';

  return {
    key: `order:${stableSourceIdentity(order.clientOrderId, order.id)}`,
    rawId: order.id,
    source: scheduled ? 'scheduled' : 'active',
    raw: order,
    chainId: order.chainId,
    botId: order.botId,
    symbol: order.symbol,
    clientOrderId: order.clientOrderId,
    parentClientOrderId: order.parentClientOrderId ?? null,
    retryOfClientOrderId: order.retryOfClientOrderId,
    direction: order.direction,
    quantity: order.orderQuantity,
    filledQuantity: order.filledQuantity,
    canceledQuantity: null,
    orderType: order.type,
    intentType: order.intentType,
    orderPrice: order.orderPrice,
    averagePrice: order.filledQuantity > 0 ? order.averagePrice : null,
    orderTime: order.orderTime,
    acknowledgementTime: null,
    scheduledTime: order.scheduledTime ?? null,
    status: order.status,
    isWaiting: isWaitingOrderStatus(order.status),
    cancelInFlight: order.cancelSource !== null,
  };
}

function normalizeCanceledOrder(order: CanceledOrder): BookCanceledOrderRow {
  return {
    key: `canceled-order:${stableSourceIdentity(order.clientOrderId, order.id)}`,
    rawId: order.id,
    source: 'canceled',
    raw: order,
    chainId: order.chainId,
    botId: order.botId,
    symbol: order.symbol,
    clientOrderId: order.clientOrderId,
    parentClientOrderId: order.parentClientOrderId ?? null,
    retryOfClientOrderId: order.retryOfClientOrderId,
    direction: order.direction,
    quantity: order.orderQuantity,
    filledQuantity: null,
    canceledQuantity: order.canceledQuantity,
    orderType: order.type,
    intentType: order.intentType,
    orderPrice: order.orderPrice,
    averagePrice: null,
    orderTime: order.orderTime,
    acknowledgementTime: order.cancelTime,
    scheduledTime: null,
    status: order.status,
    isWaiting: false,
    cancelInFlight: false,
  };
}

function normalizePosition(position: Position): BookPositionRow {
  return {
    key: `position:${stableSourceIdentity(
      position.positionId ?? position.clientOrderId,
      position.id,
    )}`,
    rawId: position.id,
    source: 'position',
    raw: position,
    chainId: position.chainId,
    botId: position.botId,
    symbol: position.symbol,
    clientOrderId: position.clientOrderId,
    parentClientOrderId: null,
    retryOfClientOrderId: position.retryOfClientOrderId,
    direction: 'buy',
    quantity: position.quantity,
    filledQuantity: position.quantity,
    canceledQuantity: null,
    orderType: null,
    intentType: null,
    orderPrice: position.orderPrice,
    averagePrice: position.averagePrice,
    orderTime: position.orderTime,
    acknowledgementTime: position.executeTime,
    scheduledTime: null,
    status: 'Position',
    isWaiting: false,
    cancelInFlight: false,
  };
}

function normalizeClosedTrade(trade: ClosedTrade): [BookClosedTradeRow, BookClosedTradeRow] {
  const shared = {
    rawId: trade.id,
    source: 'closed-trade' as const,
    raw: trade,
    chainId: trade.chainId,
    botId: trade.botId,
    symbol: trade.symbol,
    parentClientOrderId: null,
    quantity: trade.quantity,
    filledQuantity: trade.quantity,
    canceledQuantity: null,
    orderType: null,
    intentType: null,
    scheduledTime: null,
    isWaiting: false,
    cancelInFlight: false,
  };

  return [
    {
      ...shared,
      key: `closed-trade:${trade.id}:open`,
      leg: 'open',
      clientOrderId: trade.clientOpenOrderId,
      retryOfClientOrderId: trade.openRetryOfClientOrderId,
      direction: 'buy',
      orderPrice: trade.openOrderPrice,
      averagePrice: trade.averageOpenPrice,
      orderTime: trade.openOrderTime,
      acknowledgementTime: trade.openExecuteTime,
      status: 'Closed',
    },
    {
      ...shared,
      key: `closed-trade:${trade.id}:close`,
      leg: 'close',
      clientOrderId: trade.clientCloseOrderId,
      retryOfClientOrderId: trade.closeRetryOfClientOrderId,
      direction: 'sell',
      orderPrice: trade.closeOrderPrice,
      averagePrice: trade.averageClosePrice,
      orderTime: trade.closeOrderTime,
      acknowledgementTime: trade.closeExecuteTime,
      status: 'Closed',
    },
  ];
}

function finalizeChain(accumulator: ChainAccumulator): BookChain {
  const rows = [...accumulator.rows].sort(compareRows);
  const activeRows = rows.filter(isActiveRow);
  const canceledRows = rows.filter(isCanceledRow);
  const positionRows = rows.filter(isPositionRow);
  const tradeRows = rows.filter(isTradeRow);
  const representative = rows[0];

  if (representative === undefined) {
    throw new Error(`Cannot finalize empty Book chain ${accumulator.key}.`);
  }

  const batchTimestamp = findBatchTimestamp(rows, accumulator.chainId);
  const waitingSellRows = activeRows.filter((row) => row.direction === 'sell' && row.isWaiting);
  const positionQuantity =
    positionRows.length === 0
      ? null
      : positionRows.reduce((total, row) => total + nonNegative(row.quantity), 0);
  const claimedQuantity = waitingSellRows.reduce((total, row) => {
    // The API only permits a null quantity on scheduled sells. Treat any live null
    // conservatively too: unknown shares must not become available to another sell.
    const claim = row.quantity === null ? (positionQuantity ?? 0) : nonNegative(row.quantity);
    return total + claim;
  }, 0);
  const sellableQuantity =
    positionQuantity === null ? null : Math.max(0, positionQuantity - claimedQuantity);
  const hasWaitingSell = waitingSellRows.length > 0;
  const waitingBuyIds = new Set(
    activeRows
      .filter((row) => row.direction === 'buy' && row.isWaiting)
      .map((row) => row.clientOrderId)
      .filter((clientOrderId): clientOrderId is string => clientOrderId !== null),
  );
  const hasCanceledReversingExit = canceledRows.some(
    (row) =>
      row.direction === 'sell' &&
      row.parentClientOrderId !== null &&
      waitingBuyIds.has(row.parentClientOrderId),
  );
  const hasOpenPositionWithoutExit =
    positionQuantity !== null && positionQuantity > 0 && !hasWaitingSell;
  const hasWaitingBuyWithoutExit =
    tradeRows.length === 0 && waitingBuyIds.size > 0 && !hasWaitingSell && hasCanceledReversingExit;
  const scope = classifyBookChain({
    hasPosition: positionRows.length > 0,
    hasTrade: tradeRows.length > 0,
    hasWaitingOrder: activeRows.some((row) => row.isWaiting),
    hasCanceled: canceledRows.length > 0,
  });

  return {
    key: accumulator.key,
    chainId: accumulator.chainId,
    botId: representative.botId,
    symbol: representative.symbol,
    batchDate: toIstanbulDate(batchTimestamp),
    batchTimestamp,
    rows,
    activeRows,
    canceledRows,
    positionRows,
    tradeRows,
    sources: {
      activeOrders: [...accumulator.sources.activeOrders],
      canceledOrders: [...accumulator.sources.canceledOrders],
      positions: [...accumulator.sources.positions],
      closedTrades: [...accumulator.sources.closedTrades],
    },
    scope,
    positionQuantity,
    sellableQuantity,
    projectedSellableQuantity: sellableQuantity,
    sellEditCeilingByRowKey: {},
    hasNoClosingOrder: hasOpenPositionWithoutExit || hasWaitingBuyWithoutExit,
  };
}

function findBatchTimestamp(rows: readonly BookChainRow[], chainId: string | null): number | null {
  if (chainId !== null) {
    const rootTimes = rows
      .filter(
        (row) =>
          row.direction === 'buy' &&
          row.clientOrderId === chainId &&
          openingTimestamp(row) !== null,
      )
      .map(openingTimestamp);
    const rootTime = earliest(rootTimes);
    if (rootTime !== null) return rootTime;
  }

  const openingTime = earliest(rows.filter((row) => row.direction === 'buy').map(openingTimestamp));
  if (openingTime !== null) return openingTime;

  // An unlinked sell has no known opening order. It is its own chain, so its own
  // timestamp is the only honest date available; no other row is matched to it.
  return earliest(rows.map(rowTimestamp));
}

function openingTimestamp(row: BookChainRow): number | null {
  if (row.source === 'scheduled') {
    return firstTimestamp(row.scheduledTime, row.orderTime, row.raw.sentTime);
  }
  if (row.source === 'active') {
    return firstTimestamp(row.orderTime, row.raw.sentTime);
  }
  if (row.source === 'canceled') {
    return firstTimestamp(row.orderTime, row.raw.sentTime, row.acknowledgementTime);
  }
  return firstTimestamp(row.orderTime, row.acknowledgementTime);
}

function rowTimestamp(row: BookChainRow): number | null {
  return firstTimestamp(row.orderTime, row.scheduledTime, row.acknowledgementTime);
}

function compareRows(left: BookChainRow, right: BookChainRow): number {
  const rankComparison = rowRank(left) - rowRank(right);
  if (rankComparison !== 0) return rankComparison;

  const leftTime = rowTimestamp(left);
  const rightTime = rowTimestamp(right);
  if (leftTime === null && rightTime !== null) return 1;
  if (leftTime !== null && rightTime === null) return -1;
  if (leftTime !== rightTime) return (leftTime ?? 0) - (rightTime ?? 0);

  return compareText(left.key, right.key);
}

function rowRank(row: BookChainRow): number {
  if (row.source === 'position' || (row.source === 'closed-trade' && row.leg === 'open')) {
    return 0;
  }
  if (row.source === 'active' || row.source === 'scheduled') {
    return row.direction === 'buy' ? 1 : 2;
  }
  if (row.source === 'closed-trade') return 2;
  return 3;
}

function isActiveRow(row: BookChainRow): row is BookActiveOrderRow {
  return row.source === 'active' || row.source === 'scheduled';
}

function isCanceledRow(row: BookChainRow): row is BookCanceledOrderRow {
  return row.source === 'canceled';
}

function isPositionRow(row: BookChainRow): row is BookPositionRow {
  return row.source === 'position';
}

function isTradeRow(row: BookChainRow): row is BookClosedTradeRow {
  return row.source === 'closed-trade';
}

function unlinkedOrderKey(
  clientOrderId: string | null,
  id: number,
  source: 'active' | 'canceled',
): string {
  return `unlinked:${source}-order:${stableSourceIdentity(clientOrderId, id)}`;
}

function stableSourceIdentity(identity: string | null, id: number): string {
  return identity === null || identity.trim() === ''
    ? `row-${id}`
    : `client-${encodeURIComponent(identity)}`;
}

function firstTimestamp(...timestamps: Array<number | null | undefined>): number | null {
  return (
    timestamps.find(
      (timestamp): timestamp is number =>
        timestamp !== null && timestamp !== undefined && Number.isFinite(timestamp),
    ) ?? null
  );
}

function earliest(timestamps: readonly (number | null)[]): number | null {
  let result: number | null = null;
  for (const timestamp of timestamps) {
    if (timestamp !== null && (result === null || timestamp < result)) result = timestamp;
  }
  return result;
}

function nonNegative(value: number | null): number {
  return value === null ? 0 : Math.max(0, value);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
