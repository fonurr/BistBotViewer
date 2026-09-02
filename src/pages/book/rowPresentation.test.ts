import { describe, expect, it } from 'vitest';

import { buildBookChains } from '../../domain/chains';
import { makeCanceledOrder, makePosition } from '../../test/fixtures';
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
