import { describe, expect, it } from 'vitest';

import { hasBandLimits } from '../bistApi/types';
import {
  EMPTY_CLOSE_PRICE_DRAFT,
  EMPTY_OPEN_PRICE_DRAFT,
  closePriceDraftFrom,
  describeClosePrice,
  describeOpenPrice,
  openPriceDraftFrom,
  parseClosePrice,
  parseOpenPrice,
  readClosePrice,
  readClosePriceDraft,
  readOpenPrice,
  readOpenPriceDraft,
  sameClosePrice,
  sameOpenPrice,
  sameStoredRule,
} from './priceRules';

describe('reading a stored rule', () => {
  it('reads the JSON the server echoes back', () => {
    const raw = '{"upperLimit":9.8,"lowerLimit":-9.8,"whenPriceFeedDown":15}';
    expect(parseOpenPrice(raw)).toEqual({
      upperLimit: 9.8,
      lowerLimit: -9.8,
      whenPriceFeedDown: 15,
    });
    expect(parseClosePrice('{"stopLoss":{"limit":-2,"base":"actualPrice"}}')).toEqual({
      stopLoss: { limit: -2, base: 'actualPrice' },
    });
  });

  it('accepts an already-decoded object as well as text', () => {
    expect(parseOpenPrice({ upperLimit: 5 })).toEqual({ upperLimit: 5 });
  });

  it.each([null, undefined, '', '   ', 'null'])('reads %p as no rule at all', (raw) => {
    expect(readOpenPrice(raw as null)).toEqual({ kind: 'absent' });
  });

  it('separates an absent rule from one it cannot re-express', () => {
    expect(readOpenPrice('{not json').kind).toBe('unreadable');
    // A shape the acceptance rules refuse: 0 is not a limit.
    expect(readOpenPrice('{"upperLimit":0}').kind).toBe('unreadable');
    expect(readClosePrice('{"takeProfit":{"limit":5}}').kind).toBe('unreadable');
    // Display collapses both to nothing; a write path must ask `read*` instead.
    expect(parseOpenPrice('{not json')).toBeNull();
  });

  it('refuses a previousClose percentage outside the exchange daily cap', () => {
    expect(readOpenPrice('{"upperLimit":10.5}').kind).toBe('unreadable');
    expect(readClosePrice('{"takeProfit":{"limit":10.5,"base":"previousClose"}}').kind).toBe(
      'unreadable',
    );
    // Against the fill there is no such cap: a position carried across
    // sessions can legitimately sit further out.
    expect(readClosePrice('{"takeProfit":{"limit":40,"base":"actualPrice"}}').kind).toBe('rule');
  });

  it('refuses a band whose lower limit is not below its upper', () => {
    expect(readOpenPrice('{"upperLimit":2,"lowerLimit":5}').kind).toBe('unreadable');
    expect(readOpenPrice('{"upperLimit":5,"lowerLimit":2}').kind).toBe('rule');
  });

  it('refuses a stop loss at or above a take profit on the same base', () => {
    const same =
      '{"takeProfit":{"limit":2,"base":"actualPrice"},"stopLoss":{"limit":3,"base":"actualPrice"}}';
    expect(readClosePrice(same).kind).toBe('unreadable');
    const differentBases =
      '{"takeProfit":{"limit":2,"base":"actualPrice"},"stopLoss":{"limit":3,"base":"orderPrice"}}';
    expect(readClosePrice(differentBases).kind).toBe('rule');
  });

  it('compares stored rules as they arrived', () => {
    expect(sameStoredRule('{"upperLimit":5}', '{"upperLimit":5}')).toBe(true);
    expect(sameStoredRule(null, undefined)).toBe(true);
    expect(sameStoredRule('{"upperLimit":5}', '{"upperLimit":6}')).toBe(false);
    expect(sameStoredRule(null, '{"upperLimit":5}')).toBe(false);
  });

  it('compares parsed rules field by field', () => {
    expect(sameOpenPrice({ upperLimit: 5 }, { upperLimit: 5 })).toBe(true);
    expect(sameOpenPrice({ upperLimit: 5 }, { upperLimit: 5, lowerLimit: -1 })).toBe(false);
    expect(sameOpenPrice(null, null)).toBe(true);
    expect(sameOpenPrice(null, { upperLimit: 5 })).toBe(false);
    expect(
      sameClosePrice(
        { takeProfit: { limit: 5, base: 'actualPrice' } },
        { takeProfit: { limit: 5, base: 'actualPrice' } },
      ),
    ).toBe(true);
    expect(
      sameClosePrice(
        { takeProfit: { limit: 5, base: 'actualPrice' } },
        { takeProfit: { limit: 5, base: 'orderPrice' } },
      ),
    ).toBe(false);
  });
});

