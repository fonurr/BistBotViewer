import { z } from 'zod';

export const feedStateSchema = z.enum(['starting', 'live', 'stalled', 'reconnecting', 'stopped']);

export type PriceFeedState = z.infer<typeof feedStateSchema>;

export const quoteSchema = z
  .object({
    symbol: z.string(),
    son: z.number().nullable(),
    ghacim_try: z.number().nullable(),
    quote_age_ms: z.number().int().nullable(),
    price_change_age_ms: z.number().int().nullable(),
    trade_age_ms: z.number().int().nullable(),
    feed: feedStateSchema,
    server_ts: z.number(),
  })
  .passthrough();

export type Quote = z.infer<typeof quoteSchema>;

export const producerStatusSchema = z
  .object({
    feed: feedStateSchema,
    feed_age_ms: z.number().int().nullable(),
    producer_uptime_s: z.number(),
    reconnects: z.number().int(),
    tracked_symbols: z.number().int(),
    server_ts: z.number(),
  })
  .passthrough();

export type ProducerStatus = z.infer<typeof producerStatusSchema>;

/**
 * The stream's own event. `symbols` is always the full set the stream carries; `accepted` and
 * `rejected` describe only the last change, and a symbol outside the producer's catalogue comes
 * back rejected rather than as an error.
 */
export const streamSubscribedSchema = z
  .object({
    stream_id: z.string(),
    symbols: z.array(z.string()),
    accepted: z.array(z.string()).optional(),
    rejected: z.array(z.string()).optional(),
    server_ts: z.number().optional(),
  })
  .passthrough();

export type StreamSubscribed = z.infer<typeof streamSubscribedSchema>;

export const streamStoppedSchema = z.object({ reason: z.string().optional() }).passthrough();

export const auctionBarSchema = z.object({
  symbol: z.string(),
  sessionDate: z.string(),
  close: z.number(),
  volume: z.number(),
  barTs: z.number().int(),
});

export type AuctionBar = z.infer<typeof auctionBarSchema>;
export type AuctionBarKey = { symbol: string; sessionDate: string };

export const barTypeSchema = z.enum(['OPENING_AUCTION', 'NORMAL', 'CLOSING_AUCTION']);

export type BarType = z.infer<typeof barTypeSchema>;

/** The newest stored bar for a symbol, whatever its type — the price when the feed cannot answer. */
export const latestBarSchema = z.object({
  symbol: z.string(),
  sessionDate: z.string(),
  close: z.number(),
  barTs: z.number().int(),
  barType: barTypeSchema,
});

export type LatestBar = z.infer<typeof latestBarSchema>;

/**
 * A price the viewer is prepared to draw, and where it came from. A live quote is preferred; the
 * newest stored bar stands in when the feed cannot answer, and the header states which is on
 * screen. Nothing resolves to a price the viewer cannot date.
 */
export interface ResolvedPrice {
  /** Upper-cased at construction, so every lookup agrees on the key. */
  symbol: string;
  price: number;
  source: 'live' | 'bar';
  /** Milliseconds since the epoch: the quote's `server_ts`, or the bar's `bar_ts`. */
  asOf: number;
  barType?: BarType;
  sessionDate?: string;
}
