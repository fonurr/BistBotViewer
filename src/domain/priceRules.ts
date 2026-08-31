import {
  closePriceRuleSchema,
  openPriceRuleSchema,
  type ClosePriceRule,
  type OpenPriceRule,
  type PriceBase,
  type StoredPriceRule,
  type WhenPriceFeedDown,
} from '../bistApi/types';
import { formatPercentage, parseTurkishNumber, plural } from './format';

/**
 * A price rule says where a buy may fill and where the position it opens gets
 * out again — as signed percentages against a named base, never as lira. The
 * server acts on them on its own: a band keeps guarding a buy after it rests,
 * so a buy can disappear without anyone asking, and a reached exit cancels the
 * scheduled sells and sells the position at market.
 *
 * The server stores the JSON it was handed and echoes it back verbatim, so
 * this module is the one place that turns that text into something the Book
 * can show, prefill and send again.
 */

/** A stored rule is absent, readable, or text this viewer cannot re-express. */
export type StoredRuleRead<T> =
  { kind: 'absent' } | { kind: 'rule'; rule: T } | { kind: 'unreadable' };

function readStored<T>(
  raw: StoredPriceRule,
  schema: { safeParse: (value: unknown) => { success: boolean; data?: unknown } },
): StoredRuleRead<T> {
  if (raw === null || raw === undefined) return { kind: 'absent' };
  let candidate: unknown = raw;
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (trimmed === '' || trimmed === 'null') return { kind: 'absent' };
    try {
      candidate = JSON.parse(trimmed);
    } catch {
      return { kind: 'unreadable' };
    }
    if (candidate === null) return { kind: 'absent' };
  }
  const parsed = schema.safeParse(candidate);
  return parsed.success ? { kind: 'rule', rule: parsed.data as T } : { kind: 'unreadable' };
}

export function readOpenPrice(raw: StoredPriceRule): StoredRuleRead<OpenPriceRule> {
  return readStored<OpenPriceRule>(raw, openPriceRuleSchema);
}

export function readClosePrice(raw: StoredPriceRule): StoredRuleRead<ClosePriceRule> {
  return readStored<ClosePriceRule>(raw, closePriceRuleSchema);
}

/**
 * The rule, or null. Unreadable text collapses to null for display exactly as
 * it does upstream, where a rule that cannot be parsed guards nothing — but
 * every write path asks `read*` instead, because dropping a guard it cannot
 * read is the one thing a write may never do quietly.
 */
export function parseOpenPrice(raw: StoredPriceRule): OpenPriceRule | null {
  const read = readOpenPrice(raw);
  return read.kind === 'rule' ? read.rule : null;
}

export function parseClosePrice(raw: StoredPriceRule): ClosePriceRule | null {
  const read = readClosePrice(raw);
  return read.kind === 'rule' ? read.rule : null;
}

export function sameOpenPrice(left: OpenPriceRule | null, right: OpenPriceRule | null): boolean {
  if (left === null || right === null) return left === right;
  return (
    left.upperLimit === right.upperLimit &&
    left.lowerLimit === right.lowerLimit &&
    left.whenPriceFeedDown === right.whenPriceFeedDown
  );
}

export function sameClosePrice(left: ClosePriceRule | null, right: ClosePriceRule | null): boolean {
  if (left === null || right === null) return left === right;
  const sameTarget = (a: ClosePriceRule['takeProfit'], b: ClosePriceRule['takeProfit']) =>
    a === undefined || b === undefined ? a === b : a.limit === b.limit && a.base === b.base;
  return sameTarget(left.takeProfit, right.takeProfit) && sameTarget(left.stopLoss, right.stopLoss);
}

/** Compares two rules as they arrived, without deciding what they mean. */
export function sameStoredRule(left: StoredPriceRule, right: StoredPriceRule): boolean {
  const canonical = (value: StoredPriceRule) =>
    value === null || value === undefined
      ? ''
      : typeof value === 'string'
        ? value
        : JSON.stringify(value);
  return canonical(left) === canonical(right);
}

// --- reading a rule out loud -------------------------------------------------

const BASE_WORDS: Record<PriceBase, string> = {
  previousClose: 'the previous close',
  orderPrice: 'the order price',
  actualPrice: 'the average fill',
};

export function describeFeedDown(value: WhenPriceFeedDown): string {
  if (value === 'buy') return 'no price at fire: send it unguarded';
  if (value === 'cancel') return 'no price at fire: drop it';
  return `no price at fire: wait up to ${plural(value, 'minute')}`;
}

