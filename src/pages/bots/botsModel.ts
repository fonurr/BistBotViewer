import type {
  ActiveOrder,
  Bot,
  BotBudget,
  ClosedTrade,
  ConfigureBotRequest,
  PendingOrderRequest,
  Position,
} from '../../bistApi/types';
import { isWaitingOrderStatus } from '../../domain/chains';
import { parseTurkishNumber } from '../../domain/format';
import {
  committedAmount,
  deriveFilledPnlState,
  pnlPercentage,
  realizedPnl,
  unrealizedPnl,
} from '../../domain/orders';
import type { ResolvedPrice } from '../../priceApi/types';

export type BotCardState = 'healthy' | 'incomplete' | 'deactivated';
export type BotStatusAction = 'delete' | 'deactivate' | 'reactivate' | 'blocked';

export interface BotRowCounts {
  activeOrders: number;
  scheduledOrders: number;
  positions: number;
  closedTrades: number;
  pendingRequests: number;
}

export interface BotCardSummary {
  botId: string;
  openBuys: number;
  scheduledBuys: number;
  openPositions: number;
  openSells: number;
  scheduledSells: number;
  closedTrades: number;
  realized: number;
  realizedPercentage: number | null;
  rowCounts: BotRowCounts;
}

export interface UnrealizedResult {
  value: number | null;
  reason: 'feed' | 'quote' | null;
}

export interface BotFormState {
  id: string;
  algoritmId: string;
  accountId: string;
  brokerageId: string;
  limit: string;
  limitPercentage: string;
  limitPerPosition: string;
  limitPercentagePerPosition: string;
  emails: string;
  emailsSet: boolean;
  forbiddenStocks: string[];
  description: string;
}

export interface BotFormContext {
  original: Bot | null;
  existingBotIds: ReadonlySet<string>;
  accountLocked: boolean;
  committed: number | null;
}

export interface BotFormValidation {
  request: ConfigureBotRequest | null;
  blockReason: string | null;
  /**
   * True when the only thing stopping the write is that the form still matches
   * the stored record. Nothing is wrong, so the reason is not drawn as a fault.
   */
  unchanged: boolean;
  missingFields: string[];
  changedFields: string[];
}

const CREATE_DEFAULTS = {
  limit: 100_000,
  limitPercentage: 100,
  limitPerPosition: 20_000,
  limitPercentagePerPosition: 100,
} as const;

const formNumberFormatter = new Intl.NumberFormat('tr-TR', {
  useGrouping: true,
  maximumFractionDigits: 20,
});

export function getBotCardState(bot: Bot): BotCardState {
  if (!bot.active) return 'deactivated';
  return bot.complete ? 'healthy' : 'incomplete';
}

export function summarizeBot(
  botId: string,
  activeOrders: readonly ActiveOrder[],
  positions: readonly Position[],
  closedTrades: readonly ClosedTrade[],
  pendingRequests: readonly PendingOrderRequest[] = [],
): BotCardSummary {
  const botOrders = activeOrders.filter((row) => row.botId === botId);
  const botPositions = positions.filter((row) => row.botId === botId);
  const botTrades = closedTrades.filter((row) => row.botId === botId);
  const botPendingRequests = pendingRequests.filter((row) => row.botId === botId);
  const isScheduled = (row: ActiveOrder) => row.status === 'Scheduled';
  // The card's buys and sells are the live counts, so only a row that can still
  // execute belongs in them; a terminal row still sitting in GetActiveOrders is
  // not an open order. rowCounts below stays a raw row count, because it is what
  // decides delete versus deactivate (SPEC 4).
  const isOpen = (row: ActiveOrder) => !isScheduled(row) && isWaitingOrderStatus(row.status);
  const filledState = deriveFilledPnlState(botPositions, botOrders, botTrades);
  const closedRealized = botTrades.reduce(
    (sum, row) => sum + realizedPnl(row.quantity, row.averageOpenPrice, row.averageClosePrice),
    0,
  );
  const partialRealized = filledState.partialSellFills.reduce(
    (sum, fill) => sum + realizedPnl(fill.quantity, fill.averageOpenPrice, fill.averageClosePrice),
    0,
  );
  const realized = closedRealized + partialRealized;
  const costBasis =
    botTrades.reduce((sum, row) => sum + row.quantity * row.averageOpenPrice, 0) +
    filledState.partialSellFills.reduce(
      (sum, fill) => sum + fill.quantity * fill.averageOpenPrice,
      0,
    );

  return {
    botId,
    openBuys: botOrders.filter((row) => row.direction === 'buy' && isOpen(row)).length,
    scheduledBuys: botOrders.filter((row) => row.direction === 'buy' && isScheduled(row)).length,
    openPositions: botPositions.length,
    openSells: botOrders.filter((row) => row.direction === 'sell' && isOpen(row)).length,
    scheduledSells: botOrders.filter((row) => row.direction === 'sell' && isScheduled(row)).length,
    closedTrades: botTrades.length,
    realized,
    realizedPercentage: pnlPercentage(realized, costBasis),
    rowCounts: {
      activeOrders: botOrders.filter((row) => !isScheduled(row)).length,
      scheduledOrders: botOrders.filter(isScheduled).length,
      positions: botPositions.length,
      closedTrades: botTrades.length,
      pendingRequests: botPendingRequests.length,
    },
  };
}

