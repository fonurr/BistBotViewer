import { useEffect, useRef, useState } from 'react';

import type { Account, Bot } from '../../bistApi/types';
import type { Quote } from '../../priceApi/types';
import { type BookChain, type BookChainRow } from '../../domain/chains';
import {
  formatDateKey,
  formatPercentage,
  formatQuantity,
  formatRowTime,
  formatSignedNumber,
  formatNumber,
  plural,
} from '../../domain/format';
import {
  deriveFilledPnlState,
  type FilledPnlState,
  pnlPercentage,
  realizedPnl,
  slippagePercentage,
  unrealizedPnl,
} from '../../domain/orders';
import { statusClass } from '../../domain/status';
import { useMinuteClock } from '../../components/useMinuteClock';
import { bookRowPresentation } from './rowPresentation';
import type { BookFilterState } from './types';
import { orderActionsForRow, type OrderDialogAction } from './orderActions';

interface BookGridProps {
  chains: readonly BookChain[];
  filters: BookFilterState;
  bots: readonly Bot[];
  accounts: readonly Account[];
  quotes: ReadonlyMap<string, Quote>;
  pricesTrustworthy: boolean;
  writesHeldReason: string | null;
  showCanceled: boolean;
  openCanceledChains: ReadonlySet<string>;
  onToggleCanceledChain: (chainKey: string) => void;
  onOpenChain: (chain: BookChain, action?: OrderDialogAction) => void;
}

const columnLabels = [
  '',
  'symbol',
  'qty',
  'side / type',
  'order',
  'fill',
  'slip',
  'p&l',
  'ord time',
  'ack time',
  'status',
  'act',
];

export function BookGrid(props: BookGridProps) {
  const now = useMinuteClock();
  const botById = new Map(props.bots.map((bot) => [bot.id, bot]));
  const accountById = new Map(props.accounts.map((account) => [account.accountId, account]));
  const groups = groupChains(props.chains);
  const positions = new Map(
    props.chains
      .flatMap((chain) => chain.sources.positions)
      .map((position) => [position.id, position]),
  );
  const activeOrders = new Map(
    props.chains.flatMap((chain) => chain.sources.activeOrders).map((order) => [order.id, order]),
  );
  const closedTrades = new Map(
    props.chains.flatMap((chain) => chain.sources.closedTrades).map((trade) => [trade.id, trade]),
  );
  const pnlState = deriveFilledPnlState(
    [...positions.values()],
    [...activeOrders.values()],
    [...closedTrades.values()],
  );

  return (
    <div className="book-grid-wrap" role="table" aria-label="Order, position and trade chains">
      <div className="book-columns" role="row">
        {columnLabels.map((label, index) => (
          <div
            key={`${label}:${index}`}
            role="columnheader"
            className={(index >= 4 && index <= 7) || index === 11 ? 'align-right' : ''}
          >
            {label}
          </div>
        ))}
      </div>
      {groups.map((dateGroup) => (
        <section className="book-date-group" role="rowgroup" key={dateGroup.date}>
          <header className="book-date-heading">
            <span>
              {dateGroup.date === 'unknown' ? 'Date unknown' : formatDateKey(dateGroup.date)}
            </span>
            <span className="kicker">batch</span>
            <span className="muted">{plural(dateGroup.chains.length, 'chain')}</span>
          </header>
          {dateGroup.bots.map((botGroup) => {
            const bot = botById.get(botGroup.botId);
            const account = bot?.accountId ? accountById.get(bot.accountId) : undefined;
            return (
              <section
                className="book-bot-group"
                role="presentation"
                key={`${dateGroup.date}:${botGroup.botId}`}
              >
                <header className="book-bot-heading">
                  <span className="book-bot-name" title={bot?.description ?? undefined}>
                    {botGroup.botId}
                  </span>
                  <span className="muted">
                    {bot?.accountId ?? 'account unset'}
                    {account ? ` · ${account.owner}` : ''}
                    {bot?.brokerageId ? ` · ${bot.brokerageId}` : ''}
                  </span>
                  <span className="book-bot-rule" />
                </header>
                {botGroup.chains.map((chain) => (
                  <ChainRows
                    {...props}
                    chain={chain}
                    pnlState={pnlState}
                    now={now}
                    key={chain.key}
                  />
                ))}
              </section>
            );
          })}
        </section>
      ))}
    </div>
  );
}

