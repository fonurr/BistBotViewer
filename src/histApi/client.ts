import { z } from 'zod';

import { intentPriceKey } from '../domain/intentPrice';
import { intentBarSchema, snapshotStatusSchema, type IntentBar, type IntentBarKey } from './types';

const bridgeBase = '/bridge/hist';

/**
 * The most keys one bounded read may carry. It is a bound on a single request,
 * not on what a page may want: the Book asks for every drawn row and Performance
 * for both legs of every round trip, and a year of batches passes this easily —
 * 1.129 keys on the current history alone. So `getIntentBars` splits rather than
 * letting the bridge refuse, which would empty the column instead of one chunk.
 */
export const MAX_INTENT_KEYS = 1_000;

export class HistApiError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'HistApiError';
  }
}

async function parseResponse<T>(response: Response, schema: z.ZodType<T>): Promise<T> {
  const raw = await response.text();
  let value: unknown;
  try {
    value = raw ? (JSON.parse(raw) as unknown) : {};
  } catch (error) {
    throw new HistApiError('The history bridge returned unreadable JSON.', { cause: error });
  }
  if (!response.ok) {
    const message =
      typeof value === 'object' && value !== null && 'error' in value
        ? String(value.error)
        : `The history bridge returned HTTP ${response.status}.`;
    throw new HistApiError(message);
  }
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new HistApiError('The history bridge returned a shape the viewer cannot use.', {
      cause: parsed.error,
    });
  }
  return parsed.data;
}

export const histApi = {
  getSnapshotStatus: async () => {
    const response = await fetch(`${bridgeBase}/status`, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(8_000),
    });
    return parseResponse(response, snapshotStatusSchema);
  },
  /**
   * A bounded point read. Keys are de-duplicated here rather than at the call
   * site: several rows of one chain routinely name the same minute, and the
   * cache answers each one once.
   */
  getIntentBars: async (keys: readonly IntentBarKey[]) => {
    const unique = [
      ...new Map(
        keys.map((key) => [
          intentPriceKey(key.symbol, key.ts),
          { symbol: key.symbol.toUpperCase(), ts: key.ts },
        ]),
      ).values(),
    ];
    const bars: IntentBar[] = [];
    // Sequential, not parallel: the worker bounds its own pending reads, and a
    // historical minute is worth waiting a beat for.
    for (let from = 0; from < unique.length; from += MAX_INTENT_KEYS) {
      const response = await fetch(`${bridgeBase}/bars/intent`, {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify({ keys: unique.slice(from, from + MAX_INTENT_KEYS) }),
        signal: AbortSignal.timeout(15_000),
      });
      bars.push(...(await parseResponse(response, z.array(intentBarSchema))));
    }
    return bars;
  },
};
