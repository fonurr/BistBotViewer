import { useQueryClient } from '@tanstack/react-query';
import { useRef, useState } from 'react';

import { bistKeys } from '../../app/queryKeys';
import { useViewerRuntime } from '../../app/ViewerRuntime';
import { bistApi } from '../../bistApi/client';
import { asBistApiError } from '../../bistApi/errors';
import type { Bot, BotBudget } from '../../bistApi/types';
import { Modal } from '../../components/Modal';
import { ResultList, type ActionResult } from '../../components/ResultList';
import { formatNumber, plural } from '../../domain/format';
import {
  committedForBudget,
  sameBotConfiguration,
  statusActionFor,
  summarizeBot,
  type BotRowCounts,
  type BotStatusAction,
} from './botsModel';

interface BotStatusDialogProps {
  bot: Bot;
  counts: BotRowCounts;
  budget: BotBudget | undefined;
  onClose: () => void;
}

type Step = 'confirm' | 'sending' | 'result';

export function BotStatusDialog({ bot, counts, budget, onClose }: BotStatusDialogProps) {
  const runtime = useViewerRuntime();
  const queryClient = useQueryClient();
  const writesHeldRef = useRef(runtime.writesHeldReason);
  writesHeldRef.current = runtime.writesHeldReason;
  const [step, setStep] = useState<Step>('confirm');
  const [snapshotBot, setSnapshotBot] = useState(bot);
  const [snapshotCounts, setSnapshotCounts] = useState(counts);
  const [preflightNote, setPreflightNote] = useState<string | null>(null);
  const [results, setResults] = useState<ActionResult[]>([]);
  const [resultNote, setResultNote] = useState<string | null>(null);
  const action = statusActionFor(snapshotBot, snapshotCounts);
  const committed = committedForBudget(budget);

  const finishWithoutWrite = (label: string, detail: string, achieved = false) => {
    setResults([
      {
        id: 'bot-status-preflight',
        label,
        tone: achieved ? 'landed' : 'not-sent',
        detail,
      },
    ]);
    setResultNote(
      achieved
        ? 'The fresh snapshot already had the requested state, so ConfigureBot was not called.'
        : 'ConfigureBot was not called. Reopen the action from a fresh Bots snapshot.',
    );
    setStep('result');
  };

  const submit = async () => {
    if (writesHeldRef.current || action === 'blocked') return;
    const expectedAction = action;
    setStep('sending');
    setResults([]);
    setResultNote(null);
    setPreflightNote(null);
    let writeSent = false;
    let writeConfirmed = false;

    try {
      const [freshBots, freshOrders, freshPositions, freshTrades, freshPendingRequests] =
        await Promise.all([
          bistApi.getBots(),
          bistApi.getActiveOrders(snapshotBot.id),
          bistApi.getPositions(snapshotBot.id),
          bistApi.getClosedTrades(snapshotBot.id),
          bistApi.getPendingOrderRequests(snapshotBot.id),
        ]);
      queryClient.setQueryData(bistKeys.bots, freshBots);
      const freshBot = freshBots.find((row) => row.id === snapshotBot.id);
      if (!freshBot) {
        finishWithoutWrite(
          `${snapshotBot.id} is absent`,
          expectedAction === 'reactivate'
            ? 'A fresh GetBots snapshot found no record. Reactivate would recreate a new default bot, so it was blocked.'
            : 'A fresh GetBots snapshot found that the record is already gone.',
          expectedAction !== 'reactivate',
        );
        return;
      }

      if (expectedAction === 'reactivate' && freshBot.active) {
        finishWithoutWrite(
          `${freshBot.id} is already active`,
          'The fresh GetBots snapshot confirmed active: true.',
          true,
        );
        return;
      }
      if (expectedAction !== 'reactivate' && !freshBot.active) {
        finishWithoutWrite(
          `${freshBot.id} is already deactivated`,
          'The fresh GetBots snapshot confirmed active: false.',
          true,
        );
        return;
      }

      const freshSummary = summarizeBot(
        freshBot.id,
        freshOrders,
        freshPositions,
        freshTrades,
        freshPendingRequests,
      );
      const freshAction = statusActionFor(freshBot, freshSummary.rowCounts);
      const countsChanged = !sameCounts(snapshotCounts, freshSummary.rowCounts);
      const configurationChanged = !sameBotConfiguration(snapshotBot, freshBot);
      if (
        freshAction !== expectedAction ||
        countsChanged ||
        (freshAction === 'reactivate' && configurationChanged)
      ) {
        setSnapshotBot(freshBot);
        setSnapshotCounts(freshSummary.rowCounts);
        setPreflightNote(
          freshAction !== expectedAction
            ? `The row counts changed. The action is now ${freshAction}; review the updated confirmation before committing.`
            : configurationChanged
              ? 'The inactive bot configuration changed. Review its current limits and rows before reactivating it.'
              : 'The row counts changed. Review the updated confirmation before committing.',
        );
        setStep('confirm');
        return;
      }

      if (writesHeldRef.current) {
        finishWithoutWrite(`Change ${freshBot.id}`, writesHeldRef.current);
        return;
      }

      const request = {
        id: freshBot.id,
        active: freshAction === 'reactivate',
      } as const;
      writeSent = true;
      await bistApi.configureBot(request);
      writeConfirmed = true;
      const [afterBots, afterPendingRequests] = await Promise.all([
        bistApi.getBots(),
        bistApi.getPendingOrderRequests('*'),
      ]);
      queryClient.setQueryData(bistKeys.bots, afterBots);
      const after = afterBots.find((row) => row.id === freshBot.id);
      const orphanPending = afterPendingRequests.filter((row) => row.botId === freshBot.id);

      if (freshAction === 'reactivate') {
        if (after?.active && sameBotConfiguration(freshBot, after)) {
          setResults([
            {
              id: 'bot-status',
              label: `Reactivated ${freshBot.id}`,
              tone: 'landed',
              detail: after.complete
                ? 'The fresh GetBots snapshot confirms it can buy again from the next batch.'
                : 'The fresh GetBots snapshot confirms active: true, but the bot remains incomplete and cannot place orders.',
            },
          ]);
          setResultNote(
            'Skipped scheduled buys are not replayed. Only rows the server still holds as SkippedForNow get another attempt.',
          );
        } else {
          unresolvedResult(freshBot.id, setResults, setResultNote);
        }
      } else if (!after && orphanPending.length > 0) {
        setResults([
          {
            id: 'bot-status-write',
            label: `Deleted ${freshBot.id}`,
            tone: 'landed',
            detail: 'The immediate GetBots snapshot confirms the record is absent.',
          },
          {
            id: 'bot-status-pending',
            label: `${orphanPending.length} queued request${orphanPending.length === 1 ? '' : 's'} remain`,
            tone: 'unknown',
            detail:
              'Do not recreate this bot id. An old basket could replay under the new record; cancel it from the Book first.',
          },
        ]);
        setResultNote('The bot name is not safe to reuse while queued requests remain.');
      } else if (!after) {
        setResults([
          {
            id: 'bot-status',
            label: `Deleted ${freshBot.id}`,
            tone: 'landed',
            detail: 'The immediate GetBots snapshot confirms the record is absent.',
          },
        ]);
        setResultNote(
          'The name is free again. A later bot with the same id will be a different record.',
        );
        void queryClient.invalidateQueries({
          queryKey: ['bist', 'canceledOrders'],
        });
        queryClient.removeQueries({
          queryKey: bistKeys.budget(freshBot.id),
          exact: true,
        });
      } else if (!after.active) {
        setResults([
          {
            id: 'bot-status',
            label: `Deactivated ${freshBot.id}`,
            tone: 'landed',
            detail: 'The immediate GetBots snapshot confirms active: false.',
          },
        ]);
        setResultNote(
          freshSummary.rowCounts.positions > 0
            ? `${plural(freshSummary.rowCounts.positions, 'open position')} ${
                freshSummary.rowCounts.positions === 1 ? 'remains' : 'remain'
              }. The bot can still sell, but a human now owns ${
                freshSummary.rowCounts.positions === 1 ? 'its exit' : 'their exits'
              }.`
            : 'The record and its existing rows remain; new buys are blocked.',
        );
      } else {
        unresolvedResult(freshBot.id, setResults, setResultNote);
      }

      if (after) {
        void queryClient.invalidateQueries({
          queryKey: bistKeys.budget(freshBot.id),
        });
      }
      setStep('result');
    } catch (error) {
      const apiError = asBistApiError(error);
      if (writeConfirmed) {
        setResults([
          {
            id: 'bot-status-write',
            label: 'Configuration saved',
            tone: 'landed',
            detail: 'ConfigureBot returned its documented success response.',
          },
          {
            id: 'bot-status-snapshot',
            label: `Resolve ${snapshotBot.id}`,
            tone: 'unknown',
            detail: apiError.message,
          },
        ]);
        setResultNote(
          'The resulting bot state is unavailable. Do not send the action again; refresh GetBots first.',
        );
      } else if (!writeSent) {
        setResults([
          {
            id: 'bot-status-preflight',
            label: `Check ${snapshotBot.id}`,
            tone: 'not-sent',
            detail: `The fresh row check failed: ${apiError.message}`,
          },
        ]);
        setResultNote(
          'No ConfigureBot call was made. Refresh the reads before opening the action again.',
        );
      } else {
        const unknown = apiError.mayHaveReachedExchange || apiError.kind !== 'refused';
        setResults([
          {
            id: 'bot-status',
            label: `${expectedActionLabel(expectedAction)} ${snapshotBot.id}`,
            tone: unknown ? 'unknown' : 'refused',
            detail: apiError.message,
          },
        ]);
        setResultNote(
          unknown
            ? 'Do not retry. A fresh GetBots snapshot must resolve the current bot state.'
            : 'The server refused the one call. Nothing was retried.',
        );
      }
      setStep('result');
    }
  };

  return (
    <Modal
      open
      title={`${expectedActionLabel(action)} ${snapshotBot.id}`}
      onClose={onClose}
      closeBlocked={step === 'sending'}
    >
      {step === 'confirm' ? (
        <>
          <div className={`bots-status-confirm bots-status-${action}`}>
            <strong>{statusVerdict(action)}</strong>
            <p>{statusExplanation(action, snapshotCounts)}</p>
            <div className="bots-status-counts">
              <StatusCount label="active orders" value={snapshotCounts.activeOrders} />
              <StatusCount label="scheduled orders" value={snapshotCounts.scheduledOrders} />
              <StatusCount label="open positions" value={snapshotCounts.positions} />
              <StatusCount label="closed trades" value={snapshotCounts.closedTrades} />
              <StatusCount label="queued baskets" value={snapshotCounts.pendingRequests} />
            </div>
            {action === 'delete' ? (
              <p className="status-dead">
                There is no undo. Its canceled-order history is removed too, and the name becomes
                free for an unrelated bot.
              </p>
            ) : null}
            {action === 'blocked' ? (
              <p className="status-dead">
                Cancel every queued basket in the Book first. They retain this bot id and can replay
                against its current state; deletion, routing changes, and reactivation are held.
              </p>
            ) : null}
            {action === 'deactivate' ? (
              <p className="status-warn">
                It cannot buy, but it can still sell.{' '}
                {snapshotCounts.positions > 0
                  ? `${plural(snapshotCounts.positions, 'open position')} will have nobody managing ${
                      snapshotCounts.positions === 1 ? 'its exit' : 'their exits'
                    }.`
                  : 'Its remaining live rows stay attached to this record.'}
                {snapshotCounts.closedTrades === 0
                  ? ' If every remaining live row clears before ConfigureBot is processed, the same API call deletes the now-empty record and its canceled history; confirming accepts that outcome too.'
                  : ''}
              </p>
            ) : null}
            {action === 'reactivate' ? (
              <>
                <div className="bots-reactivate-facts">
                  <StatusCount label="open positions" value={snapshotCounts.positions} />
                  <StatusCount label="limit · TL" value={formatNumber(snapshotBot.limit)} />
                  <StatusCount
                    label="committed · TL"
                    value={committed === null ? 'not available' : formatNumber(committed)}
                  />
                  <StatusCount label="forbidden" value={snapshotBot.forbiddenStocks.length} />
                </div>
                <p>
                  It starts buying again from the next batch. Existing positions are unchanged; it
                  could always sell. Its limits and forbidden stocks stay as shown.
                </p>
                <p>
                  Scheduled buys skipped while it was off are not replayed. Only rows still held as
                  SkippedForNow get another attempt. If fields are still missing, it returns
                  incomplete and buys nothing.
                </p>
              </>
            ) : null}
          </div>
          {preflightNote ? (
            <p className="status-warn bots-form-message" role="status">
              {preflightNote}
            </p>
          ) : null}
          {runtime.writesHeldReason ? (
            <p className="status-warn bots-form-message" role="alert">
              {runtime.writesHeldReason}
            </p>
          ) : null}
          <div className="dialog-actions">
            <button type="button" className="btn btn-secondary" onClick={onClose}>
              Close
            </button>
            <button
              type="button"
              className={`btn btn-primary bots-status-commit bots-status-commit-${action}`}
              disabled={Boolean(runtime.writesHeldReason) || action === 'blocked'}
              onClick={() => void submit()}
            >
              {action === 'delete'
                ? 'Delete it'
                : action === 'deactivate'
                  ? snapshotCounts.closedTrades === 0
                    ? 'Deactivate, or delete if emptied'
                    : 'Deactivate it'
                  : action === 'reactivate'
                    ? 'Reactivate it'
                    : 'Cancel queued baskets first'}
            </button>
          </div>
        </>
      ) : null}

      {step === 'sending' ? (
        <div className="bots-sending" role="status">
          <span className="spinner" />
          <div>
            <strong>Checking row counts, then sending ConfigureBot once</strong>
            <span>The dialog stays open until a bot snapshot resolves the result.</span>
          </div>
        </div>
      ) : null}

      {step === 'result' ? (
        <>
          <ResultList results={results} />
          {resultNote ? <p className="bots-result-note">{resultNote}</p> : null}
          <div className="dialog-actions">
            <button type="button" className="btn btn-secondary" onClick={onClose}>
              Done
            </button>
          </div>
        </>
      ) : null}
    </Modal>
  );
}

