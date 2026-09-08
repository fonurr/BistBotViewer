import { describe, expect, it } from 'vitest';

import { buildBookChains } from '../../domain/chains';
import {
  makeActiveOrder,
  makeCanceledOrder,
  makeClosedTrade,
  makePosition,
} from '../../test/fixtures';
import { bookRowPresentation, type BookRowPresentation } from './rowPresentation';

/** The qualifier line as one sentence, for the assertions that are about words. */
function text(presentation: BookRowPresentation): string | undefined {
  return presentation.detail?.map((part) => part.text).join(' · ');
}

/** The same line as `tone:text` pairs, for the assertions that are about ink. */
function inked(presentation: BookRowPresentation): string[] {
  return (presentation.detail ?? []).map((part) => `${part.tone}:${part.text}`);
}

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
      text(
        canceledRow({
          reason: 'bot ordered to buy already held stock',
          explanation: 'İptal edildi',
        }),
      ),
    ).toBe('bot ordered to buy already held stock · İptal edildi');
  });

  it('shows only what is stored', () => {
    expect(text(canceledRow({ reason: 'unconfirmed', explanation: null }))).toBe('unconfirmed');
    expect(text(canceledRow({ reason: null, explanation: 'İptal edildi' }))).toBe('İptal edildi');
    expect(canceledRow({ reason: null, explanation: null }).detail).toBeUndefined();
  });

  it('leads the line with the origin it came in on, before the reason', () => {
    expect(
      text(
        canceledRow({
          reason: 'unconfirmed',
          explanation: 'İptal edildi',
          origin: 'Retry',
          originData: { count: 2 },
        }),
      ),
    ).toBe('Retry · count: 2,00 · unconfirmed · İptal edildi');
  });

  it('says the origin muted, then the server verdict in body ink, then the quoted wire text', () => {
    expect(
      inked(
        canceledRow({
          reason: 'Expired',
          explanation: 'Süresi doldu',
          origin: 'Retry',
          originData: { count: 1 },
        }),
      ),
    ).toEqual(['muted:Retry · count: 1,00', 'reason:Expired', 'faint:Süresi doldu']);
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

describe('bookRowPresentation origin on the rows that are not canceled', () => {
  it('leads a live order’s qualifier line with the origin it came in on, muted', () => {
    expect(text(activeRow({ origin: 'TakeProfit', matriksOrderId: null }))).toBe(
      'TakeProfit · no exchange id — not editable until it confirms',
    );
    expect(inked(activeRow({ origin: 'TakeProfit', matriksOrderId: null }))[0]).toBe(
      'muted:TakeProfit',
    );
  });

  it('says nothing where the order names no origin', () => {
    expect(
      activeRow({ origin: null, status: 'Scheduled', scheduledTime: null }).detail,
    ).toBeUndefined();
  });

  it('prints a retry origin on the qualifier line, muted, in the reason’s key · pairs shape', () => {
    expect(
      text(
        activeRow({
          origin: 'Retry',
          originData: { count: 1 },
          status: 'Scheduled',
          scheduledTime: null,
        }),
      ),
    ).toBe('Retry · count: 1,00');
    expect(
      inked(
        activeRow({
          origin: 'Retry',
          originData: { count: 1 },
          status: 'Scheduled',
          scheduledTime: null,
        }),
      ),
    ).toEqual(['muted:Retry · count: 1,00']);
  });

  it('names why a cancel is in flight beside who asked for it', () => {
    expect(text(activeRow({ cancelSource: 'server', cancelReason: 'TakeProfit' }))).toBe(
      'asked by the server · TakeProfit',
    );
  });

  it('carries why a position was closed on the sell, never on the opening leg', () => {
    const [chain] = buildBookChains({
      activeOrders: [],
      canceledOrders: [],
      positions: [],
      closedTrades: [makeClosedTrade({ closeOrigin: 'StopLoss' })],
    });
    const legs = chain!.tradeRows.map((row) => bookRowPresentation(row, chain!));

    expect(text(legs.find((leg) => leg.label === 'Filled')!)).toBe('StopLoss');
    expect(text(legs.find((leg) => leg.label === 'Closed')!)).not.toContain('StopLoss');
  });
});

describe('bookRowPresentation reasonData', () => {
  it('writes the numbers behind a reason beside it, in Turkish figures', () => {
    expect(
      text(
        canceledRow({ reason: 'BuyGuard', reasonData: { upperLimit: 119.34 }, explanation: null }),
      ),
    ).toBe('BuyGuard · upperLimit: 119,34');
  });

  it('prints the name of a default rather than a number it does not have', () => {
    expect(
      text(
        canceledRow({
          reason: 'BuyGuard',
          reasonData: { lowerLimit: 'floor' },
          explanation: null,
        }),
      ),
    ).toBe('BuyGuard · lowerLimit: floor');
  });

  it('keeps the numbers in the reason’s own ink, as one phrase', () => {
    expect(
      inked(canceledRow({ reason: 'BuyGuard', reasonData: { upperLimit: 119.34 } })),
    ).toContain('reason:BuyGuard · upperLimit: 119,34');
  });

  it('leaves out a value of a shape the contract does not describe', () => {
    expect(
      text(
        canceledRow({
          reason: 'TakeProfit',
          reasonData: { limit: 96.04, note: { nested: true } },
          explanation: null,
        }),
      ),
    ).toBe('TakeProfit · limit: 96,04');
  });

  it('separates several pairs with a comma, since the dots are already spent', () => {
    expect(
      text(
        canceledRow({
          reason: 'BuyGuard',
          reasonData: { upperLimit: 119.34, lowerLimit: 'floor' },
          explanation: null,
        }),
      ),
    ).toBe('BuyGuard · upperLimit: 119,34, lowerLimit: floor');
  });

  it('carries the numbers behind a cancel in flight too', () => {
    expect(
      text(
        activeRow({
          cancelSource: 'server',
          cancelReason: 'StopLoss',
          cancelReasonData: { limit: 96.04 },
        }),
      ),
    ).toBe('asked by the server · StopLoss · limit: 96,04');
  });
});

describe('bookRowPresentation source', () => {
  it('names who ended the order beside the status, and only on a stored death', () => {
    expect(canceledRow({ source: 'Server' }).source).toBe('Server');
    expect(activeRow({}).source).toBeUndefined();
  });

  it('says nothing where the server named nobody', () => {
    expect(canceledRow({ source: null }).source).toBeUndefined();
  });
});