function ChainRows(
  props: BookGridProps & { chain: BookChain; pnlState: FilledPnlState; now: number },
) {
  const { chain } = props;
  const nonCanceledRows = chain.rows.filter(
    (row) => row.source !== 'canceled' && rowVisible(row, props.filters),
  );
  const canceledSelected = props.filters.scopes.has('canceled');
  const chainCanceledOpen = props.showCanceled !== props.openCanceledChains.has(chain.key);
  const canceledRows = chain.canceledRows;
  const visibleCanceled = chainCanceledOpen;
  const hasAnyVisible = nonCanceledRows.length > 0 || canceledSelected;
  if (!hasAnyVisible) return null;

  return (
    <article className="book-chain" aria-label={`${chain.symbol} chain`}>
      {nonCanceledRows.map((row, index) => (
        <BookRow
          key={row.key}
          row={row}
          chain={chain}
          opener={index === 0}
          quotes={props.quotes}
          pnlState={props.pnlState}
          pricesTrustworthy={props.pricesTrustworthy}
          writesHeldReason={props.writesHeldReason}
          now={props.now}
          onOpenChain={props.onOpenChain}
        />
      ))}
      {canceledRows.length > 0 ? (
        <div className="canceled-tail">
          {visibleCanceled
            ? canceledRows.map((row) => (
                <BookRow
                  key={row.key}
                  row={row}
                  chain={chain}
                  opener={nonCanceledRows.length === 0 && row === canceledRows[0]}
                  quotes={props.quotes}
                  pnlState={props.pnlState}
                  pricesTrustworthy={props.pricesTrustworthy}
                  writesHeldReason={props.writesHeldReason}
                  now={props.now}
                  onOpenChain={props.onOpenChain}
                />
              ))
            : null}
          <div className="canceled-tail-summary">
            <button type="button" onClick={() => props.onToggleCanceledChain(chain.key)}>
              {visibleCanceled ? 'hide' : 'show'} · {plural(canceledRows.length, 'canceled order')}
            </button>
            <CanceledTailNote chain={chain} />
          </div>
        </div>
      ) : null}
    </article>
  );
}