export function statusActionFor(bot: Bot, counts: BotRowCounts): BotStatusAction {
  if (!bot.active) return counts.pendingRequests > 0 ? 'blocked' : 'reactivate';
  if (hasPersistentRows(counts)) return 'deactivate';
  return counts.pendingRequests > 0 ? 'blocked' : 'delete';
}

export function hasPersistentRows(counts: BotRowCounts): boolean {
  return counts.activeOrders + counts.scheduledOrders + counts.positions + counts.closedTrades > 0;
}

export function calculateUnrealized(
  positions: readonly Position[],
  prices: ReadonlyMap<string, ResolvedPrice>,
  feedTrustworthy: boolean,
  activeOrders: readonly ActiveOrder[] = [],
  closedTrades: readonly ClosedTrade[] = [],
): UnrealizedResult {
  const exposures = deriveFilledPnlState(positions, activeOrders, closedTrades).exposures;
  if (exposures.length === 0) return { value: 0, reason: null };
  if (!feedTrustworthy) return { value: null, reason: 'feed' };

  let total = 0;
  for (const exposure of exposures) {
    const price = prices.get(exposure.symbol.toUpperCase());
    if (!price) {
      return { value: null, reason: 'quote' };
    }
    total += unrealizedPnl(exposure, price.price);
  }
  return { value: total, reason: null };
}

export function newBotForm(): BotFormState {
  return {
    id: '',
    algoritmId: '',
    accountId: '',
    brokerageId: '',
    limit: formNumberFormatter.format(CREATE_DEFAULTS.limit),
    limitPercentage: formNumberFormatter.format(CREATE_DEFAULTS.limitPercentage),
    limitPerPosition: formNumberFormatter.format(CREATE_DEFAULTS.limitPerPosition),
    limitPercentagePerPosition: formNumberFormatter.format(
      CREATE_DEFAULTS.limitPercentagePerPosition,
    ),
    emails: '',
    emailsSet: false,
    forbiddenStocks: [],
    description: '',
  };
}

export function botFormFor(bot: Bot): BotFormState {
  return {
    id: bot.id,
    algoritmId: bot.algoritmId ?? '',
    accountId: bot.accountId ?? '',
    brokerageId: bot.brokerageId ?? '',
    limit: formNumberFormatter.format(bot.limit),
    limitPercentage: formNumberFormatter.format(bot.limitPercentage),
    limitPerPosition: formNumberFormatter.format(bot.limitPerPosition),
    limitPercentagePerPosition: formNumberFormatter.format(bot.limitPercentagePerPosition),
    emails: bot.emails?.join(', ') ?? '',
    emailsSet: bot.emails !== null,
    forbiddenStocks: [...bot.forbiddenStocks],
    description: bot.description ?? '',
  };
}

export function parseEmails(raw: string): string[] {
  return raw
    .split(/[;,\n]/)
    .map((value) => value.trim())
    .filter(Boolean);
}

