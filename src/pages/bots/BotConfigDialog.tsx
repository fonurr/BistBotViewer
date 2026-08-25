import { useQueryClient } from '@tanstack/react-query';
import { useId, useMemo, useRef, useState, type KeyboardEvent } from 'react';

import { useViewerRuntime } from '../../app/ViewerRuntime';
import { bistKeys } from '../../app/queryKeys';
import { bistApi } from '../../bistApi/client';
import { asBistApiError } from '../../bistApi/errors';
import type {
  Account,
  ActiveOrder,
  Bot,
  BotBudget,
  PendingOrderRequest,
  Position,
} from '../../bistApi/types';
import { Modal } from '../../components/Modal';
import { ResultList, type ActionResult } from '../../components/ResultList';
import { formatNumber, plural } from '../../domain/format';
import { committedAmount } from '../../domain/orders';
import {
  botFormFor,
  committedForBudget,
  newBotForm,
  requestMatchesCreatedBot,
  requestMatchesBot,
  sameBotStoredRecord,
  validateBotForm,
  type BotFormState,
} from './botsModel';

export type BotConfigMode = 'add' | 'edit' | 'finish';

interface BotConfigDialogProps {
  mode: BotConfigMode;
  bot: Bot | null;
  bots: readonly Bot[];
  accounts: readonly Account[];
  activeOrders: readonly ActiveOrder[];
  positions: readonly Position[];
  pendingRequests: readonly PendingOrderRequest[];
  budget: BotBudget | undefined;
  onClose: () => void;
}

type Step = 'form' | 'sending' | 'result';

