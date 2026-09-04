import { describe, expect, it } from 'vitest';

import { buildBookChains } from '../../domain/chains';
import {
  makeActiveOrder,
  makeClosedTrade,
  makeCanceledOrder,
  makePosition,
} from '../../test/fixtures';
import { bookRowPresentation } from './rowPresentation';

function canceledRow(overrides: Parameters<typeof makeCanceledOrder>[0]) {
  const [chain] = buildBookChains({
    activeOrders: [],
    canceledOrders: [makeCanceledOrder(overrides)],
    positions: [makePosition({ chainId: 'chain-thyao' })],
    closedTrades: [],
  });
  const row = chain.rows.find((r) => r.source === 'canceled')!;
  return bookRowPresentation(row, chain);
}

describe('bookRowPresentation canceled detail', () => {
  it('shows the server reason before the wire explanation when both are stored', () => {
    expect(
      canceledRow({ reason: 'bot ordered to buy already held stock', explanation: 'İptal edildi' })
        .detail,
    ).toBe('bot ordered to buy already held stock · İptal edildi');
  });

  it('shows only what is stored', () => {
    expect(canceledRow({ reason: 'unconfirmed', explanation: null }).detail).toBe('unconfirmed');
    expect(canceledRow({ reason: null, explanation: 'İptal edildi' }).detail).toBe('İptal edildi');
    expect(canceledRow({ reason: null, explanation: null }).detail).toBeUndefined();
  });

  it('keeps the retry count last', () => {
    expect(
      canceledRow({ reason: 'unconfirmed', explanation: 'İptal edildi', retryCount: 2 }).detail,
    ).toBe('unconfirmed · İptal edildi · attempt 2 of 3');
  });
});

function activeRow(overrides: Parameters<typeof makeActiveOrder>[0]) {
  const [chain] = buildBookChains({
    activeOrders: [makeActiveOrder({ chainId: 'chain-live', ...overrides })],
    canceledOrders: [],
    positions: [],
    closedTrades: [],
  });
  const row = chain!.rows.find((candidate) => candidate.source !== 'position')!;
  return bookRowPresentation(row, chain!);
}

describe('bookRowPresentation reason on the rows that are not canceled', () => {
  it('leads a live order’s qualifier line with why the order exists', () => {
    expect(activeRow({ reason: 'ScheduledExit', matriksOrderId: null }).detail).toBe(
      'ScheduledExit · no exchange id — not editable until it confirms',
    );
  });

  it('says nothing where the server recorded no reason', () => {
    expect(
      activeRow({ reason: null, status: 'Scheduled', scheduledTime: null }).detail,
    ).toBeUndefined();
  });

  it('names why a cancel is in flight beside who asked for it', () => {
    expect(
      activeRow({ cancelSource: 'server', cancelReason: 'TakeProfit', reason: 'BotRequest' })
        .detail,
    ).toBe('BotRequest · asked by the server · TakeProfit');
  });

  it('carries why a position was closed on the sell, never on the opening leg', () => {
    const [chain] = buildBookChains({
      activeOrders: [],
      canceledOrders: [],
      positions: [],
      closedTrades: [makeClosedTrade({ closeReason: 'StopLoss' })],
    });
    const legs = chain!.tradeRows.map((row) => bookRowPresentation(row, chain!));

    expect(legs.find((leg) => leg.label === 'Filled')!.detail).toBe('StopLoss');
    expect(legs.find((leg) => leg.label === 'Closed')!.detail).not.toContain('StopLoss');
  });
});
