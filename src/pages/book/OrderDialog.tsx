import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState } from 'react';

import { useViewerRuntime } from '../../app/ViewerRuntime';
import { bistKeys } from '../../app/queryKeys';
import { bistApi } from '../../bistApi/client';
import { asBistApiError } from '../../bistApi/errors';
import { hasBandLimits } from '../../bistApi/types';
import type {
  ActiveOrder,
  Bot,
  BotBudget,
  CanceledOrder,
  ClosePriceRule,
  Holiday,
  OpenPriceRule,
  OrderType,
  PriceBase,
  ScheduleSpec,
  ScheduleType,
  SendOrdersRequest,
  StoredPriceRule,
  WhenType,
} from '../../bistApi/types';
import { Modal } from '../../components/Modal';
import { useMinuteClock } from '../../components/useMinuteClock';
import { ResultList, type ActionResult } from '../../components/ResultList';
import type { BookCanceledOrderRow, BookChain } from '../../domain/chains';
import {
  formatCompactDuration,
  formatDateKey,
  formatNumber,
  formatPercentage,
  formatQuantity,
  formatSignedNumber,
  formatTime,
  parseTurkishNumber,
  plural,
  toIstanbulDateKey,
} from '../../domain/format';
import {
  EMPTY_CLOSE_PRICE_DRAFT,
  EMPTY_OPEN_PRICE_DRAFT,
  closePriceDraftFrom,
  describeClosePrice,
  describeOpenPrice,
  isNeutralClosePriceDraft,
  isNeutralOpenPriceDraft,
  openPriceDraftFrom,
  parseClosePrice,
  parseOpenPrice,
  readClosePrice,
  readClosePriceDraft,
  readOpenPrice,
  readOpenPriceDraft,
  sameClosePrice,
  sameOpenPrice,
  sameStoredRule,
  type ClosePriceDraft,
  type OpenPriceDraft,
  type RuleDraft,
} from '../../domain/priceRules';
import {
  deriveFilledPnlState,
  effectivePerPositionCap,
  pnlPercentage,
  realizedPnl,
  reservedBuyCost,
  slippagePercentage,
  unrealizedPnl,
} from '../../domain/orders';
import { resolveSchedule } from '../../domain/schedule';
import { statusClass } from '../../domain/status';
import { orderActionsForRow, type OrderDialogAction } from './orderActions';
import { bookRowPresentation } from './rowPresentation';

export type { OrderDialogAction } from './orderActions';

interface OrderDialogProps {
  open: boolean;
  chain: BookChain;
  initialAction?: OrderDialogAction;
  bot: Bot | undefined;
  budget: BotBudget | undefined;
  holidays: readonly Holiday[];
  writesHeldReason?: string | null;
  /** The chain's own market price, for the header figure. Null when untrusted. */
  marketPrice?: number | null;
  onClose: () => void;
}

type Step = 'view' | 'form' | 'confirm' | 'sending' | 'result';

interface Draft {
  type: OrderType;
  price: string;
  quantity: string;
  scheduled: boolean;
  day: string;
  scheduleType: ScheduleType;
  diff: string;
  cancelAtFloor: boolean;
  resendMode: 'same' | 'change';
  keepClose: boolean;
  changeSchedule: boolean;
  openPrice: RuleDraft<OpenPriceDraft>;
  closePrice: RuleDraft<ClosePriceDraft>;
}

/**
 * Where a row keeps its price rules. A position carries only the exit rule its
 * opening buy handed it; a closed trade carries neither.
 */
function rowRules(row: BookChain['rows'][number]): {
  open: StoredPriceRule;
  close: StoredPriceRule;
} {
  if (row.source === 'active' || row.source === 'scheduled' || row.source === 'canceled') {
    return { open: row.raw.openPrice, close: row.raw.closePrice };
  }
  if (row.source === 'position') return { open: undefined, close: row.raw.closePrice };
  return { open: undefined, close: undefined };
}

interface StoredRules {
  open: OpenPriceRule | null;
  close: ClosePriceRule | null;
  /** The row carries a rule in a form this viewer cannot re-express. */
  unreadable: boolean;
}

function storedRulesFor(action: OrderDialogAction | undefined): StoredRules {
  if (!action) return { open: null, close: null, unreadable: false };
  const raw = rowRules(action.row);
  const open = readOpenPrice(raw.open);
  const close = readClosePrice(raw.close);
  return {
    open: open.kind === 'rule' ? open.rule : null,
    close: close.kind === 'rule' ? close.rule : null,
    unreadable: open.kind === 'unreadable' || close.kind === 'unreadable',
  };
}

