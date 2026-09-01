import { z } from 'zod';

import {
  auctionBarSchema,
  latestBarSchema,
  producerStatusSchema,
  quoteSchema,
  type AuctionBarKey,
} from './types';

const bridgeBase = '/bridge/price';

/** The producer accepts at most this many symbols on one stream and rejects the whole change over it. */
export const MAX_STREAM_SYMBOLS = 200;

export function normalizeSymbols(symbols: readonly string[]): string[] {
  return [...new Set(symbols.map((symbol) => symbol.trim().toUpperCase()).filter(Boolean))].sort();
}

export class PriceApiError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'PriceApiError';
  }
}

async function parseResponse<T>(response: Response, schema: z.ZodType<T>): Promise<T> {
  const raw = await response.text();
  let value: unknown;
  try {
    value = raw ? (JSON.parse(raw) as unknown) : {};
  } catch (error) {
    throw new PriceApiError('The price service returned unreadable JSON.', { cause: error });
  }
  if (!response.ok) {
    const message =
      typeof value === 'object' && value !== null && 'error' in value
        ? String(value.error)
        : `The price service returned HTTP ${response.status}.`;
    throw new PriceApiError(message);
  }
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new PriceApiError('The price service returned a shape the viewer cannot use.', {
      cause: parsed.error,
    });
  }
  return parsed.data;
}

async function get<T>(path: string, schema: z.ZodType<T>): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${bridgeBase}${path}`, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(3_000),
    });
  } catch (error) {
    throw new PriceApiError('The price feed is unavailable.', { cause: error });
  }
  return parseResponse(response, schema);
}

/**
 * The stream's address. An empty set is never sent: upstream reads a missing `symbols` as no
 * symbols on `/stream` and as every symbol on `/quotes`, so the caller decides not to connect.
 */
export function priceStreamUrl(symbols: readonly string[]): string | null {
  const unique = normalizeSymbols(symbols);
  if (unique.length === 0 || unique.length > MAX_STREAM_SYMBOLS) return null;
  return `${bridgeBase}/stream?symbols=${encodeURIComponent(unique.join(','))}`;
}

export const priceApi = {
  getStatus: () => get('/status', producerStatusSchema),
  getQuotes: async (symbols: readonly string[]) => {
    const unique = normalizeSymbols(symbols);
    if (unique.length === 0) return [];
    return get(`/quotes?symbols=${encodeURIComponent(unique.join(','))}`, z.array(quoteSchema));
  },
  getLatestBars: async (symbols: readonly string[]) => {
    const unique = normalizeSymbols(symbols);
    if (unique.length === 0) return [];
    const response = await fetch(`${bridgeBase}/bars/latest`, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ symbols: unique }),
      signal: AbortSignal.timeout(15_000),
    });
    return parseResponse(response, z.array(latestBarSchema));
  },
  getClosingAuctionBars: async (keys: readonly AuctionBarKey[]) => {
    const unique = [
      ...new Map(
        keys.map((key) => [
          `${key.symbol.toUpperCase()}|${key.sessionDate}`,
          {
            symbol: key.symbol.toUpperCase(),
            sessionDate: key.sessionDate,
          },
        ]),
      ).values(),
    ];
    if (unique.length === 0) return [];
    const response = await fetch(`${bridgeBase}/bars/closing`, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ keys: unique }),
      signal: AbortSignal.timeout(15_000),
    });
    return parseResponse(response, z.array(auctionBarSchema));
  },
};
