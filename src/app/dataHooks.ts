import { useQueries, useQuery } from '@tanstack/react-query';
import { useEffect, useId } from 'react';

import { bistApi } from '../bistApi/client';
import type { Bot, BotBudget } from '../bistApi/types';
import { priceApi } from '../priceApi/client';
import type { PriceFeedState, Quote } from '../priceApi/types';
import { bistKeys, priceKeys } from './queryKeys';
import { useViewerRuntime, type PriceHealth } from './ViewerRuntime';

const allBots = '*' as const;

export function useBookData() {
  const results = useQueries({
    queries: [
      { queryKey: bistKeys.bots, queryFn: bistApi.getBots },
      { queryKey: bistKeys.accounts, queryFn: bistApi.getAccounts },
      {
        queryKey: bistKeys.activeOrders(allBots),
        queryFn: () => bistApi.getActiveOrders(allBots),
      },
      {
        queryKey: bistKeys.canceledOrders(allBots),
        queryFn: () => bistApi.getCanceledOrders(allBots),
      },
      {
        queryKey: bistKeys.positions(allBots),
        queryFn: () => bistApi.getPositions(allBots),
      },
      {
        queryKey: bistKeys.closedTrades(allBots),
        queryFn: () => bistApi.getClosedTrades(allBots),
      },
      {
        queryKey: bistKeys.pendingRequests(allBots),
        queryFn: () => bistApi.getPendingOrderRequests(allBots),
      },
      { queryKey: bistKeys.holidays, queryFn: bistApi.getHolidays },
      {
        queryKey: bistKeys.errors('recent-escalations'),
        queryFn: () => bistApi.getErrors({ since: Date.now() - 24 * 60 * 60 * 1_000, limit: 200 }),
      },
    ],
  });

  const [
    bots,
    accounts,
    activeOrders,
    canceledOrders,
    positions,
    closedTrades,
    pendingRequests,
    holidays,
    errors,
  ] = results;
  return {
    bots: bots.data ?? [],
    accounts: accounts.data ?? [],
    activeOrders: activeOrders.data ?? [],
    canceledOrders: canceledOrders.data ?? [],
    positions: positions.data ?? [],
    closedTrades: closedTrades.data ?? [],
    pendingRequests: pendingRequests.data ?? [],
    holidays: holidays.data ?? [],
    errors: errors.data ?? [],
    isPending: results.some((result) => result.isPending),
    isFetching: results.some((result) => result.isFetching),
    error: results.find((result) => result.error)?.error ?? null,
  };
}

export function useBotsData() {
  const results = useQueries({
    queries: [
      { queryKey: bistKeys.bots, queryFn: bistApi.getBots },
      { queryKey: bistKeys.accounts, queryFn: bistApi.getAccounts },
      {
        queryKey: bistKeys.activeOrders(allBots),
        queryFn: () => bistApi.getActiveOrders(allBots),
      },
      {
        queryKey: bistKeys.positions(allBots),
        queryFn: () => bistApi.getPositions(allBots),
      },
      {
        queryKey: bistKeys.closedTrades(allBots),
        queryFn: () => bistApi.getClosedTrades(allBots),
      },
      {
        queryKey: bistKeys.pendingRequests(allBots),
        queryFn: () => bistApi.getPendingOrderRequests(allBots),
      },
    ],
  });
  const [bots, accounts, activeOrders, positions, closedTrades, pendingRequests] = results;
  return {
    bots: bots.data ?? [],
    accounts: accounts.data ?? [],
    activeOrders: activeOrders.data ?? [],
    positions: positions.data ?? [],
    closedTrades: closedTrades.data ?? [],
    pendingRequests: pendingRequests.data ?? [],
    isPending: results.some((result) => result.isPending),
    error: results.find((result) => result.error)?.error ?? null,
  };
}

export function usePerformanceData() {
  const results = useQueries({
    queries: [
      { queryKey: bistKeys.bots, queryFn: bistApi.getBots },
      { queryKey: bistKeys.accounts, queryFn: bistApi.getAccounts },
      {
        queryKey: bistKeys.closedTrades(allBots),
        queryFn: () => bistApi.getClosedTrades(allBots),
      },
      {
        queryKey: bistKeys.canceledOrders(allBots),
        queryFn: () => bistApi.getCanceledOrders(allBots),
      },
      { queryKey: bistKeys.holidays, queryFn: bistApi.getHolidays },
    ],
  });
  const [bots, accounts, closedTrades, canceledOrders, holidays] = results;
  return {
    bots: bots.data ?? [],
    accounts: accounts.data ?? [],
    closedTrades: closedTrades.data ?? [],
    canceledOrders: canceledOrders.data ?? [],
    holidays: holidays.data ?? [],
    isPending: results.some((result) => result.isPending),
    error: results.find((result) => result.error)?.error ?? null,
  };
}