/**
 * The band, then what it does without a price. `buy` is the server's own
 * default, so a rule that only restates it changes nothing and says nothing.
 */
export function describeOpenPrice(rule: OpenPriceRule | null): string[] {
  if (rule === null) return [];
  const lines: string[] = [];
  const { upperLimit, lowerLimit } = rule;
  if (upperLimit !== undefined && lowerLimit !== undefined) {
    lines.push(
      `buy between ${formatPercentage(lowerLimit)} and ${formatPercentage(upperLimit)} of ${BASE_WORDS.previousClose}`,
    );
  } else if (upperLimit !== undefined) {
    lines.push(`buy at or below ${formatPercentage(upperLimit)} of ${BASE_WORDS.previousClose}`);
  } else if (lowerLimit !== undefined) {
    lines.push(`buy at or above ${formatPercentage(lowerLimit)} of ${BASE_WORDS.previousClose}`);
  }
  if (rule.whenPriceFeedDown !== undefined && rule.whenPriceFeedDown !== 'buy') {
    lines.push(describeFeedDown(rule.whenPriceFeedDown));
  }
  return lines;
}

export function describeClosePrice(rule: ClosePriceRule | null): string[] {
  if (rule === null) return [];
  const lines: string[] = [];
  if (rule.takeProfit) {
    lines.push(
      `take profit at ${formatPercentage(rule.takeProfit.limit)} of ${BASE_WORDS[rule.takeProfit.base]}`,
    );
  }
  if (rule.stopLoss) {
    lines.push(
      `stop loss at ${formatPercentage(rule.stopLoss.limit)} of ${BASE_WORDS[rule.stopLoss.base]}`,
    );
  }
  return lines;
}

// --- the form's own state ----------------------------------------------------

export interface OpenPriceDraft {
  upperLimit: string;
  lowerLimit: string;
  feedDown: 'buy' | 'cancel' | 'wait';
  waitMinutes: string;
}

export interface ClosePriceDraft {
  takeProfitLimit: string;
  takeProfitBase: PriceBase;
  stopLossLimit: string;
  stopLossBase: PriceBase;
}

/**
 * `cleared` is the user having asked for the rule to go. It is a state of its
 * own because on EditOrders an explicit null is the only way to disarm a rule,
 * and a blank form must never be mistaken for that request.
 */
export type RuleDraft<T> = { state: 'edit'; value: T } | { state: 'cleared' };

/** Measured against what the buy actually paid — the base a reader means. */
const DEFAULT_BASE: PriceBase = 'actualPrice';

export const EMPTY_OPEN_PRICE_DRAFT: OpenPriceDraft = {
  upperLimit: '',
  lowerLimit: '',
  feedDown: 'buy',
  waitMinutes: '',
};

export const EMPTY_CLOSE_PRICE_DRAFT: ClosePriceDraft = {
  takeProfitLimit: '',
  takeProfitBase: DEFAULT_BASE,
  stopLossLimit: '',
  stopLossBase: DEFAULT_BASE,
};

/** Percentages round-trip through `parseTurkishNumber`, so no grouping here. */
function editablePercent(value: number | undefined): string {
  return value === undefined ? '' : String(value).replace('.', ',');
}

export function openPriceDraftFrom(rule: OpenPriceRule | null): OpenPriceDraft {
  if (rule === null) return EMPTY_OPEN_PRICE_DRAFT;
  const feedDown = rule.whenPriceFeedDown;
  return {
    upperLimit: editablePercent(rule.upperLimit),
    lowerLimit: editablePercent(rule.lowerLimit),
    feedDown:
      feedDown === undefined || feedDown === 'buy'
        ? 'buy'
        : feedDown === 'cancel'
          ? 'cancel'
          : 'wait',
    waitMinutes: typeof feedDown === 'number' ? String(feedDown) : '',
  };
}

export function closePriceDraftFrom(rule: ClosePriceRule | null): ClosePriceDraft {
  if (rule === null) return EMPTY_CLOSE_PRICE_DRAFT;
  return {
    takeProfitLimit: editablePercent(rule.takeProfit?.limit),
    takeProfitBase: rule.takeProfit?.base ?? DEFAULT_BASE,
    stopLossLimit: editablePercent(rule.stopLoss?.limit),
    stopLossBase: rule.stopLoss?.base ?? DEFAULT_BASE,
  };
}

