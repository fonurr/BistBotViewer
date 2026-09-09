import { z } from 'zod';

/**
 * One historical minute or auction print, already normalized onto the BIST daily
 * bulletin's raw scale by the nightly snapshot. The browser never sees a scale
 * factor: the correction is applied where the DuckDB source is read, once a
 * night, so a request here is a plain `(symbol, ts)` point lookup.
 */
export const intentBarSchema = z.object({
  symbol: z.string(),
  sessionDate: z.string(),
  /** Epoch milliseconds of the bar's own Istanbul wall-clock minute. */
  ts: z.number().int(),
  open: z.number(),
  close: z.number(),
  /** A locally reconstructed auction print (09:55 / 18:05), whose OHLC are all equal. */
  isAuction: z.boolean(),
});

export type IntentBar = z.infer<typeof intentBarSchema>;

/**
 * A bar is asked for by symbol and minute. `ts` must already be the exact minute
 * wanted — the caller resolves which minute answers an intent instant, because
 * that rule belongs to `domain/intentPrice`, not to a database.
 */
export interface IntentBarKey {
  symbol: string;
  ts: number;
}

/**
 * What the cache knows about itself. `snapshotFor` names the snapshot day the
 * rows were pulled for (the 23:00 boundary they belong to); `stale` is that day
 * failing to be the current one, which is the only thing the UI needs to decide
 * whether to say the intent prices are out of date.
 */
export const snapshotStatusSchema = z.object({
  available: z.boolean(),
  snapshotFor: z.string().nullable(),
  builtAt: z.number().int().nullable(),
  barRows: z.number().int().nullable(),
  stale: z.boolean(),
});

export type SnapshotStatus = z.infer<typeof snapshotStatusSchema>;
