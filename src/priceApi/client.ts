import { z } from 'zod';

import { auctionBarSchema, producerStatusSchema, quoteSchema, type AuctionBarKey } from './types';

const bridgeBase = '/bridge/price';

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

export const priceApi = {
  getStatus: () => get('/status', producerStatusSchema),
  getQuotes: async (symbols: readonly string[]) => {
    const unique = [
      ...new Set(symbols.map((symbol) => symbol.trim().toUpperCase()).filter(Boolean)),
    ];
    if (unique.length === 0) return [];
    return get(`/quotes?symbols=${encodeURIComponent(unique.join(','))}`, z.array(quoteSchema));
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