export function isNeutralOpenPriceDraft(draft: OpenPriceDraft): boolean {
  return (
    draft.upperLimit.trim() === '' && draft.lowerLimit.trim() === '' && draft.feedDown === 'buy'
  );
}

export function isNeutralClosePriceDraft(draft: ClosePriceDraft): boolean {
  return draft.takeProfitLimit.trim() === '' && draft.stopLossLimit.trim() === '';
}

export type DraftReading<T> = { ok: true; rule: T | null } | { ok: false; error: string };

const BAND_BOUND = 10;
const SANITY_BOUND = 100;

function percentField(raw: string, bound: number, what: string): number | null | string {
  if (raw.trim() === '') return null;
  const value = parseTurkishNumber(raw);
  if (value === null) return `${what} must be a percentage, like 9,8 or −2.`;
  if (value === 0) return `${what} cannot be 0 — that is not a limit.`;
  if (Math.abs(value) > bound) {
    return `${what} must be between ${formatPercentage(-bound)} and ${formatPercentage(bound)}.`;
  }
  return value;
}

/**
 * A neutral draft reads as no rule at all. The caller decides what that means:
 * on a fresh order it is simply an unguarded one, and on an edit of a guarded
 * row it is a mistake, because disarming has to be asked for.
 */
export function readOpenPriceDraft(draft: OpenPriceDraft): DraftReading<OpenPriceRule> {
  if (isNeutralOpenPriceDraft(draft)) return { ok: true, rule: null };
  const upper = percentField(draft.upperLimit, BAND_BOUND, "The entry band's upper limit");
  if (typeof upper === 'string') return { ok: false, error: upper };
  const lower = percentField(draft.lowerLimit, BAND_BOUND, "The entry band's lower limit");
  if (typeof lower === 'string') return { ok: false, error: lower };
  if (upper !== null && lower !== null && lower >= upper) {
    return { ok: false, error: "The entry band's lower limit must be below its upper limit." };
  }

  let whenPriceFeedDown: WhenPriceFeedDown | undefined;
  if (draft.feedDown === 'cancel') whenPriceFeedDown = 'cancel';
  if (draft.feedDown === 'wait') {
    const minutes = parseTurkishNumber(draft.waitMinutes);
    if (minutes === null || !Number.isInteger(minutes) || minutes < 1 || minutes > 600) {
      return {
        ok: false,
        error: 'A wait for a price must be a whole number of minutes between 1 and 600.',
      };
    }
    whenPriceFeedDown = minutes;
  }

  return {
    ok: true,
    rule: {
      ...(upper === null ? {} : { upperLimit: upper }),
      ...(lower === null ? {} : { lowerLimit: lower }),
      ...(whenPriceFeedDown === undefined ? {} : { whenPriceFeedDown }),
    },
  };
}

export function readClosePriceDraft(draft: ClosePriceDraft): DraftReading<ClosePriceRule> {
  if (isNeutralClosePriceDraft(draft)) return { ok: true, rule: null };
  const boundFor = (base: PriceBase) => (base === 'previousClose' ? BAND_BOUND : SANITY_BOUND);
  const takeProfit = percentField(
    draft.takeProfitLimit,
    boundFor(draft.takeProfitBase),
    `A take profit measured against ${BASE_WORDS[draft.takeProfitBase]}`,
  );
  if (typeof takeProfit === 'string') return { ok: false, error: takeProfit };
  const stopLoss = percentField(
    draft.stopLossLimit,
    boundFor(draft.stopLossBase),
    `A stop loss measured against ${BASE_WORDS[draft.stopLossBase]}`,
  );
  if (typeof stopLoss === 'string') return { ok: false, error: stopLoss };
  if (
    takeProfit !== null &&
    stopLoss !== null &&
    draft.takeProfitBase === draft.stopLossBase &&
    stopLoss >= takeProfit
  ) {
    return {
      ok: false,
      error:
        'The stop loss must be below the take profit when both are measured against the same price.',
    };
  }
  return {
    ok: true,
    rule: {
      ...(takeProfit === null
        ? {}
        : { takeProfit: { limit: takeProfit, base: draft.takeProfitBase } }),
      ...(stopLoss === null ? {} : { stopLoss: { limit: stopLoss, base: draft.stopLossBase } }),
    },
  };
}