export function BotConfigDialog({
  mode,
  bot,
  bots,
  accounts,
  activeOrders,
  positions,
  pendingRequests,
  budget,
  onClose,
}: BotConfigDialogProps) {
  const runtime = useViewerRuntime();
  const queryClient = useQueryClient();
  const writesHeldRef = useRef(runtime.writesHeldReason);
  writesHeldRef.current = runtime.writesHeldReason;
  const [step, setStep] = useState<Step>('form');
  const [form, setForm] = useState<BotFormState>(() => (bot ? botFormFor(bot) : newBotForm()));
  const [forbiddenDraft, setForbiddenDraft] = useState('');
  const [forbiddenDuplicate, setForbiddenDuplicate] = useState<string | null>(null);
  const [results, setResults] = useState<ActionResult[]>([]);
  const [resultNote, setResultNote] = useState<string | null>(null);
  const accountListId = useId();
  const brokerageListId = useId();
  const botOrders = activeOrders.filter((row) => row.botId === bot?.id);
  const botPositions = positions.filter((row) => row.botId === bot?.id);
  const botPendingRequests = pendingRequests.filter((row) => row.botId === bot?.id);
  const accountLocked = Boolean(
    bot && (botOrders.length > 0 || botPositions.length > 0 || botPendingRequests.length > 0),
  );
  const existingBotIds = useMemo(() => new Set(bots.map((row) => row.id)), [bots]);
  const committed = committedForBudget(budget);
  const validation = useMemo(
    () =>
      validateBotForm(form, {
        original: bot,
        existingBotIds,
        accountLocked,
        committed,
      }),
    [accountLocked, bot, committed, existingBotIds, form],
  );
  const heldForbidden = useMemo(() => {
    const held = new Set(botPositions.map((position) => position.symbol.toUpperCase()));
    return form.forbiddenStocks.filter((symbol) => held.has(symbol.toUpperCase()));
  }, [botPositions, form.forbiddenStocks]);
  const formBlocked = validation.request === null || runtime.writesHeldReason !== null;
  const title =
    step === 'result'
      ? 'Bot record result'
      : mode === 'add'
        ? 'New bot'
        : mode === 'finish'
          ? `Finish setting up ${bot?.id ?? ''}`
          : `Edit ${bot?.id ?? ''}`;

  const setField = <Key extends keyof BotFormState>(key: Key, value: BotFormState[Key]) => {
    setForm((current) => ({ ...current, [key]: value }));
  };

  const addForbidden = () => {
    const symbol = forbiddenDraft.trim().toUpperCase();
    if (!symbol) return;
    if (form.forbiddenStocks.includes(symbol)) {
      setForbiddenDuplicate(symbol);
      return;
    }
    setField('forbiddenStocks', [...form.forbiddenStocks, symbol]);
    setForbiddenDraft('');
    setForbiddenDuplicate(null);
  };

  const handleForbiddenKey = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    addForbidden();
  };

  const notSent = (label: string, detail: string) => {
    setResults([{ id: 'configure-bot', label, tone: 'not-sent', detail }]);
    setResultNote('No ConfigureBot call was made. Reopen the form from the fresh snapshot.');
    setStep('result');
  };

  const submit = async () => {
    const request = validation.request;
    if (!request || writesHeldRef.current) return;
    setStep('sending');
    setResults([]);
    setResultNote(null);
    let writeSent = false;
    let writeConfirmed = false;

    try {
      const [freshBots, freshPendingRequests] = await Promise.all([
        bistApi.getBots(),
        bistApi.getPendingOrderRequests('*'),
      ]);
      queryClient.setQueryData(bistKeys.bots, freshBots);
      const fresh = freshBots.find((row) => row.id === request.id);
      const freshPendingForId = freshPendingRequests.filter((row) => row.botId === request.id);

      if (!bot && fresh) {
        notSent(
          `Add ${request.id}`,
          'A fresh GetBots snapshot found this id. ConfigureBot is an upsert, so sending Add would overwrite it.',
        );
        return;
      }
      if (!bot && freshPendingForId.length > 0) {
        notSent(
          `Add ${request.id}`,
          `${freshPendingForId.length} queued order request${freshPendingForId.length === 1 ? '' : 's'} still use this id. Creating a new bot could replay old orders under its configuration, so ConfigureBot was not called.`,
        );
        return;
      }
      if (bot && !fresh) {
        notSent(
          `Save ${request.id}`,
          'A fresh GetBots snapshot no longer contains this bot. Sending an update would recreate it.',
        );
        return;
      }
      if (bot && fresh) {
        if (!sameBotStoredRecord(bot, fresh)) {
          notSent(
            `Save ${request.id}`,
            'The bot record changed after this form opened. The stale form was not allowed to overwrite the fresh configuration.',
          );
          return;
        }
      }

      if (bot && (request.accountId !== undefined || request.brokerageId !== undefined)) {
        if (freshPendingForId.length > 0) {
          notSent(
            `Move ${bot.id}`,
            `${freshPendingForId.length} queued order request${freshPendingForId.length === 1 ? '' : 's'} would replay against the new account. Cancel the queued baskets before changing routing.`,
          );
          return;
        }
        const [freshOrders, freshPositions] = await Promise.all([
          bistApi.getActiveOrders(bot.id),
          bistApi.getPositions(bot.id),
        ]);
        if (freshOrders.length > 0 || freshPositions.length > 0) {
          notSent(
            `Move ${bot.id}`,
            `The fresh row check found ${plural(
              freshOrders.length,
              'active or scheduled order',
            )} and ${plural(freshPositions.length, 'position')}. The server would reject an account change.`,
          );
          return;
        }
      }

      if (bot?.complete && request.limit !== undefined) {
        const freshBudget = await bistApi.getBotBudget(bot.id);
        const freshCommitted = committedAmount(freshBudget);
        if (request.limit < freshCommitted) {
          notSent(
            `Change ${bot.id} limit`,
            `The fresh budget has ${formatNumber(freshCommitted)} TL committed, above the requested ${formatNumber(request.limit)} TL limit.`,
          );
          return;
        }
      }

      if (writesHeldRef.current) {
        notSent(`Save ${request.id}`, writesHeldRef.current);
        return;
      }

      writeSent = true;
      await bistApi.configureBot(request);
      writeConfirmed = true;
      const afterBots = await bistApi.getBots();
      queryClient.setQueryData(bistKeys.bots, afterBots);
      const after = afterBots.find((row) => row.id === request.id);
      const snapshotMatches = after
        ? bot
          ? requestMatchesBot(request, after)
          : requestMatchesCreatedBot(request, after)
        : false;

      if (!snapshotMatches) {
        setResults([
          {
            id: 'configure-bot-write',
            label: 'Configuration saved',
            tone: 'landed',
            detail: 'ConfigureBot returned its documented success response.',
          },
          {
            id: 'configure-bot-snapshot',
            label: `Resolve ${request.id}`,
            tone: 'unknown',
            detail:
              'The immediate GetBots snapshot did not confirm the expected record and create defaults.',
          },
        ]);
        setResultNote('Do not send it again. Refresh and inspect the bot record first.');
      } else {
        const incomplete = validation.missingFields.length > 0;
        setResults([
          {
            id: 'configure-bot',
            label: `${mode === 'add' ? 'Created' : 'Saved'} ${request.id}`,
            tone: 'landed',
            detail: `Confirmed in a fresh GetBots snapshot${incomplete ? ' as an incomplete bot' : ''}.`,
          },
        ]);
        setResultNote(
          incomplete
            ? `Missing ${validation.missingFields.join(', ')}. Every order endpoint rejects this bot and scheduled orders are skipped until those fields are set.`
            : validation.changedFields.length === 0
              ? 'Only the id was sent; omitted optional fields took their API defaults.'
              : `The id plus ${validation.changedFields.join(', ')} were sent.`,
        );
        void queryClient.invalidateQueries({
          queryKey: bistKeys.budget(request.id),
        });
      }
      setStep('result');
    } catch (error) {
      const apiError = asBistApiError(error);
      if (writeConfirmed) {
        setResults([
          {
            id: 'configure-bot-write',
            label: 'Configuration saved',
            tone: 'landed',
            detail: 'ConfigureBot returned its documented success response.',
          },
          {
            id: 'configure-bot-snapshot',
            label: `Resolve ${request.id}`,
            tone: 'unknown',
            detail: apiError.message,
          },
        ]);
        setResultNote('Do not send it again. Refresh GetBots and inspect the current record.');
      } else if (!writeSent) {
        setResults([
          {
            id: 'configure-bot-preflight',
            label: `${mode === 'add' ? 'Add' : 'Update'} ${request.id}`,
            tone: 'not-sent',
            detail: `The safety preflight could not finish: ${apiError.message}`,
          },
        ]);
        setResultNote(
          'No ConfigureBot call was made. Refresh the reads before trying from a new form.',
        );
      } else {
        const unknown = apiError.mayHaveReachedExchange || apiError.kind !== 'refused';
        setResults([
          {
            id: 'configure-bot',
            label: `${mode === 'add' ? 'Add' : 'Update'} ${request.id}`,
            tone: unknown ? 'unknown' : 'refused',
            detail: apiError.message,
          },
        ]);
        setResultNote(
          unknown
            ? 'Do not retry. A fresh GetBots snapshot must resolve whether the record changed.'
            : 'The server refused the one call. Nothing was retried.',
        );
      }
      setStep('result');
    }
  };

  return (
    <Modal open title={title} onClose={onClose} closeBlocked={step === 'sending'} wide>
      {step === 'form' ? (
        <>
          <p className="bots-dialog-subhead">
            {mode === 'add'
              ? 'Only id is required. Blank optional fields stay unset and create an incomplete, but real, bot.'
              : 'This is a partial update. Only changed fields are sent; blanking an existing routing field is not allowed.'}
          </p>

          <div className="bots-form">
            <div className="bots-form-grid bots-form-grid-two">
              <div className="field">
                <label htmlFor="bot-id">bot id{bot ? ' · cannot change' : ''}</label>
                <input
                  id="bot-id"
                  className="input"
                  value={form.id}
                  readOnly={Boolean(bot)}
                  onChange={(event) => setField('id', event.target.value)}
                  placeholder="algo-…"
                />
              </div>
              <div className="field">
                <label htmlFor="bot-algorithm">algorithm id</label>
                <input
                  id="bot-algorithm"
                  className="input"
                  value={form.algoritmId}
                  onChange={(event) => setField('algoritmId', event.target.value)}
                  placeholder="alg-…"
                />
              </div>
            </div>

            <fieldset className="bots-fieldset">
              <legend>
                <span className="kicker">account</span>
                <span className="muted">account and brokerage · both, or neither</span>
              </legend>
              <div className="bots-form-grid bots-form-grid-two">
                <div className="field">
                  <label htmlFor="bot-account">account id</label>
                  <input
                    id="bot-account"
                    className="input"
                    list={accountListId}
                    value={form.accountId}
                    readOnly={accountLocked}
                    onChange={(event) => setField('accountId', event.target.value)}
                    placeholder="0~1887087"
                  />
                </div>
                <div className="field">
                  <label htmlFor="bot-brokerage">brokerage id</label>
                  <input
                    id="bot-brokerage"
                    className="input"
                    list={brokerageListId}
                    value={form.brokerageId}
                    readOnly={accountLocked}
                    onChange={(event) => setField('brokerageId', event.target.value)}
                    placeholder="115"
                  />
                </div>
              </div>
              <datalist id={accountListId}>
                {accounts.map((account) => (
                  <option
                    key={`${account.accountId}:${account.brokerageId}`}
                    value={account.accountId}
                  >
                    {account.owner || account.brokerageName}
                  </option>
                ))}
              </datalist>
              <datalist id={brokerageListId}>
                {[...new Set(accounts.map((account) => account.brokerageId))].map((brokerageId) => (
                  <option key={brokerageId} value={brokerageId} />
                ))}
              </datalist>
              {accountLocked ? (
                <p className="bots-field-note">
                  Locked because this bot has{' '}
                  {plural(botOrders.length, 'active or scheduled order')} and{' '}
                  {plural(botPositions.length, 'position')}, plus{' '}
                  {plural(botPendingRequests.length, 'queued basket')}. Existing rows are never
                  rerouted, and queued baskets must be canceled before an account change.
                </p>
              ) : null}
            </fieldset>

            <fieldset className="bots-fieldset">
              <legend>
                <span className="kicker">limits</span>
                <span className="muted">the caps every order is sized against</span>
              </legend>
              <div className="bots-form-grid bots-form-grid-four">
                <NumberField
                  label="limit · TL"
                  value={form.limit}
                  onChange={(value) => setField('limit', value)}
                />
                <NumberField
                  label="limit · %"
                  value={form.limitPercentage}
                  onChange={(value) => setField('limitPercentage', value)}
                />
                <NumberField
                  label="per stock · TL"
                  value={form.limitPerPosition}
                  onChange={(value) => setField('limitPerPosition', value)}
                />
                <NumberField
                  label="per stock · %"
                  value={form.limitPercentagePerPosition}
                  onChange={(value) => setField('limitPercentagePerPosition', value)}
                />
              </div>
              <p className="bots-field-note">
                Effective per-stock cap is whichever is smaller: the TL figure, or portfolio value ×
                the percentage.
                {committed === null
                  ? ' Current committed money is not available yet.'
                  : ` Committed right now: ${formatNumber(committed)} TL.`}{' '}
                Lowering a limit never pulls a live order; it only stops the next one.
              </p>
            </fieldset>

            <div className="bots-form-grid bots-form-grid-two">
              <div className="field">
                <label htmlFor="bot-emails">emails · comma separated</label>
                <input
                  id="bot-emails"
                  className="input"
                  value={form.emails}
                  onChange={(event) => {
                    setField('emails', event.target.value);
                    if (!form.emailsSet && event.target.value.length > 0)
                      setField('emailsSet', true);
                  }}
                  placeholder="owner@example.com"
                />
                {bot?.emails === null || !bot ? (
                  <label className="bots-inline-check">
                    <input
                      type="checkbox"
                      checked={form.emailsSet}
                      onChange={(event) => setField('emailsSet', event.target.checked)}
                    />
                    Store this list; an empty array still counts as set
                  </label>
                ) : (
                  <span className="bots-field-note">
                    Clearing this field saves an empty list; it does not unset emails.
                  </span>
                )}
              </div>
              <div className="field">
                <label htmlFor="bot-description">description · display only</label>
                <textarea
                  id="bot-description"
                  className="input"
                  value={form.description}
                  onChange={(event) => setField('description', event.target.value)}
                  placeholder="What this bot does"
                />
              </div>
            </div>

            <fieldset className="bots-fieldset">
              <legend>
                <span className="kicker">forbidden stocks</span>
                <span className="muted">never bought, never sold</span>
              </legend>
              <div className="bots-chip-field">
                {form.forbiddenStocks.map((symbol) => (
                  <button
                    type="button"
                    className="tag tag-outline bots-chip-remove"
                    key={symbol}
                    onClick={() =>
                      setField(
                        'forbiddenStocks',
                        form.forbiddenStocks.filter((value) => value !== symbol),
                      )
                    }
                    aria-label={`Remove ${symbol} from forbidden stocks`}
                  >
                    {symbol} <span aria-hidden="true">×</span>
                  </button>
                ))}
                {form.forbiddenStocks.length === 0 ? (
                  <span className="muted bots-empty-chip-copy">none yet</span>
                ) : null}
                <input
                  className="input bots-chip-input"
                  value={forbiddenDraft}
                  onChange={(event) => {
                    setForbiddenDraft(event.target.value);
                    setForbiddenDuplicate(null);
                  }}
                  onKeyDown={handleForbiddenKey}
                  placeholder="add symbol"
                  aria-label="Forbidden stock to add"
                />
                {forbiddenDraft.trim() ? (
                  <button type="button" className="btn btn-ghost" onClick={addForbidden}>
                    add {forbiddenDraft.trim().toUpperCase()}
                  </button>
                ) : null}
              </div>
              {forbiddenDuplicate ? (
                <p className="status-wait bots-field-note" role="status">
                  {forbiddenDuplicate} is already on the list.
                </p>
              ) : null}
              <p className="bots-field-note">
                Free text, uppercased, and not validated by ConfigureBot. This whole list replaces
                the stored list. Its holdings value is removed from the percentage-budget base.
              </p>
              {heldForbidden.length > 0 ? (
                <p className="status-warn bots-field-note" role="alert">
                  Loaded bot positions include {heldForbidden.join(', ')}. Forbidding these names
                  also stops this bot selling them, so closing becomes a human’s job. The account
                  may hold other names that this bot-position read does not expose.
                </p>
              ) : null}
            </fieldset>

            {validation.missingFields.length > 0 ? (
              <p className="status-wait bots-form-message">
                Missing {validation.missingFields.join(', ')}. Saving incomplete is allowed, but
                every order endpoint rejects this bot and scheduled orders are skipped until those
                fields are set.
              </p>
            ) : null}
            {validation.blockReason ? (
              <p className="status-dead bots-form-message" role="alert" aria-live="polite">
                {validation.blockReason}
              </p>
            ) : null}
            {runtime.writesHeldReason ? (
              <p className="status-warn bots-form-message" role="alert">
                {runtime.writesHeldReason}
              </p>
            ) : null}
          </div>

          <div className="dialog-actions">
            <button type="button" className="btn btn-secondary" onClick={onClose}>
              Close
            </button>
            <button
              type="button"
              className="btn btn-primary"
              disabled={formBlocked}
              onClick={() => void submit()}
            >
              {mode === 'add'
                ? 'Create bot'
                : mode === 'finish'
                  ? 'Finish setup'
                  : 'Send the changes'}
            </button>
          </div>
        </>
      ) : null}

      {step === 'sending' ? (
        <div className="bots-sending" role="status">
          <span className="spinner" />
          <div>
            <strong>Checking a fresh snapshot, then sending ConfigureBot once</strong>
            <span>The dialog stays open until the reply and one reconciliation read finish.</span>
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

function NumberField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <div className="field">
      <label>
        {label}
        <input
          className="input"
          inputMode="decimal"
          value={value}
          onChange={(event) => onChange(event.target.value)}
        />
      </label>
    </div>
  );
}
