import { describe, expect, it } from 'vitest';

import { holidayCalendar } from '../domain/calendar';
import type { LatestBar, ProducerStatus, Quote } from '../priceApi/types';
import { pricesAreComplete, pricesFreshness, resolvePrices } from './priceFeed';

const quote = (symbol: string, son: number | null = 10, feed: Quote['feed'] = 'live'): Quote => ({
  symbol,
  son,
  feed,
  ghacim_try: null,
  quote_age_ms: 0,
  price_change_age_ms: 0,
  trade_age_ms: 0,
  // 01.09.2026 12:00 Istanbul, inside a normal session.
  server_ts: Date.parse('2026-09-01T12:00:00+03:00') / 1_000,
});

const bar = (
  symbol: string,
  close: number,
  sessionDate: string,
  barType: LatestBar['barType'] = 'CLOSING_AUCTION',
): LatestBar => ({
  symbol,
  sessionDate,
  close,
  barType,
  barTs: Date.parse(`${sessionDate}T18:05:00+03:00`) / 1_000,
});

const quotes = (...rows: Quote[]) => new Map(rows.map((row) => [row.symbol, row]));
const bars = (...rows: LatestBar[]) => new Map(rows.map((row) => [row.symbol, row]));

// The two holidays bracket every date the tests use, so `countTradingDays`-style coverage guards
// never fall back to "unknown" on them.
const calendar = holidayCalendar([
  { date: '2026-01-01', type: 'full' },
  { date: '2026-09-02', type: 'half' },
  { date: '2026-12-31', type: 'full' },
]);

describe('resolvePrices', () => {
  it('prefers a live quote and dates it from the quote', () => {
    const prices = resolvePrices({
      required: ['AKBNK'],
      quotes: quotes(quote('AKBNK', 12)),
      bars: bars(bar('AKBNK', 9, '2026-08-31')),
    });
    expect(prices.get('AKBNK')).toMatchObject({ price: 12, source: 'live' });
    expect(prices.get('AKBNK')?.asOf).toBe(Date.parse('2026-09-01T12:00:00+03:00'));
  });

  it('falls back to the newest stored bar when the quote cannot be trusted', () => {
    const stored = bar('AKBNK', 9, '2026-08-31');
    for (const unusable of [quote('AKBNK', 12, 'stalled'), quote('AKBNK', null)]) {
      const prices = resolvePrices({
        required: ['AKBNK'],
        quotes: quotes(unusable),
        bars: bars(stored),
      });
      expect(prices.get('AKBNK')).toMatchObject({
        price: 9,
        source: 'bar',
        barType: 'CLOSING_AUCTION',
        sessionDate: '2026-08-31',
      });
    }
  });

  it('keys by the upper-cased symbol whatever case was asked for', () => {
    const prices = resolvePrices({
      required: ['akbnk'],
      quotes: quotes(quote('AKBNK', 12)),
      bars: new Map(),
    });
    expect(prices.get('AKBNK')?.price).toBe(12);
  });

  it('leaves a symbol out entirely when neither source can price it', () => {
    const prices = resolvePrices({ required: ['AKBNK'], quotes: new Map(), bars: new Map() });
    expect(prices.has('AKBNK')).toBe(false);
  });
});

describe('pricesAreComplete', () => {
  it('is all or nothing across the required symbols', () => {
    const prices = resolvePrices({
      required: ['AKBNK', 'THYAO'],
      quotes: quotes(quote('AKBNK')),
      bars: new Map(),
    });
    expect(pricesAreComplete(['AKBNK', 'THYAO'], prices)).toBe(false);
    expect(pricesAreComplete(['AKBNK'], prices)).toBe(true);
    expect(pricesAreComplete([], prices)).toBe(false);
  });
});

describe('pricesFreshness', () => {
  const status = (feedAgeMs: number | null): ProducerStatus => ({
    feed: 'stalled',
    feed_age_ms: feedAgeMs,
    producer_uptime_s: 100,
    reconnects: 0,
    tracked_symbols: 1,
    server_ts: 1,
  });
  const base = {
    holidays: calendar,
    required: ['AKBNK'],
    streamState: 'live' as const,
    status: null,
    connectedSince: null,
  };

  it('says nothing while every price on screen is live', () => {
    const now = Date.parse('2026-09-01T12:00:00+03:00');
    const prices = resolvePrices({
      required: ['AKBNK'],
      quotes: quotes(quote('AKBNK')),
      bars: new Map(),
    });
    expect(pricesFreshness({ ...base, now, prices })).toEqual({ copy: null, className: null });
  });

  it('gives the global feed age in amber while the session is running', () => {
    const now = Date.parse('2026-09-01T12:00:00+03:00');
    const prices = resolvePrices({
      required: ['AKBNK'],
      quotes: new Map(),
      bars: bars(bar('AKBNK', 9, '2026-09-01', 'NORMAL')),
    });
    expect(
      pricesFreshness({
        ...base,
        now,
        prices,
        status: { value: status(240_000), receivedAt: now },
      }),
    ).toEqual({ copy: 'prices 4 minutes old', className: 'status-warn' });
  });

  it('turns red when the stream itself is gone', () => {
    const now = Date.parse('2026-09-01T12:00:00+03:00');
    const prices = resolvePrices({
      required: ['AKBNK'],
      quotes: new Map(),
      bars: bars(bar('AKBNK', 9, '2026-09-01', 'NORMAL')),
    });
    expect(
      pricesFreshness({
        ...base,
        now,
        prices,
        streamState: 'down',
        connectedSince: now - 3_600_000,
      }),
    ).toEqual({ copy: 'prices 1 hour old', className: 'status-dead' });
  });

  it('says nothing after the close when every symbol has that session s closing auction', () => {
    const now = Date.parse('2026-09-01T20:00:00+03:00');
    const prices = resolvePrices({
      required: ['AKBNK'],
      quotes: new Map(),
      bars: bars(bar('AKBNK', 9, '2026-09-01')),
    });
    expect(pricesFreshness({ ...base, now, prices })).toEqual({ copy: null, className: null });
  });

  it('names the date the stored bars reach when they fall short of that close', () => {
    const now = Date.parse('2026-09-01T20:00:00+03:00');
    const prices = resolvePrices({
      required: ['AKBNK'],
      quotes: new Map(),
      bars: bars(bar('AKBNK', 9, '2026-08-28')),
    });
    expect(pricesFreshness({ ...base, now, prices })).toEqual({
      copy: 'prices 28.08.26',
      className: 'status-warn',
    });
  });

  it('calls the prices unavailable when a required symbol has no price at all', () => {
    const now = Date.parse('2026-09-01T12:00:00+03:00');
    expect(
      pricesFreshness({ ...base, now, required: ['AKBNK', 'THYAO'], prices: new Map() }),
    ).toEqual({ copy: 'prices unavailable', className: 'status-dead' });
  });
});
