import { describe, expect, it } from 'vitest';

import {
  bookRowCreatedSlip,
  bookRowSentSlip,
  finalIsSlow,
  orderIsSlow,
  sentIsLate,
} from './bookRowFlags';

const at = Date.parse('2026-08-25T07:30:00.000Z'); // a Tuesday, 10:30 Istanbul
const noHolidays = new Map();

describe('the Book row flags', () => {
  it('reads the @created slip off a filled order that named its price, and never a market one', () => {
    expect(
      bookRowCreatedSlip({ orderPrice: 100, averagePrice: 101, orderType: 'limit' }),
    ).toBeCloseTo(1);
    // A Positions/ClosedTrades row stores no type; its stored price is the order.
    expect(bookRowCreatedSlip({ orderPrice: 100, averagePrice: 99, orderType: null })).toBeCloseTo(
      -1,
    );
    expect(bookRowCreatedSlip({ orderPrice: 100, averagePrice: 101, orderType: 'market' })).toBe(
      null,
    );
    expect(bookRowCreatedSlip({ orderPrice: 100, averagePrice: null, orderType: 'limit' })).toBe(
      null,
    );
  });

  it('reads the @sent slip only for an order sent inside continuous trading', () => {
    const filled = { marketPrice: 50, averagePrice: 51 };
    expect(bookRowSentSlip({ ...filled, sentTime: at }, noHolidays)).toBeCloseTo(2);
    // 09:59 Istanbul: before the continuous open, so matched against something else.
    expect(bookRowSentSlip({ ...filled, sentTime: at - 31 * 60_000 }, noHolidays)).toBe(null);
    expect(bookRowSentSlip({ ...filled, sentTime: null }, noHolidays)).toBe(null);
    expect(bookRowSentSlip({ ...filled, averagePrice: null, sentTime: at }, noHolidays)).toBe(null);
    expect(bookRowSentSlip({ ...filled, marketPrice: null, sentTime: at }, noHolidays)).toBe(null);
  });

  it('draws sent late only past every plan stamp by more than ten seconds', () => {
    expect(sentIsLate({ sentTime: at + 10_001, scheduledTime: null, createdTime: at })).toBe(true);
    expect(sentIsLate({ sentTime: at + 10_000, scheduledTime: null, createdTime: at })).toBe(false);
    // A schedule written after creation is the stamp the send answers to.
    expect(sentIsLate({ sentTime: at + 60_000, scheduledTime: at + 55_000, createdTime: at })).toBe(
      false,
    );
    expect(sentIsLate({ sentTime: null, scheduledTime: null, createdTime: at })).toBe(false);
    expect(sentIsLate({ sentTime: at, scheduledTime: null, createdTime: null })).toBe(false);
  });

  it('draws order slow when the exchange registered it more than ten seconds after the send', () => {
    expect(orderIsSlow({ orderTime: at + 10_001, sentTime: at })).toBe(true);
    expect(orderIsSlow({ orderTime: at + 10_000, sentTime: at })).toBe(false);
    // Registering ahead of the send stamp is clock skew, not a slow exchange.
    expect(orderIsSlow({ orderTime: at - 60_000, sentTime: at })).toBe(false);
    expect(orderIsSlow({ orderTime: at + 60_000, sentTime: null })).toBe(false);
    expect(orderIsSlow({ orderTime: null, sentTime: at })).toBe(false);
  });

  it('draws final slow past both intent and send once registered, past intent alone otherwise', () => {
    const registered = { intentTime: at, sentTime: at + 1_000, orderTime: at + 2_000 };
    expect(finalIsSlow({ ...registered, finalSeenTime: at + 5 * 60_000 })).toBe(true);
    // The send waited, then the fill followed it promptly.
    expect(
      finalIsSlow({ ...registered, sentTime: at + 130_000, finalSeenTime: at + 200_000 }),
    ).toBe(false);
    expect(finalIsSlow({ ...registered, sentTime: null, finalSeenTime: at + 5 * 60_000 })).toBe(
      false,
    );

    const neverRegistered = { intentTime: at, sentTime: null, orderTime: null };
    expect(finalIsSlow({ ...neverRegistered, finalSeenTime: at + 15_000 })).toBe(true);
    expect(finalIsSlow({ ...neverRegistered, finalSeenTime: at + 4_000 })).toBe(false);
    expect(finalIsSlow({ ...neverRegistered, finalSeenTime: null })).toBe(false);
    expect(finalIsSlow({ ...neverRegistered, intentTime: null, finalSeenTime: at })).toBe(false);
  });
});
