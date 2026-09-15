import { describe, expect, it } from 'vitest';

import { activeOrderSchema } from '../../bistApi/types';
import { buildBookChains } from '../../domain/chains';
import { makeActiveOrder, makeCanceledOrder, makePosition } from '../../test/fixtures';
import { orderActionsForRow } from './orderActions';

describe('Book order action eligibility', () => {
  it('accepts upstream transient statuses but only exposes exchange-safe actions', () => {
    const transient = activeOrderSchema.parse(
      makeActiveOrder({ status: 'PendingReplace', matriksOrderId: 'mx-1' }),
    );
    const [transientChain] = chains([transient]);
    expect(transientChain).toBeDefined();
    expect(orderActionsForRow(transientChain!.activeRows[0]!, transientChain!)).toEqual([]);

    const accepted = makeActiveOrder({ status: 'AcceptedForBidding', matriksOrderId: 'mx-2' });
    const [acceptedChain] = chains([accepted]);
    expect(
      orderActionsForRow(acceptedChain!.activeRows[0]!, acceptedChain!).map((a) => a.kind),
    ).toEqual(['edit', 'cancel']);
  });

  it('never offers actions for foreign rows without a usable client id', () => {
    const foreignA = makeActiveOrder({ id: 701, clientOrderId: '', chainId: null });
    const foreignB = makeActiveOrder({ id: 702, clientOrderId: '   ', chainId: null });
    const built = chains([foreignA, foreignB]);

    expect(built).toHaveLength(2);
    expect(new Set(built.map((chain) => chain.key)).size).toBe(2);
    built.forEach((chain) => {
      expect(orderActionsForRow(chain.activeRows[0]!, chain)).toEqual([]);
    });
  });
});

function chains(activeOrders: ReturnType<typeof makeActiveOrder>[]) {
  return buildBookChains({ activeOrders, canceledOrders: [], positions: [], closedTrades: [] });
}

describe('Book resend eligibility after a partial fill', () => {
  const partialChain = (canceledQuantity: number) =>
    buildBookChains({
      activeOrders: [],
      canceledOrders: [
        makeCanceledOrder({ orderQuantity: 1_001, canceledQuantity, status: 'Canceled' }),
      ],
      positions: [makePosition({ orderQuantity: 1_001, quantity: 375 })],
      closedTrades: [],
    })[0]!;

  it('offers resend when the position covers what the leg killed, not what it asked', () => {
    const chain = partialChain(375);
    expect(chain.sellableQuantity).toBe(375);
    expect(orderActionsForRow(chain.canceledRows[0]!, chain).map((a) => a.kind)).toEqual([
      'resend',
    ]);
  });

  it('still withholds it where the whole order died and the position cannot cover it', () => {
    const chain = partialChain(1_001);
    expect(orderActionsForRow(chain.canceledRows[0]!, chain)).toEqual([]);
  });
});