function BookRow({
  row,
  chain,
  opener,
  quotes,
  pnlState,
  pricesTrustworthy,
  writesHeldReason,
  now,
  onOpenChain,
}: {
  row: BookChainRow;
  chain: BookChain;
  opener: boolean;
  quotes: ReadonlyMap<string, Quote>;
  pnlState: FilledPnlState;
  pricesTrustworthy: boolean;
  writesHeldReason: string | null;
  now: number;
  onOpenChain: BookGridProps['onOpenChain'];
}) {
  const quote = quotes.get(row.symbol);
  const displayType = row.orderType;
  const pnlFigure = bookRowPnlFigure(row, pnlState, quote?.son ?? null);
  const pnl = pnlFigure?.value ?? null;
  const pnlPercent = rowPnlPercent(pnlFigure);
  const slip =
    row.averagePrice === null
      ? null
      : slippagePercentage({
          orderPrice: row.orderPrice,
          averagePrice: row.averagePrice,
          type: displayType,
        });
  const status = bookRowPresentation(row, chain, now);
  const actionButtons = orderActionsForRow(row, chain);
  const capturedPrice = displayType === 'market' && row.orderPrice !== null;
  const pnlTrusted = pnlFigure?.marketBased !== true || pricesTrustworthy;
  const batchDate = chain.batchDate ?? '';
  const orderTime = row.source === 'scheduled' ? row.scheduledTime : row.orderTime;
  const signature = rowFlashSignature(row);
  const previousSignature = useRef(signature);
  const [flashing, setFlashing] = useState(false);

  useEffect(() => {
    if (previousSignature.current === signature) return;
    previousSignature.current = signature;
    setFlashing(false);
    const frame = requestAnimationFrame(() => setFlashing(true));
    const timer = window.setTimeout(() => setFlashing(false), 1_150);
    return () => {
      cancelAnimationFrame(frame);
      window.clearTimeout(timer);
    };
  }, [signature]);

  return (
    <div
      className={`book-row${opener ? ' book-row-opener' : ' book-row-leg'}${row.cancelInFlight ? ' cancel-in-flight' : ''}${flashing ? ' row-flash' : ''}`}
      role="row"
    >
      <div className={`book-spine ${statusClass(status.role)}`} role="cell" aria-hidden="true" />
      <div role="cell">
        <button type="button" className="book-symbol" onClick={() => onOpenChain(chain)}>
          {row.symbol}
          {row.clientOrderId ? <span>…{row.clientOrderId.slice(-6)}</span> : null}
        </button>
      </div>
      <div role="cell">
        {row.quantity === null ? (
          <span className="captured-value">auto</span>
        ) : (
          formatQuantity(row.quantity)
        )}
      </div>
      <div role="cell">
        <span className={row.direction === 'buy' ? 'side-buy' : 'side-sell'}>{row.direction}</span>
        {displayType ? ` ${displayType}` : ''}
      </div>
      <div role="cell" className={`align-right${capturedPrice ? ' captured-value' : ''}`}>
        {row.orderPrice === null ? '' : formatNumber(row.orderPrice)}
      </div>
      <div role="cell" className="align-right">
        {row.averagePrice === null ? '' : formatNumber(row.averagePrice)}
      </div>
      <div role="cell" className="align-right book-slip">
        {slip === null ? '' : formatPercentage(slip)}
      </div>
      <div role="cell" className={`align-right book-pnl ${pnlClass(pnl, pnlTrusted)}`}>
        {pnl === null ? (
          ''
        ) : (
          <>
            {formatSignedNumber(pnl)}
            {pnlPercent === null ? null : <small> ({formatPercentage(pnlPercent)})</small>}
            {pnlTrusted ? null : <small className="pnl-note">last known</small>}
          </>
        )}
      </div>
      <div
        role="cell"
        className={row.source === 'scheduled' ? 'status-wait book-time' : 'muted book-time'}
      >
        {orderTime === null ? '' : (formatRowTime(orderTime, batchDate) ?? '')}
      </div>
      <div role="cell" className="muted book-time">
        {row.acknowledgementTime === null
          ? ''
          : (formatRowTime(row.acknowledgementTime, batchDate) ?? '')}
      </div>
      <div role="cell" className={`book-status ${statusClass(status.role)}`}>
        <span>{status.label}</span>
        {status.detail ? <small>{status.detail}</small> : null}
      </div>
      <div role="cell" className="book-actions">
        {actionButtons.map((action) => (
          <button
            type="button"
            className={`btn btn-ghost${action.kind === 'fire' ? ' fire-action' : ''}${
              action.kind === 'sell' && chain.hasNoClosingOrder ? ' exposed-action' : ''
            }`}
            disabled={Boolean(writesHeldReason) || action.disabled}
            title={writesHeldReason ?? action.disabledReason}
            key={action.kind}
            onClick={() => onOpenChain(chain, action)}
          >
            {actionLabel(action.kind)}
          </button>
        ))}
      </div>
    </div>
  );
}

function rowFlashSignature(row: BookChainRow): string {
  return [
    row.status,
    row.quantity,
    row.filledQuantity,
    row.canceledQuantity,
    row.orderPrice,
    row.averagePrice,
    row.scheduledTime,
    row.cancelInFlight,
    row.acknowledgementTime,
  ].join('|');
}