export function validateBotForm(form: BotFormState, context: BotFormContext): BotFormValidation {
  const id = form.id.trim();
  const algoritmId = form.algoritmId.trim();
  const accountId = form.accountId.trim();
  const brokerageId = form.brokerageId.trim();
  const halfAccount = Boolean(accountId) !== Boolean(brokerageId);
  const limit = parseTurkishNumber(form.limit);
  const limitPercentage = parseTurkishNumber(form.limitPercentage);
  const limitPerPosition = parseTurkishNumber(form.limitPerPosition);
  const limitPercentagePerPosition = parseTurkishNumber(form.limitPercentagePerPosition);
  const emails = parseEmails(form.emails);
  const original = context.original;

  const missingFields: string[] = [];
  if (!algoritmId) missingFields.push('algorithm id');
  if (!accountId || !brokerageId) missingFields.push('account and brokerage');
  if (!form.emailsSet) missingFields.push('emails');

  let blockReason: string | null = null;
  if (!id) {
    blockReason =
      'An id is required. It is the key every other endpoint takes and cannot change later.';
  } else if (!original && id === '*') {
    blockReason = 'The id * is reserved for all-bot reads and cannot be registered as a bot.';
  } else if (!original && context.existingBotIds.has(id)) {
    blockReason = `${id} already exists. Use Edit so Add cannot silently update an existing bot.`;
  } else if (original && id !== original.id) {
    blockReason = 'The bot id is immutable after creation.';
  } else if (halfAccount) {
    blockReason = 'Fill both account fields or clear both.';
  } else if (original !== null && original.algoritmId !== null && !algoritmId) {
    blockReason = 'An existing algorithm id cannot be blanked; ConfigureBot can only omit it.';
  } else if (
    original !== null &&
    (original.accountId !== null || original.brokerageId !== null) &&
    !accountId &&
    !brokerageId
  ) {
    blockReason =
      'An existing account and brokerage cannot be blanked; ConfigureBot can only omit them.';
  } else if (
    context.accountLocked &&
    original !== null &&
    (accountId !== (original.accountId ?? '') || brokerageId !== (original.brokerageId ?? ''))
  ) {
    blockReason =
      'Account and brokerage are locked while this bot has active, scheduled, or position rows.';
  } else if (limit === null || limit <= 0) {
    blockReason =
      'A positive TL limit is required. It caps active orders plus open positions together.';
  } else if (limitPerPosition === null || limitPerPosition <= 0) {
    blockReason = 'A positive per-stock TL cap is required.';
  } else if (
    limitPercentage === null ||
    limitPercentage <= 0 ||
    limitPercentage > 100 ||
    limitPercentagePerPosition === null ||
    limitPercentagePerPosition <= 0 ||
    limitPercentagePerPosition > 100
  ) {
    blockReason = 'Percentages are shares of portfolio value and must be between 1 and 100.';
  } else if (
    original !== null &&
    limit !== original.limit &&
    original.complete &&
    context.committed === null
  ) {
    blockReason =
      'The committed amount is unavailable, so a changed total limit cannot be checked safely.';
  } else if (context.committed !== null && limit < context.committed) {
    blockReason = `The limit cannot be lower than the ${context.committed.toLocaleString('tr-TR')} TL already committed.`;
  }

  if (
    blockReason ||
    limit === null ||
    limitPercentage === null ||
    limitPerPosition === null ||
    limitPercentagePerPosition === null
  ) {
    return { request: null, blockReason, unchanged: false, missingFields, changedFields: [] };
  }

  const request: ConfigureBotRequest = { id };
  const changedFields: string[] = [];
  const include = <Key extends Exclude<keyof ConfigureBotRequest, 'id'>>(
    key: Key,
    value: ConfigureBotRequest[Key],
  ) => {
    request[key] = value;
    changedFields.push(key);
  };

  if (!original) {
    if (algoritmId) include('algoritmId', algoritmId);
    if (accountId && brokerageId) {
      include('accountId', accountId);
      include('brokerageId', brokerageId);
    }
    if (limit !== CREATE_DEFAULTS.limit) include('limit', limit);
    if (limitPercentage !== CREATE_DEFAULTS.limitPercentage) {
      include('limitPercentage', limitPercentage);
    }
    if (limitPerPosition !== CREATE_DEFAULTS.limitPerPosition) {
      include('limitPerPosition', limitPerPosition);
    }
    if (limitPercentagePerPosition !== CREATE_DEFAULTS.limitPercentagePerPosition) {
      include('limitPercentagePerPosition', limitPercentagePerPosition);
    }
    if (form.emailsSet) include('emails', emails);
    if (form.forbiddenStocks.length > 0) {
      include('forbiddenStocks', [...form.forbiddenStocks]);
    }
    if (form.description.length > 0) include('description', form.description);
  } else {
    if (algoritmId && algoritmId !== original.algoritmId) include('algoritmId', algoritmId);
    if (
      accountId &&
      brokerageId &&
      (accountId !== original.accountId || brokerageId !== original.brokerageId)
    ) {
      include('accountId', accountId);
      include('brokerageId', brokerageId);
    }
    if (limit !== original.limit) include('limit', limit);
    if (limitPercentage !== original.limitPercentage) {
      include('limitPercentage', limitPercentage);
    }
    if (limitPerPosition !== original.limitPerPosition) {
      include('limitPerPosition', limitPerPosition);
    }
    if (limitPercentagePerPosition !== original.limitPercentagePerPosition) {
      include('limitPercentagePerPosition', limitPercentagePerPosition);
    }
    if (form.emailsSet && (original.emails === null || !sameList(emails, original.emails))) {
      include('emails', emails);
    }
    if (!sameList(form.forbiddenStocks, original.forbiddenStocks)) {
      include('forbiddenStocks', [...form.forbiddenStocks]);
    }
    if (form.description !== (original.description ?? '')) {
      include('description', form.description);
    }
  }

  if (original && changedFields.length === 0) {
    return {
      request: null,
      blockReason: 'Nothing has changed yet, so there is nothing to send.',
      unchanged: true,
      missingFields,
      changedFields,
    };
  }

  return { request, blockReason: null, unchanged: false, missingFields, changedFields };
}