export function OrderDialog({
  open,
  chain,
  initialAction,
  bot,
  budget,
  holidays,
  writesHeldReason: pageWritesHeldReason = null,
  marketPrice = null,
  onClose,
}: OrderDialogProps) {
  const runtime = useViewerRuntime();
  const queryClient = useQueryClient();
  const [action, setAction] = useState<OrderDialogAction | undefined>(initialAction);
  const [step, setStep] = useState<Step>(initialAction ? actionStep(initialAction) : 'view');
  const [draft, setDraft] = useState<Draft>(() => draftFor(initialAction, chain));
  const [results, setResults] = useState<ActionResult[]>([]);
  const [resultTitle, setResultTitle] = useState<string | null>(null);

  const writesHeldReason = pageWritesHeldReason ?? runtime.writesHeldReason;
  const writesHeldRef = useRef(writesHeldReason);
  writesHeldRef.current = writesHeldReason;

  useEffect(() => {
    if (!action || step === 'sending' || step === 'result') return;
    const freshRow =
      chain.rows.find((row) => row.key === action.row.key) ??
      (action.row.clientOrderId === null
        ? undefined
        : chain.rows.find((row) => row.clientOrderId === action.row.clientOrderId));
    if (freshRow === action.row) return;
    const freshAction = freshRow
      ? orderActionsForRow(freshRow, chain).find((candidate) => candidate.kind === action.kind)
      : undefined;
    if (freshRow && freshAction && sameActionRowState(action.row, freshRow)) {
      setAction(freshAction);
      return;
    }
    setAction(freshAction);
    setDraft(draftFor(freshAction, chain));
    setResults([]);
    setResultTitle(null);
    setStep(freshAction ? actionStep(freshAction) : 'view');
  }, [action, chain, step]);

  const validation = useMemo(
    () => validateDraft(action, draft, chain, bot, budget, holidays),
    [action, bot, budget, chain, draft, holidays],
  );
  const heldReason = writesHeldReason ?? action?.disabledReason ?? null;
  const blockedReason = heldReason ?? validation.error;

  const chooseAction = (next: OrderDialogAction) => {
    setAction(next);
    setDraft(draftFor(next, chain));
    setStep(actionStep(next));
  };

  const finishWithError = (label: string, error: unknown) => {
    const apiError = asBistApiError(error);
    if (apiError.queued) {
      setResultTitle('Queued for replay');
      setResults([queuedResult('request', label, apiError)]);
      setStep('result');
      return;
    }
    const unknown =
      apiError.mayHaveReachedExchange ||
      apiError.kind === 'unknown' ||
      apiError.kind === 'protocol';
    setResultTitle(unknown ? 'Outcome unknown' : 'Request refused');
    setResults([
      {
        id: 'request',
        label,
        tone: unknown ? 'unknown' : 'refused',
        detail: unknown
          ? `${apiError.message} Whether it reached the exchange cannot be known; do not send it again.`
          : `${apiError.message} This viewer did not retry the call.`,
      },
    ]);
    setStep('result');
  };

  const submit = async () => {
    if (!action || blockedReason || writesHeldRef.current) return;
    setStep('sending');
    try {
      if (action.kind === 'cancel') {
        if (action.row.source === 'scheduled') {
          let freshScheduled: ActiveOrder | undefined;
          try {
            const freshRows = await bistApi.getActiveOrders(chain.botId);
            const freshRow = freshRows.find(
              (row) => row.clientOrderId === action.row.raw.clientOrderId,
            );
            freshScheduled = freshRow?.status === 'Scheduled' ? freshRow : undefined;
            if (!freshScheduled) {
              setResultTitle('Schedule changed');
              setResults([
                {
                  id: action.row.key,
                  label: `Remove scheduled ${action.row.direction} ${action.row.symbol}`,
                  tone: 'not-sent',
                  detail: freshRow
                    ? 'A fresh snapshot shows this row is no longer scheduled. CancelOrders was not called.'
                    : 'A fresh snapshot no longer contains this scheduled row. CancelOrders was not called.',
                },
              ]);
              setStep('result');
              return;
            }
          } catch (error) {
            const apiError = asBistApiError(error);
            setResultTitle('Schedule not canceled');
            setResults([
              {
                id: action.row.key,
                label: `Remove scheduled ${action.row.direction} ${action.row.symbol}`,
                tone: 'not-sent',
                detail: `${apiError.message} The fresh safety read failed, so CancelOrders was not called.`,
              },
            ]);
            setStep('result');
            return;
          }

          if (writesHeldRef.current) {
            setResultTitle('Schedule not canceled');
            setResults([
              {
                id: action.row.key,
                label: `Remove scheduled ${action.row.direction} ${action.row.symbol}`,
                tone: 'not-sent',
                detail: `${writesHeldRef.current} The stream changed during the safety read, so CancelOrders was not called.`,
              },
            ]);
            setStep('result');
            return;
          }

          await bistApi.cancelOrders(chain.botId, [freshScheduled.clientOrderId]);
          invalidateBotBudget(queryClient, chain.botId);
          const confirmation = await confirmScheduledRemoval(
            chain.botId,
            freshScheduled.clientOrderId,
          );
          if (confirmation.kind === 'removed') {
            recordConfirmedScheduleRemoval(queryClient, confirmation.row);
            setResultTitle('Schedule removed');
            setResults([
              {
                id: action.row.key,
                label: `Remove scheduled ${action.row.direction} ${action.row.symbol}`,
                tone: 'landed',
                word: 'Removed',
                detail:
                  'A fresh canceled-row read confirms it was removed before reaching the exchange.',
              },
            ]);
          } else if (confirmation.kind === 'active') {
            setResultTitle('Cancel accepted');
            setResults([
              {
                id: action.row.key,
                label: `Cancel ${action.row.direction} ${action.row.symbol}`,
                tone: 'accepted',
                detail:
                  'The row fired before cancellation completed. The cancel was accepted against the live order, which remains until a refresh confirms its terminal state.',
              },
            ]);
          } else if (confirmation.kind === 'unsafe-canceled') {
            recordCanceledOrder(queryClient, confirmation.row);
            setResultTitle('Pre-exchange removal unproven');
            setResults([
              {
                id: action.row.key,
                label: `Cancel ${action.row.direction} ${action.row.symbol}`,
                tone: 'unknown',
                word: 'Not proved',
                detail:
                  'The canceled record does not prove this row stayed off the exchange. Any fill exposure must be read from the refreshed position.',
              },
            ]);
          } else {
            setResultTitle('Removal unconfirmed');
            setResults([
              {
                id: action.row.key,
                label: `Remove scheduled ${action.row.direction} ${action.row.symbol}`,
                tone: 'accepted',
                detail:
                  'CancelOrders returned, but the fresh reads could not prove a pre-exchange removal. Do not submit the cancellation again.',
              },
            ]);
          }
          setStep('result');
          return;
        }

        await bistApi.cancelOrders(chain.botId, [action.row.raw.clientOrderId]);
        invalidateBotBudget(queryClient, chain.botId);
        markCancelInFlight(queryClient, action.row.raw.clientOrderId);
        setResults([
          {
            id: action.row.key,
            label: `Cancel ${action.row.direction} ${action.row.symbol}`,
            tone: 'accepted',
            detail:
              'The request was accepted. The live row remains until a refresh confirms it is gone.',
          },
        ]);
        setResultTitle('Cancel accepted');
        setStep('result');
        return;
      }

      if (action.kind === 'fire') {
        await fireScheduled(
          action,
          chain,
          queryClient,
          setResults,
          setResultTitle,
          () => writesHeldRef.current,
        );
        setStep('result');
        return;
      }

      if (action.kind === 'edit') {
        const request = buildEditRequest(action, draft, chain);
        await bistApi.editOrders(request);
        invalidateBotBudget(queryClient, chain.botId);
        const scheduledEdit = action.row.source === 'scheduled';
        setResults([
          {
            id: action.row.key,
            label: `Edit ${action.row.direction} ${action.row.symbol}`,
            tone: scheduledEdit ? 'landed' : 'accepted',
            detail: scheduledEdit
              ? 'The server confirmed the local scheduled row was updated.'
              : 'The server accepted the exchange edit. The live row remains at its previous confirmed values until a refresh reports the result.',
          },
        ]);
        setResultTitle(scheduledEdit ? 'Schedule updated' : 'Edit accepted');
        setStep('result');
        return;
      }

      const request = buildSendRequest(action, draft, chain);
      const response = await bistApi.sendOrders(request);
      invalidateBotBudget(queryClient, chain.botId);
      const sent = response.toOrder.find((row) => row.symbol === action.row.symbol);
      const skipped = response.skippedList.find((row) => row.symbol === action.row.symbol);
      const label =
        action.kind === 'sell' ? `Sell ${action.row.symbol}` : `Resend ${action.row.symbol}`;
      if (sent) {
        setResults([
          {
            id: action.row.key,
            label,
            tone: 'landed',
            detail:
              action.kind === 'resend'
                ? 'A fresh order was created with its own client id and its own chain. The canceled chain stays closed.'
                : `A fresh sell for ${formatQuantity(sent.quantity ?? validation.quantity ?? 0)} shares was created as a new chain.`,
          },
        ]);
        setResultTitle(action.kind === 'sell' ? 'Sell created' : 'Fresh order created');
      } else if (skipped) {
        setResults([
          {
            id: action.row.key,
            label,
            tone: 'refused',
            detail:
              skipped.reason ??
              'The server guard refused this symbol before confirming a new order.',
          },
        ]);
        setResultTitle('Order not created');
      } else {
        setResults([
          {
            id: action.row.key,
            label,
            tone: 'unknown',
            detail:
              'The successful reply named this symbol in neither the created nor skipped list. Its outcome is unknown; do not send it again.',
          },
        ]);
        setResultTitle('Outcome unknown');
      }
      setStep('result');
    } catch (error) {
      finishWithError(actionLabel(action), error);
    }
  };

  const title = dialogTitle(chain, action, step);
  const header = step === 'view' ? chainHeader(chain, marketPrice) : null;

  return (
    <Modal
      open={open}
      title={step === 'view' ? chain.symbol : title}
      titleKicker={header?.kicker}
      subtitle={header?.subtitle}
      aside={header?.aside}
      onClose={onClose}
      closeBlocked={step === 'sending'}
    >
      {step === 'view' ? (
        <ChainView
          chain={chain}
          onAction={chooseAction}
          writesHeldReason={writesHeldReason}
          onClose={onClose}
        />
      ) : null}
      {step === 'form' && action && action.kind !== 'cancel' && action.kind !== 'fire' ? (
        <ActionForm
          action={action}
          chain={chain}
          draft={draft}
          setDraft={setDraft}
          validation={validation}
          blockedReason={blockedReason}
          onClose={onClose}
          onSubmit={() => void submit()}
        />
      ) : null}
      {step === 'confirm' && action && (action.kind === 'cancel' || action.kind === 'fire') ? (
        <ActionConfirm
          action={action}
          chain={chain}
          blockedReason={blockedReason}
          onClose={onClose}
          onSubmit={() => void submit()}
        />
      ) : null}
      {step === 'sending' && action ? <SendingState action={action} /> : null}
      {step === 'result' ? (
        <>
          {resultTitle ? <h3 className="result-title">{resultTitle}</h3> : null}
          <ResultList results={results} />
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

/**
 * The header states what the chain is and what it made. A chain that never
 * traded says so rather than showing a zero (TOKENS 3: an absence is not a
 * measurement).
 */
function chainHeader(chain: BookChain, marketPrice: number | null) {
  const figure = chainFigure(chain, marketPrice);
  const orderCount = chain.rows.length + chain.canceledRows.length;
  return {
    kicker: `chain · ${plural(orderCount, 'order')}`,
    subtitle: [
      chain.chainId ? `chain …${chain.chainId.slice(-6)}` : 'chain link unknown',
      chain.batchDate === null ? 'batch date unknown' : `batch ${formatDateKey(chain.batchDate)}`,
      chain.botId,
    ].join(' · '),
    aside: (
      <>
        <strong className={figure.tone}>{figure.value}</strong>
        <small className={figure.tone}>{figure.detail}</small>
      </>
    ),
  };
}

function chainFigure(
  chain: BookChain,
  marketPrice: number | null,
): { value: string; detail: string; tone: string } {
  const state = deriveFilledPnlState(
    chain.sources.positions,
    chain.sources.activeOrders,
    chain.sources.closedTrades,
  );
  const realized =
    chain.sources.closedTrades.reduce(
      (sum, trade) =>
        sum + realizedPnl(trade.quantity, trade.averageOpenPrice, trade.averageClosePrice),
      0,
    ) +
    state.partialSellFills.reduce(
      (sum, fill) =>
        sum + realizedPnl(fill.quantity, fill.averageOpenPrice, fill.averageClosePrice),
      0,
    );
  const costBasis =
    chain.sources.closedTrades.reduce(
      (sum, trade) => sum + trade.quantity * trade.averageOpenPrice,
      0,
    ) +
    state.partialSellFills.reduce((sum, fill) => sum + fill.quantity * fill.averageOpenPrice, 0) +
    state.exposures.reduce((sum, exposure) => sum + exposure.quantity * exposure.averagePrice, 0);
  const traded = chain.sources.closedTrades.length > 0 || state.partialSellFills.length > 0;
  if (state.exposures.length === 0 && !traded) {
    return { value: '—', detail: 'waiting · nothing bought yet', tone: 'muted' };
  }
  if (state.exposures.length > 0 && marketPrice === null) {
    return { value: 'not available', detail: 'no price we will stand behind', tone: 'status-warn' };
  }
  const unrealized = state.exposures.reduce(
    (sum, exposure) => sum + unrealizedPnl(exposure, marketPrice ?? 0),
    0,
  );
  const total = realized + unrealized;
  const percent = pnlPercentage(total, costBasis);
  return {
    value: formatSignedNumber(total),
    detail: percent === null ? '' : formatPercentage(percent),
    tone: total >= 0 ? 'number-positive' : 'number-negative',
  };
}

function ChainView({
  chain,
  onAction,
  writesHeldReason,
  onClose,
}: {
  chain: BookChain;
  onAction: (action: OrderDialogAction) => void;
  writesHeldReason: string | null;
  onClose: () => void;
}) {
  const rows = [...chain.rows, ...chain.canceledRows.filter((row) => !chain.rows.includes(row))];
  const opener = rows[0];
  const legs = opener ? rows.slice(1) : rows;
  const sellAction = chain.positionRows
    .flatMap((row) => orderActionsForRow(row, chain))
    .find((candidate) => candidate.kind === 'sell');
  const anyGuards = rows.some((row) => guardsFor(row).any);
  return (
    <div className="chain-dialog-view">
      {opener ? (
        <ChainOpener
          row={opener}
          chain={chain}
          onAction={onAction}
          writesHeldReason={writesHeldReason}
        />
      ) : null}
      <div className="chain-dialog-legs">
        {legs.map((row) => {
          const actions = orderActionsForRow(row, chain);
          const presentation = bookRowPresentation(row, chain);
          return (
            <div className={`chain-dialog-row ${statusClass(presentation.role)}`} key={row.key}>
              <span className="chain-dialog-status">{presentation.label}</span>
              <span className="chain-dialog-terms">{legTerms(row)}</span>
              {presentation.detail ? (
                <span className="chain-dialog-note">{presentation.detail}</span>
              ) : null}
              <span className="chain-dialog-actions">
                {actions.map((action) => (
                  <button
                    type="button"
                    className={`btn btn-ghost${action.kind === 'fire' ? ' fire-action' : ''}`}
                    disabled={Boolean(writesHeldReason) || action.disabled}
                    title={writesHeldReason ?? action.disabledReason}
                    onClick={() => onAction(action)}
                    key={action.kind}
                  >
                    {action.kind === 'fire' ? 'fire now' : action.kind}
                  </button>
                ))}
              </span>
              <RowGuards row={row} />
            </div>
          );
        })}
      </div>
      {chain.positionQuantity ? (
        <p className="dialog-note">
          {chain.sellableQuantity === 0 ? (
            <>
              All {formatQuantity(chain.positionQuantity)} held shares are claimed by active or
              scheduled sells. Edit one of those orders to free shares.
            </>
          ) : (
            <>
              Sellable by hand:{' '}
              <span className="book-inline-value">
                {formatQuantity(chain.sellableQuantity ?? 0)} of{' '}
                {formatQuantity(chain.positionQuantity)}
              </span>
              {sellClaims(chain) ? ` — ${sellClaims(chain)}` : ''}. A scheduled sell dated today can
              also fire before its time, on its own, if the stock closes a minute at the daily
              ceiling.{' '}
              <span className="status-wait">
                A sell with a cancel in flight still claims its shares
              </span>{' '}
              — the count only grows once the cancel is confirmed, never when it is asked.
            </>
          )}
        </p>
      ) : null}
      {anyGuards ? (
        <p className="dialog-note">
          Only the rules these orders carry are shown. The server may add narrower ones of its own —
          the tighter of the two always wins.
        </p>
      ) : null}
      {writesHeldReason ? (
        <p className="form-block-reason status-dead">{writesHeldReason}</p>
      ) : null}
      <div className="dialog-actions">
        <button type="button" className="btn btn-secondary" onClick={onClose}>
          Close
        </button>
        {sellAction && !writesHeldReason ? (
          <button type="button" className="btn btn-primary" onClick={() => onAction(sellAction)}>
            Sell the remaining {formatQuantity(chain.sellableQuantity ?? 0)}
          </button>
        ) : null}
      </div>
    </div>
  );
}

/**
 * Names each order that claims shares, and how many: the arithmetic behind
 * the sellable count is the fact the user needs, not the count alone.
 */
function sellClaims(chain: BookChain): string {
  const claims = chain.activeRows
    .filter((row) => row.direction === 'sell' && row.isWaiting)
    .map((row) => {
      const kind = row.source === 'scheduled' ? 'scheduled' : 'resting';
      const type = row.orderType ? `${row.orderType} ` : '';
      return row.quantity === null
        ? `the ${kind} ${type}sell claims the whole position`
        : `the ${kind} ${type}sell claims ${formatQuantity(row.quantity)}`;
    });
  return claims.join(', ');
}

/** `sell 60 limit 39,90` — the terms, in the order the sentence reads. */
function legTerms(row: BookChain['rows'][number]): string {
  const quantity = row.quantity === null ? 'auto' : formatQuantity(row.quantity);
  const price = row.orderPrice === null ? '' : ` ${formatNumber(row.orderPrice)}`;
  return `${row.direction} ${quantity}${row.orderType ? ` ${row.orderType}` : ''}${price}`;
}

/** The opener carries the chain's own numbers, in a block of its own. */
function ChainOpener({
  row,
  chain,
  onAction,
  writesHeldReason,
}: {
  row: BookChain['rows'][number];
  chain: BookChain;
  onAction: (action: OrderDialogAction) => void;
  writesHeldReason: string | null;
}) {
  const actions = orderActionsForRow(row, chain);
  const presentation = bookRowPresentation(row, chain, Date.now(), true);
  const slip =
    row.averagePrice === null
      ? null
      : slippagePercentage({
          orderPrice: row.orderPrice,
          averagePrice: row.averagePrice,
          type: row.orderType,
        });
  const stats: Array<{ label: string; value: string; muted?: boolean }> = [
    { label: 'qty', value: row.quantity === null ? 'auto' : formatQuantity(row.quantity) },
    {
      label: row.orderType === 'limit' ? 'limit' : 'order',
      value: row.orderPrice === null ? '' : formatNumber(row.orderPrice),
    },
  ];
  if (row.averagePrice === null) {
    stats.push({
      label: 'filled',
      value: formatQuantity(Math.max(0, row.filledQuantity ?? 0)),
      muted: (row.filledQuantity ?? 0) === 0,
    });
  } else {
    stats.push({ label: 'avg fill', value: formatNumber(row.averagePrice) });
  }
  if (slip !== null) stats.push({ label: 'slip', value: formatPercentage(slip) });
  return (
    <div className={`chain-dialog-opener ${statusClass(presentation.role)}`}>
      <div className="chain-dialog-opener-head">
        <span className="kicker">opener · {openerWord(row)}</span>
        <span className="muted">
          {row.clientOrderId ? `…${row.clientOrderId.slice(-6)}` : 'no client id'}
        </span>
      </div>
      <div className="chain-dialog-opener-stats">
        {stats.map((stat) => (
          <div key={stat.label}>
            <span className="kicker">{stat.label}</span>
            <strong className={stat.muted ? 'muted' : ''}>{stat.value}</strong>
          </div>
        ))}
      </div>
      <RowGuards row={row} />
      {/* The opener keeps its status sentence and its own actions: the kicker
          names the kind of row, not what is happening to it right now, and an
          opener is often the only leg a chain has. */}
      <div className="chain-dialog-opener-note">
        <span>
          {presentation.label}
          {presentation.detail ? <span className="muted"> · {presentation.detail}</span> : null}
        </span>
        <span className="chain-dialog-actions">
          {actions.map((action) => (
            <button
              type="button"
              className={`btn btn-ghost${action.kind === 'fire' ? ' fire-action' : ''}`}
              disabled={Boolean(writesHeldReason) || action.disabled}
              title={writesHeldReason ?? action.disabledReason}
              onClick={() => onAction(action)}
              key={action.kind}
            >
              {action.kind === 'fire' ? 'fire now' : action.kind}
            </button>
          ))}
        </span>
      </div>
      {presentation.notes?.map((note) => (
        <div
          className={`chain-dialog-opener-note ${note.tone === 'wait' ? 'status-wait' : 'muted'}`}
          key={note.text}
        >
          {note.text}
        </div>
      ))}
    </div>
  );
}

interface RowGuardLines {
  entry: string[];
  exit: string[];
  unreadable: boolean;
  any: boolean;
}

/**
 * What this row will do on its own. Only what the order itself carries is
 * read: the server adds guards of its own that are never written down here,
 * so the block states a floor, never a complete account — which is why the
 * standing note beneath the chain says so out loud.
 */
function guardsFor(row: BookChain['rows'][number]): RowGuardLines {
  const raw = rowRules(row);
  const entry = describeOpenPrice(parseOpenPrice(raw.open));
  const exit = describeClosePrice(parseClosePrice(raw.close));
  const unreadable =
    readOpenPrice(raw.open).kind === 'unreadable' ||
    readClosePrice(raw.close).kind === 'unreadable';
  return { entry, exit, unreadable, any: entry.length > 0 || exit.length > 0 || unreadable };
}

function RowGuards({ row }: { row: BookChain['rows'][number] }) {
  const guards = guardsFor(row);
  if (!guards.any) return null;
  return (
    <dl className="chain-dialog-guards">
      <dt className="kicker">guards</dt>
      {guards.entry.length > 0 ? <dd>entry · {guards.entry.join(' · ')}</dd> : null}
      {guards.exit.length > 0 ? <dd>exit · {guards.exit.join(' · ')}</dd> : null}
      {guards.unreadable ? (
        <dd className="status-warn">
          This row carries a price rule in a form this viewer cannot read.
        </dd>
      ) : null}
    </dl>
  );
}

function openerWord(row: BookChain['rows'][number]): string {
  if (row.source === 'position') return `filled ${row.direction}`;
  if (row.source === 'closed-trade') return 'closed round trip';
  if (row.source === 'canceled') return `canceled ${row.direction}`;
  if (row.source === 'scheduled') return `scheduled ${row.direction}`;
  return `resting ${row.direction}`;
}

function ActionForm({
  action,
  chain,
  draft,
  setDraft,
  validation,
  blockedReason,
  onClose,
  onSubmit,
}: {
  action: Exclude<OrderDialogAction, { kind: 'cancel' | 'fire' }>;
  chain: BookChain;
  draft: Draft;
  setDraft: (draft: Draft) => void;
  validation: Validation;
  blockedReason: string | null;
  onClose: () => void;
  onSubmit: () => void;
}) {
  const isResend = action.kind === 'resend';
  const direction = actionDirection(action);
  const sameModeUnavailable =
    action.kind === 'resend' ? resendSameUnavailableReason(action, chain) : null;
  const linkedClose =
    action.kind === 'resend' && action.row.direction === 'buy'
      ? linkedReversingSell(action.row, chain)
      : undefined;
  const canBlankQuantity =
    (isResend && action.row.direction === 'buy' && draft.resendMode === 'change') ||
    (action.kind === 'edit' &&
      action.row.source === 'scheduled' &&
      action.row.direction === 'sell');
  const scheduledEdit = action.kind === 'edit' && action.row.source === 'scheduled';
  return (
    <div>
      <p className="dialog-context">
        {direction} {action.row.symbol} ·{' '}
        {action.row.clientOrderId ? `…${action.row.clientOrderId.slice(-8)}` : 'fresh order'}
      </p>
      {isResend ? (
        <>
          <div className="stored-spec">
            <span className="kicker">stored canceled order</span>
            <strong>
              {formatQuantity(action.row.quantity ?? 0)} shares ·{' '}
              {action.row.orderType ?? action.row.intentType} ·{' '}
              {action.row.orderPrice === null
                ? 'no stored price'
                : formatNumber(action.row.orderPrice)}
            </strong>
            <span className="muted">
              {action.row.raw.matriksOrderId
                ? 'The stored order had already been sent; using these stored fields sends the fresh order now.'
                : 'The canceled-order read does not preserve the original fire-time spec.'}
              {linkedClose
                ? ' A linked reversing sell existed, but its reusable closeTime is not preserved.'
                : ''}
            </span>
          </div>
          <div className="seg form-mode" aria-label="Resend mode">
            <label className="seg-opt">
              <input
                type="radio"
                name="resend-mode"
                disabled={Boolean(sameModeUnavailable)}
                checked={draft.resendMode === 'same'}
                onChange={() => setDraft({ ...draft, resendMode: 'same', scheduled: false })}
              />
              <span>Resend as it was</span>
            </label>
            <label className="seg-opt">
              <input
                type="radio"
                name="resend-mode"
                checked={draft.resendMode === 'change'}
                onChange={() => setDraft({ ...draft, resendMode: 'change' })}
              />
              <span>Change it first</span>
            </label>
          </div>
          {sameModeUnavailable ? (
            <p className="form-block-reason">
              {sameModeUnavailable} Use “Change it first” and choose the replacement timing
              explicitly.
            </p>
          ) : null}
        </>
      ) : null}
      <fieldset className="form-fields" disabled={isResend && draft.resendMode === 'same'}>
        <label className="field">
          <span>Type</span>
          <select
            className="input"
            value={draft.type}
            onChange={(event) => setDraft({ ...draft, type: event.target.value as OrderType })}
          >
            <option value="limit">limit</option>
            <option value="market">market</option>
          </select>
        </label>
        <label className="field">
          <span>Price{draft.type === 'market' && direction === 'sell' ? ' (optional)' : ''}</span>
          <input
            className="input"
            inputMode="decimal"
            value={draft.price}
            onChange={(event) => setDraft({ ...draft, price: event.target.value })}
          />
        </label>
        <label className="field">
          <span>Quantity{canBlankQuantity ? ' (optional)' : ''}</span>
          <input
            className="input"
            inputMode="numeric"
            value={draft.quantity}
            onChange={(event) => setDraft({ ...draft, quantity: event.target.value })}
          />
        </label>
      </fieldset>
      {action.kind === 'edit' &&
      action.row.source === 'scheduled' &&
      action.row.direction === 'sell' ? (
        <p className="dialog-note">
          Leave quantity blank to keep “sell whatever the position holds at fire.” That schedule
          continues to claim the whole position.
        </p>
      ) : null}
      {action.kind !== 'edit' && !(isResend && draft.resendMode === 'same') ? (
        <div className="seg form-mode" aria-label="Send timing">
          <label className="seg-opt">
            <input
              type="radio"
              name="timing"
              checked={!draft.scheduled}
              onChange={() => setDraft({ ...draft, scheduled: false })}
            />
            <span>Send now</span>
          </label>
          <label className="seg-opt">
            <input
              type="radio"
              name="timing"
              checked={draft.scheduled}
              onChange={() => setDraft({ ...draft, scheduled: true })}
            />
            <span>Schedule it</span>
          </label>
        </div>
      ) : null}
      {scheduledEdit ? (
        <label className="check-field">
          <input
            type="checkbox"
            checked={draft.changeSchedule}
            onChange={(event) => setDraft({ ...draft, changeSchedule: event.target.checked })}
          />
          Change the current resolved fire time
          {action.row.scheduledTime
            ? ` (${new Date(action.row.scheduledTime).toLocaleString('tr-TR', { timeZone: 'Europe/Istanbul' })})`
            : ''}
        </label>
      ) : null}
      {(draft.scheduled && !scheduledEdit) || (scheduledEdit && draft.changeSchedule) ? (
        <ScheduleFields draft={draft} setDraft={setDraft} />
      ) : null}
      {(scheduledEdit && action.row.direction === 'buy') ||
      (isResend &&
        action.row.direction === 'buy' &&
        draft.resendMode === 'change' &&
        draft.scheduled) ? (
        <label className="check-field">
          <input
            type="checkbox"
            checked={draft.cancelAtFloor}
            onChange={(event) => setDraft({ ...draft, cancelAtFloor: event.target.checked })}
          />
          cancelAtFloor — drop this buy if it fires at the daily floor
        </label>
      ) : null}
      {isResend && action.row.direction === 'buy' && draft.resendMode === 'change' ? (
        <label className="check-field">
          <input
            type="checkbox"
            checked={draft.keepClose}
            onChange={(event) => setDraft({ ...draft, keepClose: event.target.checked })}
          />
          Create a linked reversing sell at BeforeClose −30m
        </label>
      ) : null}
      {direction === 'buy' ? (
        <GuardFields
          draft={draft}
          setDraft={setDraft}
          stored={storedRulesFor(action)}
          disabled={isResend && draft.resendMode === 'same'}
        />
      ) : null}
      <p className="bounding-copy">{validation.boundCopy}</p>
      {isResend ? (
        <p className="dialog-note">
          This creates a new client id and a new chain. It does not revive or attach to the canceled
          one.
        </p>
      ) : null}
      {blockedReason ? <p className="form-block-reason">{blockedReason}</p> : null}
      <div className="dialog-actions">
        <button type="button" className="btn btn-secondary" onClick={onClose}>
          Close
        </button>
        <button
          type="button"
          className="btn btn-primary"
          disabled={Boolean(blockedReason)}
          onClick={onSubmit}
        >
          {action.kind === 'edit' ? 'Save' : action.kind}
        </button>
      </div>
    </div>
  );
}

const BASE_OPTIONS: ReadonlyArray<{ value: PriceBase; label: string }> = [
  { value: 'actualPrice', label: 'the average fill' },
  { value: 'orderPrice', label: 'the order price' },
  { value: 'previousClose', label: 'the previous close' },
];

/**
 * The two rules a buy can carry. They are percentages against a base, never
 * lira, and they are the only fields on this form the server acts on by itself
 * — a band can pull a resting buy off the exchange and an exit can sell the
 * position out — so each group states what it will do, not only what it is.
 */
function GuardFields({
  draft,
  setDraft,
  stored,
  disabled,
}: {
  draft: Draft;
  setDraft: (draft: Draft) => void;
  stored: StoredRules;
  disabled: boolean;
}) {
  const open = draft.openPrice;
  const close = draft.closePrice;
  const setOpen = (value: OpenPriceDraft) =>
    setDraft({ ...draft, openPrice: { state: 'edit', value } });
  const setClose = (value: ClosePriceDraft) =>
    setDraft({ ...draft, closePrice: { state: 'edit', value } });
  return (
    <>
      {stored.unreadable ? (
        <p className="dialog-note status-warn">
          This order carries a price rule in a form this viewer cannot read. Leaving these fields
          alone keeps it as it is; anything entered here replaces it.
        </p>
      ) : null}
      <fieldset className="guard-fields" disabled={disabled}>
        <legend className="kicker">
          entry band
          {stored.open !== null && open.state === 'edit' ? (
            <button
              type="button"
              className="btn btn-ghost"
              aria-label="remove the entry band"
              onClick={() => setDraft({ ...draft, openPrice: { state: 'cleared' } })}
            >
              remove
            </button>
          ) : null}
        </legend>
        {open.state === 'cleared' ? (
          <p className="guard-cleared">
            The entry band will be cleared.{' '}
            <button
              type="button"
              className="btn btn-ghost"
              aria-label="keep the entry band"
              onClick={() =>
                setDraft({
                  ...draft,
                  openPrice: { state: 'edit', value: openPriceDraftFrom(stored.open) },
                })
              }
            >
              undo
            </button>
          </p>
        ) : (
          <>
            <label className="field">
              <span>Buy at or below (%)</span>
              <input
                className="input"
                inputMode="decimal"
                value={open.value.upperLimit}
                onChange={(event) => setOpen({ ...open.value, upperLimit: event.target.value })}
              />
            </label>
            <label className="field">
              <span>Buy at or above (%)</span>
              <input
                className="input"
                inputMode="decimal"
                value={open.value.lowerLimit}
                onChange={(event) => setOpen({ ...open.value, lowerLimit: event.target.value })}
              />
            </label>
            <label className="field">
              <span>Without a price at fire</span>
              <select
                className="input"
                value={open.value.feedDown}
                onChange={(event) =>
                  setOpen({
                    ...open.value,
                    feedDown: event.target.value as OpenPriceDraft['feedDown'],
                  })
                }
              >
                <option value="buy">send it unguarded</option>
                <option value="cancel">drop it</option>
                <option value="wait">wait for one</option>
              </select>
            </label>
            {open.value.feedDown === 'wait' ? (
              <label className="field">
                <span>Wait (minutes)</span>
                <input
                  className="input"
                  inputMode="numeric"
                  value={open.value.waitMinutes}
                  onChange={(event) => setOpen({ ...open.value, waitMinutes: event.target.value })}
                />
              </label>
            ) : null}
            <p className="guard-note">
              Both limits are percentages of the previous close, between −10 and 10. A band keeps
              guarding this buy after it rests, so the server can pull it off the exchange on its
              own.
            </p>
          </>
        )}
      </fieldset>
      <fieldset className="guard-fields" disabled={disabled}>
        <legend className="kicker">
          exit targets
          {stored.close !== null && close.state === 'edit' ? (
            <button
              type="button"
              className="btn btn-ghost"
              aria-label="remove the exit targets"
              onClick={() => setDraft({ ...draft, closePrice: { state: 'cleared' } })}
            >
              remove
            </button>
          ) : null}
        </legend>
        {close.state === 'cleared' ? (
          <p className="guard-cleared">
            The exit targets will be cleared.{' '}
            <button
              type="button"
              className="btn btn-ghost"
              aria-label="keep the exit targets"
              onClick={() =>
                setDraft({
                  ...draft,
                  closePrice: { state: 'edit', value: closePriceDraftFrom(stored.close) },
                })
              }
            >
              undo
            </button>
          </p>
        ) : (
          <>
            <label className="field">
              <span>Take profit (%)</span>
              <input
                className="input"
                inputMode="decimal"
                value={close.value.takeProfitLimit}
                onChange={(event) =>
                  setClose({ ...close.value, takeProfitLimit: event.target.value })
                }
              />
            </label>
            <label className="field">
              <span>Take profit of</span>
              <select
                className="input"
                value={close.value.takeProfitBase}
                onChange={(event) =>
                  setClose({ ...close.value, takeProfitBase: event.target.value as PriceBase })
                }
              >
                {BASE_OPTIONS.map((option) => (
                  <option value={option.value} key={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>Stop loss (%)</span>
              <input
                className="input"
                inputMode="decimal"
                value={close.value.stopLossLimit}
                onChange={(event) =>
                  setClose({ ...close.value, stopLossLimit: event.target.value })
                }
              />
            </label>
            <label className="field">
              <span>Stop loss of</span>
              <select
                className="input"
                value={close.value.stopLossBase}
                onChange={(event) =>
                  setClose({ ...close.value, stopLossBase: event.target.value as PriceBase })
                }
              >
                {BASE_OPTIONS.map((option) => (
                  <option value={option.value} key={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
            <p className="guard-note">
              A reached target cancels this position&rsquo;s scheduled sells and sells the whole
              position at market. A stop loss is best-effort: an exit that cannot see the price does
              nothing at all.
            </p>
          </>
        )}
      </fieldset>
    </>
  );
}

function ScheduleFields({ draft, setDraft }: { draft: Draft; setDraft: (draft: Draft) => void }) {
  const needsDiff = draft.scheduleType === 'AfterOpen' || draft.scheduleType === 'BeforeClose';
  return (
    <fieldset className="schedule-fields">
      <legend className="kicker">fire time</legend>
      <label className="field">
        <span>Day</span>
        <input
          className="input"
          type="date"
          value={draft.day}
          onChange={(event) => setDraft({ ...draft, day: event.target.value })}
        />
      </label>
      <label className="field">
        <span>Moment</span>
        <select
          className="input"
          value={draft.scheduleType}
          onChange={(event) =>
            setDraft({ ...draft, scheduleType: event.target.value as ScheduleType })
          }
        >
          <option value="OpeningAuction">Opening auction</option>
          <option value="AtOpen">At open</option>
          <option value="AfterOpen">After open</option>
          <option value="BeforeClose">Before close</option>
          <option value="ClosingAuction">Closing auction</option>
        </select>
      </label>
      {needsDiff ? (
        <label className="field">
          <span>Difference (minutes)</span>
          <input
            className="input"
            inputMode="decimal"
            value={draft.diff}
            onChange={(event) => setDraft({ ...draft, diff: event.target.value })}
          />
        </label>
      ) : null}
    </fieldset>
  );
}

function ActionConfirm({
  action,
  chain,
  blockedReason,
  onClose,
  onSubmit,
}: {
  action: Extract<OrderDialogAction, { kind: 'cancel' | 'fire' }>;
  chain: BookChain;
  blockedReason: string | null;
  onClose: () => void;
  onSubmit: () => void;
}) {
  const linkedSell =
    action.row.direction === 'buy' && action.row.source === 'scheduled'
      ? chain.activeRows.find(
          (row) => row.parentClientOrderId === action.row.clientOrderId && row.direction === 'sell',
        )
      : undefined;
  const rowGuards = guardsFor(action.row);
  const firedGuards =
    action.kind === 'fire' && action.row.direction === 'buy'
      ? [...rowGuards.entry, ...rowGuards.exit]
      : [];
  return (
    <div>
      <p className="dialog-context">
        {action.row.direction} {action.row.symbol} ·{' '}
        {action.row.quantity === null
          ? 'quantity resolves from the position at fire'
          : plural(action.row.quantity, 'share')}
      </p>
      {action.kind === 'fire' ? <EarlyByLine scheduledTime={action.row.scheduledTime} /> : null}
      <ol className="confirm-calls">
        <li>
          <strong>1 · CancelOrders</strong>
          <span>
            {action.kind === 'fire'
              ? 'Remove the scheduled row before creating anything new.'
              : action.row.source === 'scheduled'
                ? 'Remove the server-held schedule; nothing has reached the exchange.'
                : 'Ask to cancel the live exchange order. An empty reply confirms only that the request was accepted.'}
          </span>
        </li>
        {action.kind === 'fire' ? (
          <li>
            <strong>2 · SendOrders</strong>
            <span>
              Only after the scheduled cancel lands, create the same {action.row.direction}{' '}
              immediately. Quantity and price resolve now; the new order gets its own id and chain.
            </span>
            {firedGuards.length > 0 ? (
              <span className="muted">
                It goes out as guarded as it stands: {firedGuards.join(' · ')}.
              </span>
            ) : null}
          </li>
        ) : null}
      </ol>
      {linkedSell ? (
        <p className="form-block-reason">
          Canceling this scheduled buy also cancels its linked reversing sell …
          {linkedSell.clientOrderId?.slice(-8)}.
        </p>
      ) : null}
      {blockedReason ? <p className="form-block-reason">{blockedReason}</p> : null}
      <div className="dialog-actions">
        <button type="button" className="btn btn-secondary" onClick={onClose}>
          Close
        </button>
        <button
          type="button"
          className="btn btn-primary"
          disabled={Boolean(blockedReason)}
          onClick={onSubmit}
        >
          {action.kind === 'fire' ? 'Fire now' : 'Cancel order'}
        </button>
      </div>
    </div>
  );
}

/**
 * SPEC 4 asks the `fire now` confirm to state how early the order goes. The
 * scheduled instant alone is not that statement — the distance from now is
 * the fact that decides whether a human meant to do this.
 */
function EarlyByLine({ scheduledTime }: { scheduledTime: number | null }) {
  const now = useMinuteClock();
  if (scheduledTime === null) {
    return (
      <p className="dialog-note status-warn">
        This row carries no resolved fire time, so how early it goes cannot be stated.
      </p>
    );
  }
  const early = scheduledTime - now;
  return (
    <p className="dialog-note">
      {early <= 0
        ? `It was due at ${formatTime(scheduledTime)} and has not gone out yet.`
        : `It goes ${formatCompactDuration(early)} early — the schedule holds it until ${formatTime(
            scheduledTime,
          )}.`}
    </p>
  );
}

function SendingState({ action }: { action: OrderDialogAction }) {
  return (
    <div className="sending-panel" aria-live="polite">
      <div className="sending-previous">
        <strong>{action.row.symbol}</strong>
        <span>
          {actionDirection(action)} ·{' '}
          {action.row.quantity === null ? 'auto' : formatQuantity(action.row.quantity)} · previous
          value
        </span>
      </div>
      <div className="sending-call">
        <span className="spinner" aria-hidden="true" />
        <span>
          {action.kind === 'fire'
            ? 'CancelOrders, then SendOrders'
            : `${rpcName(action.kind)} is waiting for the server`}
        </span>
      </div>
      <p>
        The row stays at its previous value until a readable reply or stream update confirms
        something else.
      </p>
    </div>
  );
}

interface Validation {
  error: string | null;
  boundCopy: string;
  quantity: number | null;
  price: number | null;
}

function validateDraft(
  action: OrderDialogAction | undefined,
  draft: Draft,
  chain: BookChain,
  bot: Bot | undefined,
  budget: BotBudget | undefined,
  holidays: readonly Holiday[],
): Validation {
  if (!action || action.kind === 'cancel' || action.kind === 'fire')
    return { error: null, boundCopy: '', quantity: null, price: null };
  const direction = actionDirection(action);
  const price = parseTurkishNumber(draft.price);
  const quantityValue = parseTurkishNumber(draft.quantity);
  const quantity = quantityValue;
  const allowBlankQuantity =
    (action.kind === 'resend' && action.row.direction === 'buy' && draft.resendMode === 'change') ||
    (action.kind === 'edit' &&
      action.row.source === 'scheduled' &&
      action.row.direction === 'sell');
  const effectiveDraft =
    action.kind === 'resend' && draft.resendMode === 'same' ? draftFor(action, chain) : draft;
  const finalPrice =
    action.kind === 'resend' && draft.resendMode === 'same' ? action.row.orderPrice : price;
  const finalQuantity =
    action.kind === 'resend' && draft.resendMode === 'same' ? action.row.quantity : quantity;
  const priceRequired = effectiveDraft.type === 'limit' || direction === 'buy';
  if (action.kind === 'resend' && draft.resendMode === 'same') {
    const unavailableReason = resendSameUnavailableReason(action, chain);
    if (unavailableReason) {
      return {
        error: unavailableReason,
        boundCopy: boundCopy(action, chain, budget),
        quantity: finalQuantity,
        price: finalPrice,
      };
    }
  }
  if (priceRequired && (finalPrice === null || finalPrice <= 0))
    return {
      error: 'Enter a price greater than zero.',
      boundCopy: boundCopy(action, chain, budget),
      quantity: finalQuantity,
      price: finalPrice,
    };
  if (!allowBlankQuantity && (finalQuantity === null || finalQuantity <= 0))
    return {
      error: 'Enter a whole quantity greater than zero.',
      boundCopy: boundCopy(action, chain, budget),
      quantity: finalQuantity,
      price: finalPrice,
    };
  if (finalQuantity !== null && (!Number.isInteger(finalQuantity) || finalQuantity <= 0))
    return {
      error: 'Quantity must be a whole number greater than zero.',
      boundCopy: boundCopy(action, chain, budget),
      quantity: finalQuantity,
      price: finalPrice,
    };
  if (direction === 'sell') {
    const ceiling = sellCeiling(action, chain, effectiveDraft.scheduled);
    if (finalQuantity !== null && finalQuantity > ceiling)
      return {
        error: `This asks for ${formatQuantity(finalQuantity)} shares, but only ${formatQuantity(ceiling)} are unclaimed.`,
        boundCopy: boundCopy(action, chain, budget),
        quantity: finalQuantity,
        price: finalPrice,
      };
  } else {
    if (!bot?.complete)
      return {
        error: 'This buy is held because the bot configuration is incomplete.',
        boundCopy: boundCopy(action, chain, budget),
        quantity: finalQuantity,
        price: finalPrice,
      };
    if (!bot.active && action.kind !== 'edit')
      return {
        error: 'This buy is held because the bot is deactivated.',
        boundCopy: boundCopy(action, chain, budget),
        quantity: finalQuantity,
        price: finalPrice,
      };
    if (!budget)
      return {
        error: 'The bot budget is unavailable, so this buy cannot be bounded safely.',
        boundCopy: boundCopy(action, chain, budget),
        quantity: finalQuantity,
        price: finalPrice,
      };
    if (finalQuantity !== null && finalPrice !== null) {
      const ceiling = Math.min(
        budget.remainingBotBudget + ownBuyCommitment(action),
        effectivePerPositionCap(budget),
      );
      const cost = reservedBuyCost(finalQuantity, finalPrice, effectiveDraft.type);
      if (cost > ceiling)
        return {
          error: `This asks for ${formatNumber(cost)} and the effective available cap is ${formatNumber(ceiling)}.`,
          boundCopy: boundCopy(action, chain, budget),
          quantity: finalQuantity,
          price: finalPrice,
        };
    }
  }
  const scheduleChanges =
    action.kind === 'edit' && action.row.source === 'scheduled'
      ? effectiveDraft.changeSchedule
      : effectiveDraft.scheduled;
  const resolvedSchedule = scheduleChanges
    ? resolveDraftSchedule(effectiveDraft, holidays)
    : undefined;
  if (resolvedSchedule && !resolvedSchedule.ok)
    return {
      error: resolvedSchedule.error,
      boundCopy: boundCopy(action, chain, budget),
      quantity: finalQuantity,
      price: finalPrice,
    };
  const effectiveWhenType =
    action.kind === 'edit' && action.row.source === 'scheduled' && !effectiveDraft.changeSchedule
      ? action.row.raw.whenType
      : scheduleChanges
        ? effectiveDraft.scheduleType
        : null;
  if (direction === 'buy' && effectiveDraft.cancelAtFloor && effectiveWhenType === 'OpeningAuction')
    return {
      error:
        'Cancel at the daily floor cannot guard an Opening auction buy because no market price exists at 09:00.',
      boundCopy: boundCopy(action, chain, budget),
      quantity: finalQuantity,
      price: finalPrice,
    };
  if (direction === 'buy') {
    const ruleError = priceRuleError(action, effectiveDraft, effectiveWhenType);
    if (ruleError)
      return {
        error: ruleError,
        boundCopy: boundCopy(action, chain, budget),
        quantity: finalQuantity,
        price: finalPrice,
      };
  }
  if (action.kind === 'edit' && action.row.source === 'scheduled' && resolvedSchedule?.ok) {
    const orderingError = scheduledEditOrderingError(action, chain, resolvedSchedule.fireTime);
    if (orderingError)
      return {
        error: orderingError,
        boundCopy: boundCopy(action, chain, budget),
        quantity: finalQuantity,
        price: finalPrice,
      };
  }
  if (action.kind === 'resend' && action.row.direction === 'buy' && effectiveDraft.keepClose) {
    const closeDraft = {
      ...effectiveDraft,
      scheduled: true,
      scheduleType: 'BeforeClose' as const,
      diff: '30',
    };
    const resolvedClose = resolveDraftSchedule(closeDraft, holidays);
    if (!resolvedClose.ok) {
      return {
        error: `The linked reversing sell is invalid: ${resolvedClose.error}`,
        boundCopy: boundCopy(action, chain, budget),
        quantity: finalQuantity,
        price: finalPrice,
      };
    }
    if (resolvedSchedule?.ok && resolvedSchedule.fireTime >= resolvedClose.fireTime) {
      return {
        error: 'The linked reversing sell must fire after the scheduled opening buy.',
        boundCopy: boundCopy(action, chain, budget),
        quantity: finalQuantity,
        price: finalPrice,
      };
    }
  }
  return {
    error: null,
    boundCopy: boundCopy(action, chain, budget),
    quantity: finalQuantity,
    price: finalPrice,
  };
}

/**
 * The rules a buy carries, judged before anything is sent. Disarming a guard
 * has to be asked for: a stored rule whose fields were merely blanked is a
 * refusal, not a silent clear, because the request that would follow is the
 * same one `remove` sends and nothing on screen would say so.
 */
function priceRuleError(
  action: Exclude<OrderDialogAction, { kind: 'cancel' | 'fire' }>,
  draft: Draft,
  effectiveWhenType: WhenType | ScheduleType | null | undefined,
): string | null {
  const stored = storedRulesFor(action);
  const isEdit = action.kind === 'edit';

  if (draft.openPrice.state === 'edit') {
    const reading = readOpenPriceDraft(draft.openPrice.value);
    if (!reading.ok) return reading.error;
    if (isEdit && stored.open !== null && isNeutralOpenPriceDraft(draft.openPrice.value)) {
      return 'Blanking these limits would disarm the entry band. Use “remove” to clear it, or restore its limits.';
    }
    if (effectiveWhenType === 'OpeningAuction' && hasBandLimits(reading.rule)) {
      return 'An entry band cannot guard an Opening auction buy: it is sent at 09:00 and matched at 09:55, so no price exists while the band could still act.';
    }
  }

  if (draft.closePrice.state === 'edit') {
    const reading = readClosePriceDraft(draft.closePrice.value);
    if (!reading.ok) return reading.error;
    if (isEdit && stored.close !== null && isNeutralClosePriceDraft(draft.closePrice.value)) {
      return 'Blanking these targets would disarm the exit. Use “remove” to clear it, or restore its targets.';
    }
  }

  return null;
}

function boundCopy(
  action: Exclude<OrderDialogAction, { kind: 'cancel' | 'fire' }>,
  chain: BookChain,
  budget: BotBudget | undefined,
): string {
  if (actionDirection(action) === 'sell') {
    const current = sellCeiling(action, chain, false);
    const projected = sellCeiling(action, chain, true);
    const held = chain.positionQuantity;
    const headline =
      held === null
        ? `Available to this order: ${plural(current, 'share')}`
        : `Sellable by hand: ${formatQuantity(current)} of ${formatQuantity(held)}`;
    const schedule =
      current === projected
        ? ''
        : ` · ${formatQuantity(projected)} for a schedule after pending buys`;
    const claims = sellClaimCopy(action, chain);
    return (
      `${headline}${schedule}${claims}. A cancel in flight keeps its claim until the ` +
      'cancellation is confirmed. The four budget caps are buy-only, so none of them apply ' +
      'here — a sell is bounded by what the position has left after the orders already on it.'
    );
  }
  if (!budget)
    return 'A buy is bounded by the bot budget and effective per-position cap; those figures are not available yet.';
  const perPosition = effectivePerPositionCap(budget);
  // SPEC 4: an edit is judged with the order excluded from its own limit, and
  // the form has to state the ceiling that produces — `remainingBotBudget`
  // already has this order's reservation taken out of it.
  const ownCommitment = ownBuyCommitment(action);
  const budgetCeiling = budget.remainingBotBudget + ownCommitment;
  const binder =
    budgetCeiling <= perPosition
      ? `the bot budget binds it, under the ${formatNumber(perPosition)} the per-position cap allows`
      : `the per-position cap binds it, under the ${formatNumber(budgetCeiling)} the bot budget allows`;
  const selfExclusion =
    ownCommitment > 0
      ? ` This order's own ${formatNumber(ownCommitment)} is added back: an edit is not judged against itself.`
      : '';
  return `This buy may reserve up to ${formatNumber(Math.min(budgetCeiling, perPosition))} TL — ${binder}.${selfExclusion} Market buys reserve 10% extra per share.`;
}

/** What an edited buy already holds against the budget, and so gets back. */
function ownBuyCommitment(action: Exclude<OrderDialogAction, { kind: 'cancel' | 'fire' }>): number {
  if (action.kind !== 'edit' || action.row.direction !== 'buy') return 0;
  if (action.row.orderPrice === null || action.row.quantity === null) return 0;
  return reservedBuyCost(
    action.row.quantity,
    action.row.orderPrice,
    action.row.orderType ?? action.row.intentType ?? 'limit',
  );
}

/**
 * SPEC 6: say what decides the number. "30 of 120" alone leaves the reader
 * hunting the chain for the orders holding the other 90, so the claimants are
 * named here — the edited order excluded, because its own claim does not
 * count against itself.
 */
function sellClaimCopy(
  action: Exclude<OrderDialogAction, { kind: 'cancel' | 'fire' }>,
  chain: BookChain,
): string {
  const editedKey = action.kind === 'edit' ? action.row.key : null;
  const claims = chain.rows.flatMap((row) => {
    if (row.source !== 'active' && row.source !== 'scheduled') return [];
    if (row.direction !== 'sell' || !row.isWaiting || row.key === editedKey) return [];
    const kind = row.source === 'scheduled' ? 'scheduled' : 'resting';
    const type = row.orderType ? `${row.orderType} ` : '';
    return [
      row.quantity === null
        ? `the ${kind} ${type}sell claims the whole position`
        : `the ${kind} ${type}sell claims ${formatQuantity(row.quantity)}`,
    ];
  });
  return claims.length === 0 ? '' : ` — ${claims.join(', ')}`;
}

function sellCeiling(
  action: Exclude<OrderDialogAction, { kind: 'cancel' | 'fire' }>,
  chain: BookChain,
  scheduled = false,
): number {
  if (action.kind === 'edit' && action.row.direction === 'sell') {
    return chain.sellEditCeilingByRowKey[action.row.key] ?? 0;
  }
  return scheduled ? (chain.projectedSellableQuantity ?? 0) : (chain.sellableQuantity ?? 0);
}

function resolveDraftSchedule(draft: Draft, holidays: readonly Holiday[]) {
  const needsDiff = draft.scheduleType === 'AfterOpen' || draft.scheduleType === 'BeforeClose';
  const diff = needsDiff ? parseTurkishNumber(draft.diff) : undefined;
  return resolveSchedule(
    {
      day: draft.day,
      type: draft.scheduleType,
      ...(diff === null || diff === undefined ? {} : { diff }),
    },
    holidays,
  );
}

function scheduledEditOrderingError(
  action: Extract<OrderDialogAction, { kind: 'edit' }>,
  chain: BookChain,
  fireTime: number,
): string | null {
  if (action.row.source !== 'scheduled') return null;
  if (action.row.direction === 'sell' && action.row.parentClientOrderId) {
    const parent = chain.activeRows.find(
      (row) => row.source === 'scheduled' && row.clientOrderId === action.row.parentClientOrderId,
    );
    if (parent && (parent.scheduledTime === null || fireTime <= parent.scheduledTime)) {
      return 'The linked reversing sell must fire strictly after its still-scheduled opening buy.';
    }
  }
  if (action.row.direction === 'buy') {
    const children = chain.activeRows.filter(
      (row) => row.source === 'scheduled' && row.parentClientOrderId === action.row.clientOrderId,
    );
    if (children.some((row) => row.scheduledTime === null || fireTime >= row.scheduledTime!)) {
      return 'The scheduled opening buy must fire strictly before every linked reversing sell.';
    }
  }
  return null;
}

/**
 * The three states EditOrders draws apart: omitting a rule leaves the stored
 * one alone, an object replaces it wholesale, and an explicit null is the only
 * way to disarm one. A send has no stored rule to leave alone, so it only ever
 * omits or names — never nulls.
 */
function rulePayloads(
  action: Exclude<OrderDialogAction, { kind: 'cancel' | 'fire' }>,
  draft: Pick<Draft, 'openPrice' | 'closePrice'>,
  forEdit: boolean,
): { openPrice?: OpenPriceRule | null; closePrice?: ClosePriceRule | null } {
  if (actionDirection(action) !== 'buy') return {};
  const stored = storedRulesFor(action);
  const payload: { openPrice?: OpenPriceRule | null; closePrice?: ClosePriceRule | null } = {};

  if (draft.openPrice.state === 'cleared') {
    if (forEdit && stored.open !== null) payload.openPrice = null;
  } else {
    const reading = readOpenPriceDraft(draft.openPrice.value);
    // An unreadable draft never reaches here: validateDraft blocks the submit.
    if (
      reading.ok &&
      reading.rule !== null &&
      !(forEdit && sameOpenPrice(reading.rule, stored.open))
    ) {
      payload.openPrice = reading.rule;
    }
  }

  if (draft.closePrice.state === 'cleared') {
    if (forEdit && stored.close !== null) payload.closePrice = null;
  } else {
    const reading = readClosePriceDraft(draft.closePrice.value);
    if (
      reading.ok &&
      reading.rule !== null &&
      !(forEdit && sameClosePrice(reading.rule, stored.close))
    ) {
      payload.closePrice = reading.rule;
    }
  }

  return payload;
}

function buildEditRequest(
  action: Extract<OrderDialogAction, { kind: 'edit' }>,
  draft: Draft,
  chain: BookChain,
) {
  const validation = draftForRequest(action, draft);
  return {
    botId: chain.botId,
    direction: action.row.direction,
    type: validation.type,
    orderIds: [action.row.raw.clientOrderId],
    stocks: [
      {
        symbol: action.row.symbol,
        orderId: action.row.raw.clientOrderId,
        ...(validation.price === null ? {} : { price: validation.price }),
        ...(validation.quantity === null ? {} : { quantity: validation.quantity }),
        ...(action.row.source === 'scheduled' && validation.changeSchedule
          ? { time: scheduleFromDraft(validation) }
          : {}),
        ...(action.row.source === 'scheduled' && action.row.direction === 'buy'
          ? { cancelAtFloor: validation.cancelAtFloor }
          : {}),
        ...rulePayloads(action, validation, true),
      },
    ],
  };
}

function buildSendRequest(
  action: Extract<OrderDialogAction, { kind: 'sell' | 'resend' }>,
  draft: Draft,
  chain: BookChain,
): SendOrdersRequest {
  const values =
    action.kind === 'resend' && draft.resendMode === 'same'
      ? draftForRequest(action, draftFor(action, chain))
      : draftForRequest(action, draft);
  const direction = actionDirection(action);
  const stock = {
    symbol: action.row.symbol,
    ...(values.price === null ? {} : { price: values.price }),
    ...(values.quantity === null ? {} : { quantity: values.quantity }),
    ...(values.scheduled
      ? direction === 'buy'
        ? { openTime: scheduleFromDraft(values) }
        : { closeTime: scheduleFromDraft(values) }
      : {}),
    ...(action.kind === 'resend' && action.row.direction === 'buy' && values.keepClose
      ? { closeTime: { day: values.day, type: 'BeforeClose' as const, diff: 30 } }
      : {}),
    ...(direction === 'buy' && values.scheduled ? { cancelAtFloor: values.cancelAtFloor } : {}),
    ...rulePayloads(action, values, false),
  };
  return {
    botId: chain.botId,
    direction,
    type: values.type,
    stocks: [stock],
  };
}

async function fireScheduled(
  action: Extract<OrderDialogAction, { kind: 'fire' }>,
  chain: BookChain,
  queryClient: ReturnType<typeof useQueryClient>,
  setResults: (results: ActionResult[]) => void,
  setResultTitle: (title: string) => void,
  getWritesHeldReason: () => string | null,
) {
  const clientOrderId = action.row.raw.clientOrderId;
  let freshScheduled: ActiveOrder;
  try {
    const freshRows = await bistApi.getActiveOrders(chain.botId);
    const freshRow = freshRows.find((row) => row.clientOrderId === clientOrderId);
    if (!freshRow || freshRow.status !== 'Scheduled') {
      setResultTitle('Not fired');
      setResults([
        {
          id: 'cancel',
          label: `1 · Remove scheduled ${action.row.symbol}`,
          tone: 'not-sent',
          detail: freshRow
            ? 'A fresh snapshot shows this row is no longer scheduled. CancelOrders was not called.'
            : 'A fresh snapshot no longer contains this scheduled row. CancelOrders was not called.',
        },
        {
          id: 'send',
          label: `2 · Send ${action.row.symbol} now`,
          tone: 'not-sent',
          word: 'Not fired',
          detail: 'The safety preflight did not prove a schedule that could be removed.',
        },
      ]);
      return;
    }
    if (!sameScheduledFireTerms(action.row.raw, freshRow)) {
      setResultTitle('Not fired · terms changed');
      setResults([
        {
          id: 'cancel',
          label: `1 · Remove scheduled ${action.row.symbol}`,
          tone: 'not-sent',
          detail:
            'The scheduled side, symbol, type, price, quantity, timing, or guard changed after confirmation. Review the fresh row before firing it.',
        },
        {
          id: 'send',
          label: `2 · Send ${action.row.symbol} now`,
          tone: 'not-sent',
          word: 'Not fired',
          detail: 'Neither write call was made.',
        },
      ]);
      return;
    }
    // Firing early may not quietly disarm what the schedule was carrying. If
    // the rule cannot be re-expressed it cannot be re-sent, so nothing moves.
    if (
      readOpenPrice(freshRow.openPrice).kind === 'unreadable' ||
      readClosePrice(freshRow.closePrice).kind === 'unreadable'
    ) {
      setResultTitle('Not fired · guard unreadable');
      setResults([
        {
          id: 'cancel',
          label: `1 · Remove scheduled ${action.row.symbol}`,
          tone: 'not-sent',
          detail:
            'The schedule carries a price rule in a form this viewer cannot re-express. CancelOrders was not called.',
        },
        {
          id: 'send',
          label: `2 · Send ${action.row.symbol} now`,
          tone: 'not-sent',
          word: 'Not fired',
          detail:
            'A replacement would have gone out without that guard, so neither write call was made.',
        },
      ]);
      return;
    }
    freshScheduled = freshRow;
  } catch (error) {
    const apiError = asBistApiError(error);
    setResultTitle('Not fired');
    setResults([
      {
        id: 'cancel',
        label: `1 · Remove scheduled ${action.row.symbol}`,
        tone: 'not-sent',
        detail: `${apiError.message} The fresh safety read failed, so CancelOrders was not called.`,
      },
      {
        id: 'send',
        label: `2 · Send ${action.row.symbol} now`,
        tone: 'not-sent',
        word: 'Not fired',
        detail: 'No removal was attempted, so no replacement call was made.',
      },
    ]);
    return;
  }

  const heldAfterPreflight = getWritesHeldReason();
  if (heldAfterPreflight) {
    setResultTitle('Not fired');
    setResults([
      {
        id: 'cancel',
        label: `1 · Remove scheduled ${action.row.symbol}`,
        tone: 'not-sent',
        detail: `${heldAfterPreflight} The stream changed during the safety read, so CancelOrders was not called.`,
      },
      {
        id: 'send',
        label: `2 · Send ${action.row.symbol} now`,
        tone: 'not-sent',
        word: 'Not fired',
        detail: 'No schedule was removed and no replacement call was made.',
      },
    ]);
    return;
  }

  try {
    await bistApi.cancelOrders(chain.botId, [clientOrderId]);
    invalidateBotBudget(queryClient, chain.botId);
  } catch (error) {
    const apiError = asBistApiError(error);
    const cancelResult: ActionResult = apiError.queued
      ? queuedResult('cancel', `1 · Remove scheduled ${action.row.symbol}`, apiError)
      : {
          id: 'cancel',
          label: `1 · Remove scheduled ${action.row.symbol}`,
          tone:
            apiError.mayHaveReachedExchange ||
            apiError.kind === 'unknown' ||
            apiError.kind === 'protocol'
              ? 'unknown'
              : 'refused',
          detail: `${apiError.message} The schedule was not confirmed removed, so no replacement was attempted.`,
        };
    setResultTitle(apiError.queued ? 'Waiting · removal queued' : 'Not fired');
    setResults([
      cancelResult,
      {
        id: 'send',
        label: `2 · Send ${action.row.symbol} now`,
        tone: 'not-sent',
        word: 'Not fired',
        detail: 'The first call did not confirm removal, so the fresh order was not attempted.',
      },
    ]);
    return;
  }

  const confirmation = await confirmScheduledRemoval(chain.botId, clientOrderId);
  if (confirmation.kind !== 'removed') {
    if (confirmation.kind === 'unsafe-canceled') recordCanceledOrder(queryClient, confirmation.row);
    setResultTitle('Not fired');
    setResults([
      {
        id: 'cancel',
        label: `1 · Remove scheduled ${action.row.symbol}`,
        tone: confirmation.kind === 'active' ? 'accepted' : 'unknown',
        word:
          confirmation.kind === 'unsafe-canceled'
            ? 'Not proved'
            : confirmation.kind === 'unknown'
              ? 'No answer'
              : 'Accepted',
        detail:
          confirmation.kind === 'active'
            ? 'The row fired before cancellation completed. The empty reply only accepts cancellation of that live order.'
            : confirmation.kind === 'unsafe-canceled'
              ? 'The canceled record does not prove this row stayed off the exchange, so fill exposure may have changed.'
              : 'CancelOrders returned, but the fresh reads did not prove that this schedule was removed before reaching the exchange.',
      },
      {
        id: 'send',
        label: `2 · Send ${action.row.symbol} now`,
        tone: 'not-sent',
        word: 'Not fired',
        detail:
          'The original order was not proven safely removed, so this viewer did not create a replacement.',
      },
    ]);
    return;
  }
  recordConfirmedScheduleRemoval(queryClient, confirmation.row);

  const newlyHeld = getWritesHeldReason();
  if (newlyHeld) {
    setResultTitle('Half done · replacement held');
    setResults([
      removedScheduleResult(action.row.symbol),
      {
        id: 'send',
        label: `2 · Send ${action.row.symbol} now`,
        tone: 'not-sent',
        word: 'Not fired',
        detail: `${newlyHeld} The original schedule is already gone; no replacement call was made.`,
      },
    ]);
    return;
  }

  try {
    const request: SendOrdersRequest = {
      botId: chain.botId,
      direction: freshScheduled.direction,
      type: freshScheduled.type ?? freshScheduled.intentType ?? 'limit',
      stocks: [
        {
          symbol: freshScheduled.symbol,
          ...(freshScheduled.orderPrice === null ? {} : { price: freshScheduled.orderPrice }),
          ...(freshScheduled.orderQuantity === null
            ? {}
            : { quantity: freshScheduled.orderQuantity }),
          // The guards travel with the order. A buy fired early is the same
          // buy, and it stays as guarded as the schedule left it.
          ...(freshScheduled.direction === 'buy'
            ? {
                ...(parseOpenPrice(freshScheduled.openPrice) === null
                  ? {}
                  : { openPrice: parseOpenPrice(freshScheduled.openPrice)! }),
                ...(parseClosePrice(freshScheduled.closePrice) === null
                  ? {}
                  : { closePrice: parseClosePrice(freshScheduled.closePrice)! }),
              }
            : {}),
        },
      ],
    };
    const response = await bistApi.sendOrders(request);
    invalidateBotBudget(queryClient, chain.botId);
    const sent = response.toOrder.some((row) => row.symbol === action.row.symbol);
    const reason = response.skippedList.find((row) => row.symbol === action.row.symbol)?.reason;
    const sendResult: ActionResult = sent
      ? {
          id: 'send',
          label: `2 · Send ${action.row.symbol} now`,
          tone: 'landed',
          word: 'Sent now',
          detail: 'A fresh order was created with its own id and chain.',
        }
      : reason
        ? {
            id: 'send',
            label: `2 · Send ${action.row.symbol} now`,
            tone: 'refused',
            word: 'Not fired',
            detail: `${reason} The schedule is gone and the server guard created no replacement.`,
          }
        : {
            id: 'send',
            label: `2 · Send ${action.row.symbol} now`,
            tone: 'unknown',
            detail:
              'The reply named this symbol in neither result list. The schedule is gone and the replacement outcome is unknown; do not send it again.',
          };
    setResultTitle(sent ? 'Sent now' : 'Half done');
    setResults([removedScheduleResult(action.row.symbol), sendResult]);
  } catch (error) {
    const apiError = asBistApiError(error);
    setResultTitle(apiError.queued ? 'Half done · replacement queued' : 'Half done');
    setResults([
      removedScheduleResult(action.row.symbol),
      apiError.queued
        ? queuedResult('send', `2 · Send ${action.row.symbol} now`, apiError, true)
        : {
            id: 'send',
            label: `2 · Send ${action.row.symbol} now`,
            tone:
              apiError.mayHaveReachedExchange ||
              apiError.kind === 'unknown' ||
              apiError.kind === 'protocol'
                ? 'unknown'
                : 'refused',
            detail: `${apiError.message} The original schedule is already gone. This viewer did not retry the replacement.`,
          },
    ]);
  }
}

function removedScheduleResult(symbol: string): ActionResult {
  return {
    id: 'cancel',
    label: `1 · Remove scheduled ${symbol}`,
    tone: 'landed',
    word: 'Removed',
    detail: 'The scheduled row is gone and will not come back.',
  };
}

function queuedResult(
  id: string,
  label: string,
  error: ReturnType<typeof asBistApiError>,
  scheduleAlreadyRemoved = false,
): ActionResult {
  const retry =
    error.retryAt === null
      ? ''
      : ` Next replay: ${new Date(error.retryAt).toLocaleString('tr-TR', {
          timeZone: 'Europe/Istanbul',
        })}.`;
  const attempts =
    error.attemptsLeft === null ? '' : ` ${error.attemptsLeft} replay attempts remain.`;
  return {
    id,
    label,
    tone: 'accepted',
    word: 'Queued',
    detail: `${error.message} The server owns this request and will replay it; do not send it again.${retry}${attempts}${
      scheduleAlreadyRemoved ? ' The original schedule is already gone.' : ''
    }`,
  };
}

function draftForRequest(
  action: Exclude<OrderDialogAction, { kind: 'cancel' | 'fire' }>,
  draft: Draft,
) {
  return {
    ...draft,
    price: parseTurkishNumber(draft.price),
    quantity: draft.quantity.trim() ? (parseTurkishNumber(draft.quantity) ?? 0) : null,
  };
}

function scheduleFromDraft(draft: ReturnType<typeof draftForRequest>): ScheduleSpec {
  const needsDiff = draft.scheduleType === 'AfterOpen' || draft.scheduleType === 'BeforeClose';
  return {
    day: draft.day,
    type: draft.scheduleType,
    ...(needsDiff ? { diff: parseTurkishNumber(draft.diff) ?? 0 } : {}),
  };
}

function draftFor(action: OrderDialogAction | undefined, chain?: BookChain): Draft {
  const today = toIstanbulDateKey(Date.now());
  if (!action)
    return {
      type: 'limit',
      price: '',
      quantity: '',
      scheduled: false,
      day: today,
      scheduleType: 'BeforeClose',
      diff: '30',
      cancelAtFloor: false,
      resendMode: 'same',
      keepClose: false,
      changeSchedule: false,
      openPrice: { state: 'edit', value: EMPTY_OPEN_PRICE_DRAFT },
      closePrice: { state: 'edit', value: EMPTY_CLOSE_PRICE_DRAFT },
    };
  const stored = storedRulesFor(action);
  return {
    type: action.row.orderType ?? action.row.intentType ?? 'limit',
    price: action.row.orderPrice === null ? '' : editableNumber(action.row.orderPrice),
    quantity:
      action.kind === 'sell'
        ? String(chain?.sellableQuantity ?? action.row.quantity ?? '')
        : action.row.quantity === null
          ? ''
          : String(action.row.quantity),
    scheduled: action.kind === 'edit' && action.row.source === 'scheduled',
    day:
      action.kind === 'edit' && action.row.scheduledTime
        ? toIstanbulDateKey(action.row.scheduledTime)
        : today,
    scheduleType: 'BeforeClose',
    diff: '30',
    cancelAtFloor: action.kind === 'edit' ? action.row.raw.cancelAtFloor : false,
    resendMode:
      action.kind === 'resend' && chain && resendSameUnavailableReason(action, chain)
        ? 'change'
        : 'same',
    keepClose: false,
    changeSchedule: false,
    openPrice: { state: 'edit', value: openPriceDraftFrom(stored.open) },
    closePrice: { state: 'edit', value: closePriceDraftFrom(stored.close) },
  };
}

function editableNumber(value: number): string {
  return String(value).replace('.', ',');
}

function linkedReversingSell(row: BookCanceledOrderRow, chain: BookChain) {
  if (row.clientOrderId === null) return undefined;
  return chain.rows.find(
    (candidate) =>
      candidate.direction === 'sell' && candidate.parentClientOrderId === row.clientOrderId,
  );
}

function resendSameUnavailableReason(
  action: Extract<OrderDialogAction, { kind: 'resend' }>,
  chain: BookChain,
): string | null {
  if (action.row.direction === 'buy' && linkedReversingSell(action.row, chain)) {
    return 'The original buy carried a linked reversing sell, but GetCanceledOrders does not preserve its closeTime, so it cannot be recreated verbatim.';
  }
  if (!action.row.raw.matriksOrderId) {
    return 'The original order has no confirmed exchange id and its fire-time spec is not present in GetCanceledOrders, so its timing cannot be recreated verbatim.';
  }
  return null;
}

function sameActionRowState(
  left: BookChain['rows'][number],
  right: BookChain['rows'][number],
): boolean {
  const leftCancelAtFloor =
    left.source === 'active' || left.source === 'scheduled' ? left.raw.cancelAtFloor : null;
  const rightCancelAtFloor =
    right.source === 'active' || right.source === 'scheduled' ? right.raw.cancelAtFloor : null;
  const leftRules = rowRules(left);
  const rightRules = rowRules(right);
  return (
    left.key === right.key &&
    left.source === right.source &&
    sameStoredRule(leftRules.open, rightRules.open) &&
    sameStoredRule(leftRules.close, rightRules.close) &&
    left.status === right.status &&
    left.direction === right.direction &&
    left.quantity === right.quantity &&
    left.filledQuantity === right.filledQuantity &&
    left.canceledQuantity === right.canceledQuantity &&
    left.orderType === right.orderType &&
    left.intentType === right.intentType &&
    left.orderPrice === right.orderPrice &&
    left.averagePrice === right.averagePrice &&
    left.scheduledTime === right.scheduledTime &&
    left.cancelInFlight === right.cancelInFlight &&
    leftCancelAtFloor === rightCancelAtFloor
  );
}

function sameScheduledFireTerms(left: ActiveOrder, right: ActiveOrder): boolean {
  return (
    left.clientOrderId === right.clientOrderId &&
    left.botId === right.botId &&
    left.symbol === right.symbol &&
    left.direction === right.direction &&
    left.type === right.type &&
    left.orderPrice === right.orderPrice &&
    left.orderQuantity === right.orderQuantity &&
    left.timeInForce === right.timeInForce &&
    left.cancelAtFloor === right.cancelAtFloor &&
    sameStoredRule(left.openPrice, right.openPrice) &&
    sameStoredRule(left.closePrice, right.closePrice) &&
    (left.scheduledTime ?? null) === (right.scheduledTime ?? null) &&
    (left.whenType ?? null) === (right.whenType ?? null)
  );
}

function actionStep(action: OrderDialogAction): Step {
  return action.kind === 'cancel' || action.kind === 'fire' ? 'confirm' : 'form';
}
function rpcName(kind: OrderDialogAction['kind']): string {
  return kind === 'edit' ? 'EditOrders' : kind === 'cancel' ? 'CancelOrders' : 'SendOrders';
}
function actionLabel(action: OrderDialogAction): string {
  // `sell` already names the side, so repeating it read "sell sell THYAO".
  if (action.kind === 'sell') return `sell ${action.row.symbol}`;
  const word = action.kind === 'fire' ? 'fire now' : action.kind;
  return `${word} ${actionDirection(action)} ${action.row.symbol}`;
}

function actionDirection(action: OrderDialogAction): 'buy' | 'sell' {
  return action.kind === 'sell' ? 'sell' : action.row.direction;
}
function dialogTitle(chain: BookChain, action: OrderDialogAction | undefined, step: Step): string {
  if (!action) return `${chain.symbol} · chain`;
  const label = actionLabel(action);
  if (step === 'sending') return `Sending · ${label}`;
  if (step === 'result') return `Result · ${label}`;
  const sentence = label.charAt(0).toUpperCase() + label.slice(1);
  // A form is visibly a form; only the confirm step needs to name itself.
  return step === 'confirm' ? `${sentence} · confirm` : sentence;
}

function markCancelInFlight(queryClient: ReturnType<typeof useQueryClient>, clientOrderId: string) {
  queryClient.setQueriesData<ActiveOrder[]>({ queryKey: ['bist', 'activeOrders'] }, (rows) =>
    rows?.map((row) =>
      row.clientOrderId === clientOrderId ? { ...row, cancelSource: 'bot' } : row,
    ),
  );
}

type ScheduledRemovalConfirmation =
  | { kind: 'removed'; row: CanceledOrder }
  | { kind: 'active'; row: ActiveOrder }
  | { kind: 'unsafe-canceled'; row: CanceledOrder }
  | { kind: 'unknown' };

async function confirmScheduledRemoval(
  botId: string,
  clientOrderId: string,
): Promise<ScheduledRemovalConfirmation> {
  try {
    const [activeRows, canceledRows] = await Promise.all([
      bistApi.getActiveOrders(botId),
      bistApi.getCanceledOrders(botId),
    ]);
    const active = activeRows.find((row) => row.clientOrderId === clientOrderId);
    const canceled = canceledRows.find((row) => row.clientOrderId === clientOrderId);
    if (canceled && !active && provesPreExchangeScheduledRemoval(canceled)) {
      return { kind: 'removed', row: canceled };
    }
    if (active) return { kind: 'active', row: active };
    if (canceled) return { kind: 'unsafe-canceled', row: canceled };
    return { kind: 'unknown' };
  } catch {
    return { kind: 'unknown' };
  }
}

function provesPreExchangeScheduledRemoval(row: CanceledOrder): boolean {
  return (
    row.clientOrderId !== null &&
    row.clientOrderId.length > 0 &&
    row.status === 'CanceledByBot' &&
    row.matriksOrderId === null &&
    row.matriksOrderId2 === null &&
    row.orderTime === null &&
    row.sentTime === null
  );
}

function removeActiveOrder(queryClient: ReturnType<typeof useQueryClient>, clientOrderId: string) {
  queryClient.setQueriesData<ActiveOrder[]>({ queryKey: ['bist', 'activeOrders'] }, (rows) =>
    rows?.filter((row) => row.clientOrderId !== clientOrderId),
  );
}

function recordCanceledOrder(
  queryClient: ReturnType<typeof useQueryClient>,
  canceled: CanceledOrder,
) {
  queryClient.setQueryData<CanceledOrder[]>(bistKeys.canceledOrders('*'), (rows) =>
    rows ? [...rows.filter((row) => row.clientOrderId !== canceled.clientOrderId), canceled] : rows,
  );
}

function recordConfirmedScheduleRemoval(
  queryClient: ReturnType<typeof useQueryClient>,
  canceled: CanceledOrder,
) {
  if (canceled.clientOrderId !== null) removeActiveOrder(queryClient, canceled.clientOrderId);
  recordCanceledOrder(queryClient, canceled);
}

function invalidateBotBudget(queryClient: ReturnType<typeof useQueryClient>, botId: string): void {
  void queryClient.invalidateQueries({ queryKey: bistKeys.budget(botId), exact: true });
}
