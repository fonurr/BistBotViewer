import { beforeEach, describe, expect, it } from 'vitest';

import { makeActiveOrder, makePosition } from '../test/fixtures';
import {
  bistJournalChangedForBot,
  bistJournalCheckpoint,
  recordBistWriteEvent,
  replayBistJournal,
  resetBistJournalForTests,
} from './eventJournal';

beforeEach(resetBistJournalForTests);

describe('BIST event journal', () => {
  it('detects a bot mutation that straddles a budget read', () => {
    const checkpoint = bistJournalCheckpoint();
    recordBistWriteEvent({
      table: 'ActiveOrders',
      action: 'insert',
      botId: 'bot-alpha',
      row: makeActiveOrder(),
    });

    expect(bistJournalChangedForBot(checkpoint, 'bot-alpha')).toBe(true);
    expect(bistJournalChangedForBot(checkpoint, 'other-bot')).toBe(false);
  });

  it('replays a write that arrives while a lazy table read is unresolved', () => {
    const checkpoint = bistJournalCheckpoint();
    recordBistWriteEvent({
      table: 'Positions',
      action: 'insert',
      botId: 'bot-alpha',
      row: makePosition(),
    });

    expect(replayBistJournal(checkpoint, 'positions', '*', [])).toEqual([makePosition()]);
    expect(replayBistJournal(checkpoint, 'positions', 'other-bot', [])).toEqual([]);
  });

  it('applies update and delete events over an older HTTP snapshot in order', () => {
    const original = makeActiveOrder({ orderPrice: 10 });
    const checkpoint = bistJournalCheckpoint();
    recordBistWriteEvent({
      table: 'ActiveOrders',
      action: 'update',
      botId: original.botId,
      row: { ...original, orderPrice: 11 },
    });
    recordBistWriteEvent({
      table: 'ActiveOrders',
      action: 'delete',
      botId: original.botId,
      row: { ...original, orderPrice: 11 },
    });

    expect(replayBistJournal(checkpoint, 'activeOrders', original.botId, [original])).toEqual([]);
  });

  it('normalizes scheduled and queued-request event rows like table reads do', () => {
    const scheduled = makeActiveOrder({
      status: 'Scheduled',
      matriksOrderId: null,
      orderTime: null,
      sentTime: null,
    });
    const checkpoint = bistJournalCheckpoint();
    recordBistWriteEvent({
      table: 'ScheduledOrders',
      action: 'insert',
      botId: scheduled.botId,
      row: scheduled,
    });
    recordBistWriteEvent({
      table: 'PendingOrderRequests',
      action: 'insert',
      botId: scheduled.botId,
      row: {
        id: 9,
        botId: scheduled.botId,
        direction: 'buy',
        requestBody: JSON.stringify(null),
        createdTime: 1,
        retryCount: 0,
        nextAttemptTime: 2,
      },
    });

    expect(replayBistJournal(checkpoint, 'activeOrders', '*', [])).toMatchObject([
      { status: 'Scheduled', filledQuantity: 0 },
    ]);
    expect(replayBistJournal(checkpoint, 'pendingRequests', '*', [])).toMatchObject([
      { id: 9, request: null },
    ]);
  });
});