describe('reading a rule out loud', () => {
  it('states a two-sided band as a range', () => {
    expect(describeOpenPrice({ upperLimit: 9.8, lowerLimit: -9.8 })).toEqual([
      'buy between −9,80% and +9,80% of the previous close',
    ]);
  });

  it('states a one-sided band as the side it has', () => {
    expect(describeOpenPrice({ upperLimit: 5 })).toEqual([
      'buy at or below +5,00% of the previous close',
    ]);
    expect(describeOpenPrice({ lowerLimit: -2 })).toEqual([
      'buy at or above −2,00% of the previous close',
    ]);
  });

  it('says nothing about a rule that only restates the default', () => {
    // "send it unguarded" is what happens anyway; saying so is noise.
    expect(describeOpenPrice({ whenPriceFeedDown: 'buy' })).toEqual([]);
    expect(describeOpenPrice(null)).toEqual([]);
    expect(describeClosePrice(null)).toEqual([]);
  });

  it('states a fallback that is not the default', () => {
    expect(describeOpenPrice({ whenPriceFeedDown: 'cancel' })).toEqual([
      'no price at fire: drop it',
    ]);
    expect(describeOpenPrice({ whenPriceFeedDown: 1 })).toEqual([
      'no price at fire: wait up to 1 minute',
    ]);
    expect(describeOpenPrice({ whenPriceFeedDown: 15 })).toEqual([
      'no price at fire: wait up to 15 minutes',
    ]);
  });

  it('names each exit target against its own base', () => {
    expect(
      describeClosePrice({
        takeProfit: { limit: 5, base: 'actualPrice' },
        stopLoss: { limit: -2, base: 'previousClose' },
      }),
    ).toEqual([
      'take profit at +5,00% of the average fill',
      'stop loss at −2,00% of the previous close',
    ]);
  });

  it('knows whether a band would guard a price at all', () => {
    expect(hasBandLimits({ whenPriceFeedDown: 'cancel' })).toBe(false);
    expect(hasBandLimits({ upperLimit: 5 })).toBe(true);
    expect(hasBandLimits(null)).toBe(false);
  });
});

