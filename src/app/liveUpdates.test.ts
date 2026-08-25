import { QueryClient } from '@tanstack/react-query';

import { makeActiveOrder, makeBotBudget } from '../test/fixtures/bist';
import { applyWriteEvent } from './liveUpdates';
import { bistKeys } from './queryKeys';

describe('live cache reconciliation', () => {
  it('invalidates the affected bot budget after a money-bearing row changes', () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(bistKeys.activeOrders('*'), []);
    queryClient.setQueryData(bistKeys.budget('bot-alpha'), makeBotBudget());

    applyWriteEvent(queryClient, {
      table: 'ActiveOrders',
      action: 'insert',
      botId: 'bot-alpha',
      row: makeActiveOrder(),
    });

    expect(queryClient.getQueryData(bistKeys.activeOrders('*'))).toHaveLength(1);
    expect(queryClient.getQueryState(bistKeys.budget('bot-alpha'))?.isInvalidated).toBe(true);
  });

  it('keeps separate adopted rows whose client ids are blank', () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(bistKeys.activeOrders('*'), []);

    applyWriteEvent(queryClient, {
      table: 'ActiveOrders',
      action: 'insert',
      botId: 'bot-alpha',
      row: makeActiveOrder({ id: 801, clientOrderId: '' }),
    });
    applyWriteEvent(queryClient, {
      table: 'ActiveOrders',
      action: 'insert',
      botId: 'bot-alpha',
      row: makeActiveOrder({ id: 802, clientOrderId: '' }),
    });

    expect(queryClient.getQueryData(bistKeys.activeOrders('*'))).toHaveLength(2);
  });
});
