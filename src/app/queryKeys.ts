import type { BotSelector } from '../bistApi/types';

function selectorKey(selector: BotSelector): readonly [string, ...string[]] {
  if (selector === '*') return ['all'];
  return typeof selector === 'string' ? ['one', selector] : ['many', ...[...selector].sort()];
}

export function selectorIncludes(key: unknown, botId: string): boolean {
  if (!Array.isArray(key)) return false;
  if (key[0] === 'all') return true;
  if (key[0] === 'one') return key.length === 2 && key[1] === botId;
  return key[0] === 'many' && key.slice(1).includes(botId);
}

export const bistKeys = {
  root: ['bist'] as const,
  bots: ['bist', 'bots'] as const,
  accounts: ['bist', 'accounts'] as const,
  holidays: ['bist', 'holidays'] as const,
  errors: (requestKey: string) => ['bist', 'errors', requestKey] as const,
  activeOrders: (selector: BotSelector) => ['bist', 'activeOrders', selectorKey(selector)] as const,
  canceledOrders: (selector: BotSelector) =>
    ['bist', 'canceledOrders', selectorKey(selector)] as const,
  positions: (selector: BotSelector) => ['bist', 'positions', selectorKey(selector)] as const,
  closedTrades: (selector: BotSelector) => ['bist', 'closedTrades', selectorKey(selector)] as const,
  pendingRequests: (selector: BotSelector) =>
    ['bist', 'pendingRequests', selectorKey(selector)] as const,
  budget: (botId: string) => ['bist', 'budget', botId] as const,
};

export const priceKeys = {
  root: ['price'] as const,
  status: ['price', 'status'] as const,
  quotes: (symbols: readonly string[]) =>
    ['price', 'quotes', [...symbols].sort().join(',')] as const,
  closingBars: (key: string) => ['price', 'closingBars', key] as const,
  latestBars: (symbols: readonly string[]) =>
    ['price', 'latestBars', [...symbols].sort().join(',')] as const,
};