export interface BotBudgetsState {
  data: Map<string, BotBudget>;
  isPending: boolean;
  isFetching: boolean;
  error: unknown;
  complete: boolean;
}

export function useBotBudgets(bots: readonly Bot[], enabled = true): BotBudgetsState {
  const results = useQueries({
    queries: bots.map((bot) => ({
      queryKey: bistKeys.budget(bot.id),
      queryFn: () => bistApi.getBotBudget(bot.id),
      enabled: enabled && bot.complete,
      retry: false,
    })),
  });
  const budgets = new Map<string, BotBudget>();
  results.forEach((result, index) => {
    const bot = bots[index];
    if (
      enabled &&
      bot?.complete &&
      result.data &&
      !result.isFetching &&
      !result.isError &&
      !result.isStale
    ) {
      budgets.set(bot.id, result.data);
    }
  });
  const expected = results.filter((_, index) => bots[index]?.complete);
  return {
    data: budgets,
    isPending: enabled && expected.some((result) => result.isPending),
    isFetching: enabled && expected.some((result) => result.isFetching),
    error: expected.find((result) => result.error)?.error ?? null,
    complete:
      enabled &&
      expected.every(
        (result) =>
          result.data !== undefined &&
          !result.isPending &&
          !result.isFetching &&
          !result.isError &&
          !result.isStale,
      ),
  };
}

export function useFleetPrices(symbols: readonly string[], enabled: boolean) {
  const runtime = useViewerRuntime();
  const reportId = useId();
  const normalized = [...new Set(symbols.map((symbol) => symbol.toUpperCase()))].sort();
  const status = useQuery({
    queryKey: priceKeys.status,
    queryFn: priceApi.getStatus,
    enabled: enabled && normalized.length > 0,
    staleTime: 59_000,
    refetchInterval: 60_000,
    retry: false,
  });
  const quotes = useQuery({
    queryKey: priceKeys.quotes(normalized),
    queryFn: () => priceApi.getQuotes(normalized),
    enabled: enabled && normalized.length > 0,
    staleTime: 59_000,
    refetchInterval: 60_000,
    retry: false,
  });

  const trustworthy =
    !status.isError &&
    !quotes.isError &&
    requiredQuotesAreTrustworthy(normalized, status.data?.feed, quotes.data ?? []);
  const health: PriceHealth =
    !enabled || normalized.length === 0
      ? 'unused'
      : status.isPending || quotes.isPending
        ? 'loading'
        : trustworthy
          ? 'live'
          : 'unavailable';

  useEffect(
    () => () => runtime.reportPriceHealth(reportId, null),
    [reportId, runtime.reportPriceHealth],
  );
  useEffect(() => {
    runtime.reportPriceHealth(reportId, health === 'unused' ? null : health);
  }, [health, reportId, runtime.reportPriceHealth]);

  return {
    status: status.data ?? null,
    quotes: new Map((quotes.data ?? []).map((quote) => [quote.symbol, quote])),
    trustworthy,
    error: status.error ?? quotes.error ?? null,
    isPending: status.isPending || quotes.isPending,
  };
}

export function requiredQuotesAreTrustworthy(
  requiredSymbols: readonly string[],
  feed: PriceFeedState | undefined,
  quotes: readonly Quote[],
): boolean {
  if (feed !== 'live') return false;
  const required = [...new Set(requiredSymbols.map((symbol) => symbol.toUpperCase()))].sort();
  if (required.length === 0 || quotes.length !== required.length) return false;
  const received = new Set<string>();
  for (const quote of quotes) {
    const symbol = quote.symbol.toUpperCase();
    if (
      received.has(symbol) ||
      !required.includes(symbol) ||
      quote.feed !== 'live' ||
      quote.son === null ||
      !Number.isFinite(quote.son)
    ) {
      return false;
    }
    received.add(symbol);
  }
  return required.every((symbol) => received.has(symbol));
}
