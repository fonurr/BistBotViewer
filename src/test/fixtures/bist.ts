import type {
  Account,
  ActiveOrder,
  Bot,
  BotBudget,
  CanceledOrder,
  ClosedTrade,
  ErrorRow,
  Holiday,
  PendingOrderRequest,
  Position,
} from '../../bistApi/types';
import type { AuctionBar, ProducerStatus, Quote } from '../../priceApi/types';

export const FIXTURE_NOW_MS = Date.parse('2026-08-25T09:00:00.000Z');
export const FIXTURE_DAY = '2026-08-25';

export interface BistReadFixture {
  bots: Bot[];
  accounts: Account[];
  activeOrders: ActiveOrder[];
  canceledOrders: CanceledOrder[];
  positions: Position[];
  closedTrades: ClosedTrade[];
  pendingOrderRequests: PendingOrderRequest[];
  holidays: Holiday[];
  errors: ErrorRow[];
  budgets: Record<string, BotBudget>;
}

export interface PriceReadFixture {
  status: ProducerStatus;
  quotes: Quote[];
  closingBars: AuctionBar[];
}

export function makeBot(overrides: Partial<Bot> = {}): Bot {
  return {
    id: 'bot-alpha',
    algoritmId: 'algo-alpha',
    accountId: 'ACC-1',
    brokerageId: 'BRK-1',
    limitPercentage: 100,
    limit: 500_000,
    limitPerPosition: 100_000,
    limitPercentagePerPosition: 100,
    emails: [],
    forbiddenStocks: [],
    active: true,
    description: 'Deterministic browser fixture',
    complete: true,
    ...overrides,
  };
}

export function makeAccount(overrides: Partial<Account> = {}): Account {
  return {
    accountId: 'ACC-1',
    owner: 'Fixture Owner',
    brokerageId: 'BRK-1',
    brokerageName: 'Fixture Brokerage',
    ...overrides,
  };
}

export function makeActiveOrder(overrides: Partial<ActiveOrder> = {}): ActiveOrder {
  return {
    id: 101,
    botId: 'bot-alpha',
    clientOrderId: 'client-akbnk-000001',
    matriksOrderId: 'mx-akbnk-000001',
    matriksOrderId2: null,
    symbol: 'AKBNK',
    orderTime: Date.parse('2026-08-25T07:30:00.000Z'),
    sentTime: Date.parse('2026-08-25T07:30:01.000Z'),
    orderQuantity: 40,
    filledQuantity: 0,
    direction: 'buy',
    type: 'limit',
    orderPrice: 68.25,
    averagePrice: 0,
    timeInForce: '0',
    status: 'New',
    cancelSource: null,
    retryCount: 0,
    intentType: 'limit',
    cancelAtFloor: false,
    scheduledTime: null,
    whenType: null,
    chainId: 'chain-akbnk',
    parentClientOrderId: null,
    retryOfClientOrderId: null,
    ...overrides,
  };
}

export function makePosition(overrides: Partial<Position> = {}): Position {
  return {
    id: 201,
    botId: 'bot-alpha',
    clientOrderId: 'client-thyao-open-000001',
    matriksOrderId: 'mx-thyao-open-000001',
    matriksOrderId2: null,
    positionId: 'position-thyao-000001',
    symbol: 'THYAO',
    orderTime: Date.parse('2026-08-25T06:55:00.000Z'),
    executeTime: Date.parse('2026-08-25T06:55:02.000Z'),
    orderQuantity: 100,
    quantity: 100,
    averagePrice: 301.5,
    orderPrice: 301,
    chainId: 'chain-thyao',
    retryOfClientOrderId: null,
    ...overrides,
  };
}

export function makeClosedTrade(overrides: Partial<ClosedTrade> = {}): ClosedTrade {
  return {
    id: 301,
    botId: 'bot-alpha',
    accountId: 'ACC-1',
    brokerageId: 'BRK-1',
    clientOpenOrderId: 'client-thyao-roundtrip-open',
    matriksOpenOrderId: 'mx-thyao-roundtrip-open',
    matriksOpenOrderId2: null,
    clientCloseOrderId: 'client-thyao-roundtrip-close',
    matriksCloseOrderId: 'mx-thyao-roundtrip-close',
    matriksCloseOrderId2: null,
    positionId: 'position-thyao-roundtrip',
    symbol: 'THYAO',
    openOrderTime: Date.parse('2026-08-25T06:30:00.000Z'),
    openExecuteTime: Date.parse('2026-08-25T06:30:02.000Z'),
    closeOrderTime: Date.parse('2026-08-25T08:00:00.000Z'),
    closeExecuteTime: Date.parse('2026-08-25T08:00:03.000Z'),
    quantity: 100,
    averageOpenPrice: 300,
    averageClosePrice: 306,
    openOrderPrice: 299.75,
    closeOrderPrice: 306.25,
    chainId: 'chain-thyao-roundtrip',
    openRetryOfClientOrderId: null,
    closeRetryOfClientOrderId: null,
    ...overrides,
  };
}

export function makeBotBudget(overrides: Partial<BotBudget> = {}): BotBudget {
  return {
    portfolioValue: 1_000_000,
    accountBuyingPower: 750_000,
    remainingBotBudget: 420_000,
    limitPercentage: 100,
    limit: 500_000,
    limitPerPosition: 100_000,
    limitPercentagePerPosition: 100,
    ...overrides,
  };
}

export function makePriceStatus(overrides: Partial<ProducerStatus> = {}): ProducerStatus {
  return {
    feed: 'live',
    feed_age_ms: 250,
    producer_uptime_s: 3_600,
    reconnects: 0,
    tracked_symbols: 1,
    server_ts: FIXTURE_NOW_MS,
    ...overrides,
  };
}

export function makeQuote(overrides: Partial<Quote> = {}): Quote {
  return {
    symbol: 'THYAO',
    son: 305.5,
    ghacim_try: 18_500_000,
    quote_age_ms: 250,
    price_change_age_ms: 250,
    trade_age_ms: 250,
    feed: 'live',
    server_ts: FIXTURE_NOW_MS,
    ...overrides,
  };
}

export function makeBookReadFixture(): BistReadFixture {
  const bot = makeBot();
  return {
    bots: [bot],
    accounts: [makeAccount()],
    activeOrders: [makeActiveOrder()],
    canceledOrders: [],
    positions: [makePosition()],
    closedTrades: [],
    pendingOrderRequests: [],
    holidays: [],
    errors: [],
    budgets: { [bot.id]: makeBotBudget() },
  };
}

export function makePerformanceReadFixture(): BistReadFixture {
  const bot = makeBot();
  return {
    bots: [bot],
    accounts: [makeAccount()],
    activeOrders: [],
    canceledOrders: [],
    positions: [],
    closedTrades: [makeClosedTrade()],
    pendingOrderRequests: [],
    // These bounds prove coverage for the selected 25 August window without
    // removing that session from the report.
    holidays: [
      { date: '2026-08-24', type: 'half' },
      { date: '2026-08-26', type: 'half' },
    ],
    errors: [],
    budgets: { [bot.id]: makeBotBudget() },
  };
}

export function makePriceReadFixture(overrides: Partial<PriceReadFixture> = {}): PriceReadFixture {
  return {
    status: makePriceStatus(),
    quotes: [makeQuote()],
    closingBars: [],
    ...overrides,
  };
}
