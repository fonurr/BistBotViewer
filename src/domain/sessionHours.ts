/**
 * BIST's session hours, in Istanbul minutes past midnight — the one place the viewer writes
 * them down. Every rule that needs one reads it from here, most of them through
 * `calendar.ts`, which turns these minutes into instants on a given day.
 *
 * Confirmed against MatriksOrder, whose `API.md` ("Which session an order belongs to") and
 * `src/orders/schedule.ts` state the same anchors:
 *
 * | anchor                     | full day | half day |
 * | -------------------------- | -------- | -------- |
 * | opening auction match      | 09:55    | 09:55    |
 * | continuous trading opens   | 10:00    | 10:00    |
 * | continuous trading closes  | 18:00    | 12:30    |
 *
 * A half day only moves the close, and everything read off the close moves with it.
 *
 * This module imports nothing on purpose: the nightly snapshot worker in `histApi/server` is a
 * plain Node module, and its scheduler hands it these values rather than letting it keep a copy.
 */

/** The opening auction match — the first moment anything trades on a session. */
export const OPENING_MATCH_MINUTE = 9 * 60 + 55;
/** Continuous trading opens. Before it there is nothing to tick. */
export const CONTINUOUS_OPEN_MINUTE = 10 * 60;
/** Continuous trading closes: 18:00 on a full day, 12:30 on a half day. */
export const CLOSE_MINUTE = 18 * 60;
export const HALF_DAY_CLOSE_MINUTE = 12 * 60 + 30;

/**
 * Minutes past the close, as MatriksOrder's table reads them (`C`+5, `C`+8, `C`+10): the
 * closing auction matches at +5; an order written between that match and +8 is worked from +8;
 * one written between +8 and +10 is worked at once; and a session keeps the work written for it
 * until +10, after which the next trading day takes it.
 */
export const CLOSING_MATCH_OFFSET_MINUTES = 5;
export const POST_MATCH_RESUME_OFFSET_MINUTES = 8;
export const SESSION_GRACE_MINUTES = 10;