/**
 * `API.md`: effective per-stock cap = min(limitPerPosition, portfolioValue x
 * limitPercentagePerPosition / 100). Neither number alone predicts the order
 * size, so the form has to state the one that actually binds (SPEC 7).
 */
export function effectivePerPositionCap(
  limitPerPosition: number | null,
  limitPercentagePerPosition: number | null,
  portfolioValue: number | null,
): { value: number; bound: 'tl' | 'percentage' } | null {
  if (limitPerPosition === null || limitPercentagePerPosition === null) return null;
  if (portfolioValue === null || !Number.isFinite(portfolioValue)) return null;
  const fromPercentage = (portfolioValue * limitPercentagePerPosition) / 100;
  return fromPercentage < limitPerPosition
    ? { value: fromPercentage, bound: 'percentage' }
    : { value: limitPerPosition, bound: 'tl' };
}

export function committedForBudget(budget: BotBudget | undefined): number | null {
  return budget ? committedAmount(budget) : null;
}

export function requestMatchesBot(request: ConfigureBotRequest, bot: Bot): boolean {
  if (request.id !== bot.id) return false;
  return requestKeys(request).every((key) => sameValue(request[key], bot[key]));
}

export function requestMatchesCreatedBot(request: ConfigureBotRequest, bot: Bot): boolean {
  if (request.id !== bot.id) return false;
  const expected = {
    algoritmId: request.algoritmId ?? null,
    accountId: request.accountId ?? null,
    brokerageId: request.brokerageId ?? null,
    limitPercentage: request.limitPercentage ?? CREATE_DEFAULTS.limitPercentage,
    limit: request.limit ?? CREATE_DEFAULTS.limit,
    limitPerPosition: request.limitPerPosition ?? CREATE_DEFAULTS.limitPerPosition,
    limitPercentagePerPosition:
      request.limitPercentagePerPosition ?? CREATE_DEFAULTS.limitPercentagePerPosition,
    emails: request.emails ?? null,
    forbiddenStocks: request.forbiddenStocks ?? [],
    active: request.active ?? true,
    description: request.description ?? null,
  };
  return Object.entries(expected).every(([key, value]) =>
    sameValue(value, bot[key as keyof typeof expected]),
  );
}

export function conflictingChangedFields(
  original: Bot,
  fresh: Bot,
  request: ConfigureBotRequest,
): string[] {
  return requestKeys(request).filter(
    (key) => !sameValue(original[key], fresh[key]) && !sameValue(request[key], fresh[key]),
  );
}

export function sameBotConfiguration(left: Bot, right: Bot): boolean {
  const keys: Array<Exclude<keyof ConfigureBotRequest, 'id' | 'active'>> = [
    'algoritmId',
    'accountId',
    'brokerageId',
    'limitPercentage',
    'limit',
    'limitPerPosition',
    'limitPercentagePerPosition',
    'emails',
    'forbiddenStocks',
    'description',
  ];
  return left.id === right.id && keys.every((key) => sameValue(left[key], right[key]));
}

export function sameBotStoredRecord(left: Bot, right: Bot): boolean {
  return sameBotConfiguration(left, right) && left.active === right.active;
}

function requestKeys(
  request: ConfigureBotRequest,
): Array<Exclude<keyof ConfigureBotRequest, 'id'>> {
  return Object.keys(request).filter(
    (key): key is Exclude<keyof ConfigureBotRequest, 'id'> => key !== 'id',
  );
}

function sameValue(left: unknown, right: unknown): boolean {
  if (Array.isArray(left) && Array.isArray(right)) return sameList(left, right);
  return left === right;
}

function sameList(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}