function StatusCount({ label, value }: { label: string; value: string | number }) {
  return (
    <div>
      <span className="kicker">{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function expectedActionLabel(action: BotStatusAction): string {
  if (action === 'delete') return 'Delete';
  if (action === 'deactivate') return 'Deactivate';
  if (action === 'reactivate') return 'Reactivate';
  return 'Resolve queued baskets for';
}

function statusVerdict(action: BotStatusAction): string {
  if (action === 'delete') return 'This will delete the bot, not deactivate it.';
  if (action === 'deactivate') return 'This will stop new buys while persistent rows remain.';
  if (action === 'reactivate') return 'This will let the bot buy again.';
  return 'This bot cannot be deleted safely yet.';
}

function statusExplanation(action: BotStatusAction, counts: BotRowCounts): string {
  if (action === 'delete') {
    return 'Active orders, scheduled orders, positions, closed trades, and queued baskets are all zero.';
  }
  if (action === 'deactivate') {
    const persistent =
      counts.activeOrders + counts.scheduledOrders + counts.positions + counts.closedTrades;
    const baskets =
      counts.pendingRequests === 0
        ? ''
        : ` ${plural(counts.pendingRequests, 'queued basket')} ${
            counts.pendingRequests === 1 ? 'keeps' : 'keep'
          } this id.`;
    return `The server keeps a bot with persistent rows. Those rows total ${persistent}, so active: false deactivates it rather than deleting it.${baskets}`;
  }
  if (action === 'reactivate') {
    return 'A fresh snapshot must still find this inactive record before the app sends active: true; otherwise the upsert could recreate it.';
  }
  return `${plural(counts.pendingRequests, 'queued basket')} still ${
    counts.pendingRequests === 1 ? 'uses' : 'use'
  } this id and may replay before any later batch.`;
}

function unresolvedResult(
  botId: string,
  setResults: (results: ActionResult[]) => void,
  setResultNote: (note: string) => void,
) {
  setResults([
    {
      id: 'bot-status-write',
      label: 'Configuration saved',
      tone: 'landed',
      detail: 'ConfigureBot returned its documented success response.',
    },
    {
      id: 'bot-status-snapshot',
      label: `Resolve ${botId}`,
      tone: 'unknown',
      detail: 'The immediate GetBots snapshot did not confirm a safe semantic outcome.',
    },
  ]);
  setResultNote('Do not send the action again. Refresh and inspect the bot record first.');
}

function sameCounts(left: BotRowCounts, right: BotRowCounts): boolean {
  return (
    left.activeOrders === right.activeOrders &&
    left.scheduledOrders === right.scheduledOrders &&
    left.positions === right.positions &&
    left.closedTrades === right.closedTrades &&
    left.pendingRequests === right.pendingRequests
  );
}