function rowVisible(row: BookChainRow, filters: BookFilterState): boolean {
  if (row.source === 'active' || row.source === 'scheduled') return filters.scopes.has('waiting');
  if (row.source === 'position') return filters.scopes.has('positions');
  if (row.source === 'closed-trade') return filters.scopes.has('trades');
  return filters.scopes.has('canceled');
}

function actionLabel(kind: OrderDialogAction['kind']): string {
  if (kind === 'fire') return 'fire now';
  return kind;
}

export interface RowPnlFigure {
  value: number | null;
  costBasis: number;
  marketBased: boolean;
}

export function bookRowPnlFigure(
  row: BookChainRow,
  pnlState: FilledPnlState,
  marketPrice: number | null,
): RowPnlFigure | null {
  if (row.source === 'position') {
    const exposure = pnlState.exposures.find(
      (candidate) => candidate.source === 'position' && candidate.sourceId === row.raw.id,
    );
    if (!exposure) return null;
    return {
      value: marketPrice === null ? null : unrealizedPnl(exposure, marketPrice),
      costBasis: exposure.quantity * exposure.averagePrice,
      marketBased: true,
    };
  }
  if (row.source === 'active' && row.direction === 'buy') {
    const exposure = pnlState.exposures.find(
      (candidate) => candidate.source === 'partial-buy' && candidate.sourceId === row.raw.id,
    );
    if (!exposure) return null;
    return {
      value: marketPrice === null ? null : unrealizedPnl(exposure, marketPrice),
      costBasis: exposure.quantity * exposure.averagePrice,
      marketBased: true,
    };
  }
  if (row.source === 'active' && row.direction === 'sell') {
    const fill = pnlState.partialSellFills.find((candidate) => candidate.sourceId === row.raw.id);
    if (!fill) return null;
    return {
      value: realizedPnl(fill.quantity, fill.averageOpenPrice, fill.averageClosePrice),
      costBasis: fill.quantity * fill.averageOpenPrice,
      marketBased: false,
    };
  }
  if (row.source === 'closed-trade' && row.leg === 'close') {
    return {
      value: realizedPnl(row.raw.quantity, row.raw.averageOpenPrice, row.raw.averageClosePrice),
      costBasis: row.raw.quantity * row.raw.averageOpenPrice,
      marketBased: false,
    };
  }
  return null;
}

function rowPnlPercent(figure: RowPnlFigure | null): number | null {
  return figure?.value === null || figure === null
    ? null
    : pnlPercentage(figure.value, figure.costBasis);
}

function pnlClass(value: number | null, trustworthy: boolean): string {
  if (value === null) return '';
  if (!trustworthy) return 'number-untrusted';
  return value >= 0 ? 'number-positive' : 'number-negative';
}

function CanceledTailNote({ chain }: { chain: BookChain }) {
  const blockedSells = chain.canceledRows.filter(
    (row) => row.direction === 'sell' && (row.quantity ?? 0) > (chain.sellableQuantity ?? 0),
  );
  if (blockedSells.length === 0) return null;
  const smallest = Math.min(...blockedSells.map((row) => row.quantity ?? 0));
  return (
    <span className="muted">
      none offers resend: each asks for at least {formatQuantity(smallest)} and only{' '}
      {formatQuantity(chain.sellableQuantity ?? 0)} shares are unclaimed
    </span>
  );
}

function groupChains(chains: readonly BookChain[]) {
  const dates = new Map<string, Map<string, BookChain[]>>();
  for (const chain of chains) {
    const date = chain.batchDate ?? 'unknown';
    const bots = dates.get(date) ?? new Map<string, BookChain[]>();
    const rows = bots.get(chain.botId) ?? [];
    rows.push(chain);
    bots.set(chain.botId, rows);
    dates.set(date, bots);
  }
  return [...dates.entries()].map(([date, bots]) => ({
    date,
    chains: [...bots.values()].flat(),
    bots: [...bots.entries()].map(([botId, botChains]) => ({ botId, chains: botChains })),
  }));
}
