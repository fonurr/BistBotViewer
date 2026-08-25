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

export const auctionBarSchema = z.object({
  symbol: z.string(),
  sessionDate: z.string(),
  close: z.number(),
  volume: z.number(),
  barTs: z.number().int(),
});

export type AuctionBar = z.infer<typeof auctionBarSchema>;
export type AuctionBarKey = { symbol: string; sessionDate: string };