describe('the form draft', () => {
  it('seeds from a stored rule in a form the Turkish parser reads back', () => {
    expect(
      openPriceDraftFrom({ upperLimit: 9.8, lowerLimit: -9.8, whenPriceFeedDown: 15 }),
    ).toEqual({ upperLimit: '9,8', lowerLimit: '-9,8', feedDown: 'wait', waitMinutes: '15' });
    expect(openPriceDraftFrom(null)).toEqual(EMPTY_OPEN_PRICE_DRAFT);
    expect(closePriceDraftFrom({ stopLoss: { limit: -2, base: 'orderPrice' } })).toEqual({
      takeProfitLimit: '',
      takeProfitBase: 'actualPrice',
      stopLossLimit: '-2',
      stopLossBase: 'orderPrice',
    });
    expect(closePriceDraftFrom(null)).toEqual(EMPTY_CLOSE_PRICE_DRAFT);
  });

  it('round-trips a stored rule through the draft unchanged', () => {
    const rule = { upperLimit: 9.8, lowerLimit: -9.8, whenPriceFeedDown: 15 as const };
    const reading = readOpenPriceDraft(openPriceDraftFrom(rule));
    expect(reading).toEqual({ ok: true, rule });
  });

  it('reads a neutral draft as no rule', () => {
    expect(readOpenPriceDraft(EMPTY_OPEN_PRICE_DRAFT)).toEqual({ ok: true, rule: null });
    expect(readClosePriceDraft(EMPTY_CLOSE_PRICE_DRAFT)).toEqual({ ok: true, rule: null });
  });

  it('keeps a bare fallback, which is the one band an Opening auction allows', () => {
    const reading = readOpenPriceDraft({ ...EMPTY_OPEN_PRICE_DRAFT, feedDown: 'cancel' });
    expect(reading).toEqual({ ok: true, rule: { whenPriceFeedDown: 'cancel' } });
    expect(hasBandLimits(reading.ok ? reading.rule : null)).toBe(false);
  });

  it('reads Turkish decimals and refuses what is not a percentage', () => {
    expect(readOpenPriceDraft({ ...EMPTY_OPEN_PRICE_DRAFT, upperLimit: '9,8' })).toEqual({
      ok: true,
      rule: { upperLimit: 9.8 },
    });
    const bad = readOpenPriceDraft({ ...EMPTY_OPEN_PRICE_DRAFT, upperLimit: 'nine' });
    expect(bad).toEqual({
      ok: false,
      error: "The entry band's upper limit must be a percentage, like 9,8 or −2.",
    });
  });

  it('refuses a limit of zero, which is not a limit', () => {
    expect(readOpenPriceDraft({ ...EMPTY_OPEN_PRICE_DRAFT, lowerLimit: '0' })).toEqual({
      ok: false,
      error: "The entry band's lower limit cannot be 0 — that is not a limit.",
    });
  });

  it('bounds a band by the exchange daily cap and a target by its base', () => {
    expect(readOpenPriceDraft({ ...EMPTY_OPEN_PRICE_DRAFT, upperLimit: '11' })).toEqual({
      ok: false,
      error: "The entry band's upper limit must be between −10,00% and +10,00%.",
    });
    expect(
      readClosePriceDraft({
        ...EMPTY_CLOSE_PRICE_DRAFT,
        takeProfitLimit: '11',
        takeProfitBase: 'previousClose',
      }).ok,
    ).toBe(false);
    expect(
      readClosePriceDraft({
        ...EMPTY_CLOSE_PRICE_DRAFT,
        takeProfitLimit: '11',
        takeProfitBase: 'actualPrice',
      }),
    ).toEqual({ ok: true, rule: { takeProfit: { limit: 11, base: 'actualPrice' } } });
  });

  it('refuses a band whose sides cross', () => {
    expect(
      readOpenPriceDraft({ ...EMPTY_OPEN_PRICE_DRAFT, upperLimit: '2', lowerLimit: '5' }),
    ).toEqual({
      ok: false,
      error: "The entry band's lower limit must be below its upper limit.",
    });
  });

  it('refuses a wait that is not a whole number of minutes in range', () => {
    const wait = (waitMinutes: string) =>
      readOpenPriceDraft({ ...EMPTY_OPEN_PRICE_DRAFT, feedDown: 'wait', waitMinutes });
    const error = 'A wait for a price must be a whole number of minutes between 1 and 600.';
    expect(wait('')).toEqual({ ok: false, error });
    expect(wait('0')).toEqual({ ok: false, error });
    expect(wait('601')).toEqual({ ok: false, error });
    expect(wait('2,5')).toEqual({ ok: false, error });
    expect(wait('600')).toEqual({ ok: true, rule: { whenPriceFeedDown: 600 } });
  });

  it('refuses a stop loss at or above a take profit on the same base', () => {
    expect(
      readClosePriceDraft({
        takeProfitLimit: '2',
        takeProfitBase: 'actualPrice',
        stopLossLimit: '2',
        stopLossBase: 'actualPrice',
      }),
    ).toEqual({
      ok: false,
      error:
        'The stop loss must be below the take profit when both are measured against the same price.',
    });
    // Different bases are two different prices; the server does not compare them.
    expect(
      readClosePriceDraft({
        takeProfitLimit: '2',
        takeProfitBase: 'actualPrice',
        stopLossLimit: '3',
        stopLossBase: 'orderPrice',
      }).ok,
    ).toBe(true);
  });
});
