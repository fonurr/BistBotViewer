import { CaretDown, CaretRight, Warning } from '@phosphor-icons/react';
import { memo, useEffect, useMemo, useRef, useState } from 'react';

import type { Account, Bot } from '../../bistApi/types';
import type { Quote } from '../../priceApi/types';
import { type BookChain, type BookChainRow, type BookScope } from '../../domain/chains';
import {
  formatDateKey,
  formatPercentage,
  formatQuantity,
  formatSlip,
  formatRowTimeParts,
  formatSignedNumber,
  formatNumber,
  plural,
  weekdayName,
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
import { orderActionsForRow, type OrderDialogAction } from './orderActions';

interface BookGridProps {
  chains: readonly BookChain[];
  bots: readonly Bot[];
  /**
   * The focused "no closing order" list is not a browse: it spans scopes on
   * purpose and carries its own heading, so it groups by bot alone.
   */
  showScopeHeadings?: boolean;
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
  const botById = useMemo(() => new Map(props.bots.map((bot) => [bot.id, bot])), [props.bots]);
  const accountById = useMemo(
    () => new Map(props.accounts.map((account) => [account.accountId, account])),
    [props.accounts],
  );
  const groups = useMemo(() => groupChains(props.chains), [props.chains]);
  // The P&L state reads every source the visible chains own, so it is derived
  // once per snapshot rather than once per render: it is the one figure on this
  // page that cannot be answered a row at a time.
  const pnlState = useMemo(() => {
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
    return deriveFilledPnlState(
      [...positions.values()],
      [...activeOrders.values()],
      [...closedTrades.values()],
    );
  }, [props.chains]);
  const [opened, setOpened] = useState<ReadonlySet<string>>(new Set());
  const [closed, setClosed] = useState<ReadonlySet<string>>(new Set());

  return (
    <div className="book-grid-wrap" role="table" aria-label="Order, position and trade chains">
      {groups.map((dateGroup, dateIndex) => {
        /*
         * The newest batch is the one being worked, so it opens itself and the
         * rest wait behind their chevron. Both sets are kept: `opened` is what
         * a reader asked for, `closed` is the newest batch they shut, and the
         * default follows the newest batch whatever the filters make it.
         */
        const openByDefault = dateIndex === 0;
        const open = openByDefault ? !closed.has(dateGroup.date) : opened.has(dateGroup.date);
        const toggle = () => {
          const target = dateGroup.date;
          if (open) {
            setOpened((current) => without(current, target));
            setClosed((current) => with_(current, target));
          } else {
            setOpened((current) => with_(current, target));
            setClosed((current) => without(current, target));
          }
        };
        return (
          <section className="book-date-group" role="rowgroup" key={dateGroup.date}>
            {/*
             * The batch heading comes first and the column band sits under it:
             * the columns belong to the batch they head, not to the whole page.
             */}
            <button
              type="button"
              className="book-date-heading"
              aria-expanded={open}
              onClick={toggle}
            >
              {open ? (
                <CaretDown size={14} weight="bold" aria-hidden="true" />
              ) : (
                <CaretRight size={14} weight="bold" aria-hidden="true" />
              )}
              <span className="book-batch-date">
                {dateGroup.date === 'unknown' ? 'Date unknown' : formatDateKey(dateGroup.date)}
              </span>
              <span className="kicker">
                batch{dateGroup.date === 'unknown' ? '' : ` · ${weekdayName(dateGroup.date)}`}
              </span>
              <span className="muted">{plural(dateGroup.chains.length, 'chain')}</span>
            </button>
            {open ? (
              <>
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
                        <span className="muted" title={account?.owner || undefined}>
                          {bot?.accountId ?? 'account unset'}
                          {bot?.brokerageId ? ` · ${bot.brokerageId}` : ''}
                        </span>
                        <span className="book-bot-rule" />
                      </header>
                      {botGroup.scopes.map((scopeGroup) => (
                        <section
                          className="book-scope-group"
                          role="presentation"
                          key={`${dateGroup.date}:${botGroup.botId}:${scopeGroup.scope}`}
                        >
                          {props.showScopeHeadings === false ? null : (
                            <ScopeHeading
                              scope={scopeGroup.scope}
                              chains={scopeGroup.chains}
                              pnlState={pnlState}
                              quotes={props.quotes}
                              pricesTrustworthy={props.pricesTrustworthy}
                            />
                          )}
                          {scopeGroup.chains.map((chain) => (
                            <ChainRows
                              chain={chain}
                              pnlState={pnlState}
                              quotes={props.quotes}
                              pricesTrustworthy={props.pricesTrustworthy}
                              writesHeldReason={props.writesHeldReason}
                              showCanceled={props.showCanceled}
                              canceledOpen={props.openCanceledChains.has(chain.key)}
                              now={now}
                              onToggleCanceledChain={props.onToggleCanceledChain}
                              onOpenChain={props.onOpenChain}
                              key={chain.key}
                            />
                          ))}
                        </section>
                      ))}
                    </section>
                  );
                })}
              </>
            ) : null}
          </section>
        );
      })}
    </div>
  );
}

function with_(current: ReadonlySet<string>, value: string): ReadonlySet<string> {
  if (current.has(value)) return current;
  const next = new Set(current);
  next.add(value);
  return next;
}

function without(current: ReadonlySet<string>, value: string): ReadonlySet<string> {
  if (!current.has(value)) return current;
  const next = new Set(current);
  next.delete(value);
  return next;
}

interface ChainRowsProps {
  chain: BookChain;
  pnlState: FilledPnlState;
  quotes: ReadonlyMap<string, Quote>;
  pricesTrustworthy: boolean;
  writesHeldReason: string | null;
  showCanceled: boolean;
  canceledOpen: boolean;
  now: number;
  onToggleCanceledChain: (chainKey: string) => void;
  onOpenChain: BookGridProps['onOpenChain'];
}

const ChainRows = memo(function ChainRows(props: ChainRowsProps) {
  const { chain } = props;
  // A scope selects whole chains, so every leg a chain owns is drawn once the
  // chain is in view. The only rows a toggle may withhold are the canceled
  // ones, and that is the canceled toggle's own job (SPEC 3).
  const nonCanceledRows = chain.rows.filter((row) => row.source !== 'canceled');
  const canceledRows = chain.canceledRows;
  const visibleCanceled = props.showCanceled !== props.canceledOpen;

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
        visibleCanceled ? (
          /*
           * Opened, the tail is the tinted block the rows sit inside, and its
           * note and `hide` sit beneath them rather than above.
           */
          <div className="canceled-tail canceled-tail-open">
            {canceledRows.map((row) => (
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
            ))}
            <div className="canceled-tail-footer">
              <span className="canceled-tail-notes">
                <CanceledTailNote chain={chain} />
              </span>
              <button
                type="button"
                className="btn btn-ghost canceled-tail-toggle"
                onClick={() => props.onToggleCanceledChain(chain.key)}
              >
                hide
              </button>
            </div>
          </div>
        ) : (
          <div className="canceled-tail canceled-tail-stub">
            <span className="book-spine status-dead" aria-hidden="true" />
            <div className="canceled-tail-summary">
              <strong>+{canceledTailLabel(canceledRows)}</strong>
              <span className="canceled-tail-notes">
                <CanceledTailNote chain={chain} />
              </span>
              <button
                type="button"
                className="btn btn-ghost canceled-tail-toggle"
                onClick={() => props.onToggleCanceledChain(chain.key)}
              >
                show
              </button>
            </div>
          </div>
        )
      ) : null}
    </article>
  );
});

/** `+3 canceled sells` where the tail is all one side, `+3 canceled` otherwise. */
function canceledTailLabel(rows: readonly BookChainRow[]): string {
  if (rows.length === 1) return '1 canceled';
  const sides = new Set(rows.map((row) => row.direction));
  const side = sides.size === 1 ? [...sides][0] : null;
  return `${rows.length} canceled${side === null ? '' : ` ${side}s`}`;
}

const BookRow = memo(function BookRow({
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
  const pnlFigure = bookRowPnlFigure(row, pnlState, quote?.son ?? null, opener ? chain : undefined);
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
  const status = bookRowPresentation(row, chain, now, opener);
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
        {opener ? (
          <button type="button" className="book-symbol" onClick={() => onOpenChain(chain)}>
            {row.symbol}
          </button>
        ) : (
          /*
           * A leg carries nothing here: the opener above already said the
           * symbol, and the chain's hairline says where the chain ends. Ids
           * are not a column at all — the chain dialog, opened from the
           * symbol, is where the chain id and every order id are read in
           * full. The symbol is still spoken, so a leg read on its own out of
           * the chain's `article` label still names its stock.
           */
          <span className="sr-only">{row.symbol}</span>
        )}
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
      {/*
       * What an order asked for is gray and what it got is in body ink: the
       * asked price is only the setting a row was sent with, and once it fills
       * the fill is the figure the slip and the p&l beside it are both read
       * off. A market order's captured price keeps its italic on top of that.
       */}
      <div
        role="cell"
        className={`align-right book-order-price${capturedPrice ? ' captured-value' : ''}`}
      >
        {row.orderPrice === null ? '' : formatNumber(row.orderPrice)}
      </div>
      <div role="cell" className="align-right book-fill-price">
        {row.averagePrice === null ? '' : formatNumber(row.averagePrice)}
      </div>
      <div role="cell" className="align-right book-slip">
        {slip === null ? '' : formatSlip(slip)}
      </div>
      <div role="cell" className={`align-right book-pnl ${pnlClass(pnl, pnlTrusted)}`}>
        {pnl === null ? (
          ''
        ) : (
          <>
            {formatSignedNumber(pnl, 0)}
            {pnlPercent === null ? null : <small> ({formatPercentage(pnlPercent)})</small>}
            {pnlTrusted ? null : <small className="pnl-note">last known</small>}
          </>
        )}
      </div>
      <div
        role="cell"
        className={row.source === 'scheduled' ? 'status-wait book-time' : 'muted book-time'}
      >
        <RowTime timestamp={orderTime} batchDate={batchDate} />
      </div>
      <div role="cell" className="muted book-time">
        <RowTime timestamp={row.acknowledgementTime} batchDate={batchDate} />
      </div>
      <div
        role="cell"
        /* A settled row's word stays in body ink; only its spine is --st-done,
           the way the reference draws a closed chain. */
        className={`book-status ${status.role === 'done' ? '' : statusClass(status.role)}`}
      >
        {status.exposed ? <Warning size={14} weight="fill" aria-hidden="true" /> : null}
        <span>
          {status.label}
          {status.detail ? <span className="muted"> · {status.detail}</span> : null}
        </span>
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
      {status.notes && status.notes.length > 0 ? (
        <div className="book-row-notes" role="cell">
          {status.notes.map((note) => (
            <span className={note.tone === 'wait' ? 'status-wait' : 'muted'} key={note.text}>
              {note.text}
            </span>
          ))}
        </div>
      ) : null}
    </div>
  );
});

/*
 * The minute is what a reader scans down the column; the seconds only settle
 * which of two orders in that minute came first, so they and their colon are
 * drawn at half strength behind it. A missing time stays an empty cell.
 */
function RowTime({ timestamp, batchDate }: { timestamp: number | null; batchDate: string }) {
  const parts = formatRowTimeParts(timestamp, batchDate);
  if (parts === null) return null;
  return (
    <>
      {parts.minute}
      <span className="book-time-seconds">{parts.seconds}</span>
    </>
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

function actionLabel(kind: OrderDialogAction['kind']): string {
  if (kind === 'fire') return 'fire now';
  return kind;
}

export interface RowPnlFigure {
  value: number | null;
  costBasis: number;
  marketBased: boolean;
}

interface PnlIndex {
  readonly exposures: ReadonlyMap<string, FilledPnlState['exposures'][number]>;
  readonly partialSells: ReadonlyMap<number, FilledPnlState['partialSellFills'][number]>;
}

/*
 * A row asks the P&L state exactly one question about itself, and an open batch
 * can hold hundreds of rows: scanning the exposures per row made the grid
 * quadratic in the batch. The index is derived once per state object and kept
 * beside it, so `bookRowPnlFigure` keeps its plain signature.
 */
const pnlIndexes = new WeakMap<FilledPnlState, PnlIndex>();

function indexPnlState(state: FilledPnlState): PnlIndex {
  const known = pnlIndexes.get(state);
  if (known) return known;
  const index: PnlIndex = {
    exposures: new Map(
      state.exposures.map((exposure) => [`${exposure.source}:${exposure.sourceId}`, exposure]),
    ),
    partialSells: new Map(state.partialSellFills.map((fill) => [fill.sourceId, fill])),
  };
  pnlIndexes.set(state, index);
  return index;
}

/** The round trip a chain's own row carries, derived once per chain. */
const roundTrips = new WeakMap<BookChain, RowPnlFigure | null>();

function chainRoundTrip(chain: BookChain): RowPnlFigure | null {
  const known = roundTrips.get(chain);
  if (known !== undefined) return known;
  const trades = new Map(chain.sources.closedTrades.map((trade) => [trade.id, trade] as const));
  let figure: RowPnlFigure | null = null;
  if (trades.size > 0) {
    let value = 0;
    let costBasis = 0;
    for (const trade of trades.values()) {
      value += realizedPnl(trade.quantity, trade.averageOpenPrice, trade.averageClosePrice);
      costBasis += trade.quantity * trade.averageOpenPrice;
    }
    figure = { value, costBasis, marketBased: false };
  }
  roundTrips.set(chain, figure);
  return figure;
}

export function bookRowPnlFigure(
  row: BookChainRow,
  pnlState: FilledPnlState,
  marketPrice: number | null,
  /** Present on a chain's own row, which carries the whole round trip (SPEC 3). */
  openerChain?: BookChain,
): RowPnlFigure | null {
  if (row.source === 'closed-trade' && row.leg === 'open' && openerChain) {
    return chainRoundTrip(openerChain);
  }
  const index = indexPnlState(pnlState);
  if (row.source === 'position') {
    const exposure = index.exposures.get(`position:${row.raw.id}`);
    if (!exposure) return null;
    return {
      value: marketPrice === null ? null : unrealizedPnl(exposure, marketPrice),
      costBasis: exposure.quantity * exposure.averagePrice,
      marketBased: true,
    };
  }
  if (row.source === 'active' && row.direction === 'buy') {
    const exposure = index.exposures.get(`partial-buy:${row.raw.id}`);
    if (!exposure) return null;
    return {
      value: marketPrice === null ? null : unrealizedPnl(exposure, marketPrice),
      costBasis: exposure.quantity * exposure.averagePrice,
      marketBased: true,
    };
  }
  if (row.source === 'active' && row.direction === 'sell') {
    const fill = index.partialSells.get(row.raw.id);
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
  const smallest = blockedSells.length
    ? Math.min(...blockedSells.map((row) => row.quantity ?? 0))
    : null;
  return (
    <>
      <span className="muted">{canceledByCopy(chain.canceledRows)}</span>
      {smallest === null ? null : (
        <span className="muted">
          none offers resend: each asks for at least {formatQuantity(smallest)} and only{' '}
          {formatQuantity(chain.sellableQuantity ?? 0)} shares are unclaimed
        </span>
      )}
    </>
  );
}

const CANCELED_BY: Record<string, string> = {
  CanceledByBot: 'by bot',
  CanceledByUser: 'by user',
  CanceledByServer: 'by server',
  Canceled: 'by the exchange',
  Expired: 'expired',
  Rejected: 'rejected',
  Skipped: 'skipped',
  SkippedForNow: 'skipped for now',
};

/** `2 by the exchange . 1 by bot` — what the rows above cannot say at a glance. */
function canceledByCopy(rows: readonly BookChainRow[]): string {
  const counts = new Map<string, number>();
  for (const row of rows) {
    const word = CANCELED_BY[row.status] ?? 'unconfirmed';
    counts.set(word, (counts.get(word) ?? 0) + 1);
  }
  return [...counts.entries()].map(([word, count]) => `${count} ${word}`).join(' · ');
}

/**
 * Grouping is date -> bot -> scope, and the scope line opens its own group
 * rather than sitting in a strip above the page: the reference draws
 * `waiting  3 chains - 6 buy orders, nothing bought yet` immediately before
 * the chains it counts, under the bot that owns them.
 */
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
    bots: [...bots.entries()].map(([botId, botChains]) => ({
      botId,
      chains: botChains,
      scopes: SCOPE_ORDER.flatMap((scope) => {
        const scoped = botChains.filter((chain) => chain.scope === scope);
        return scoped.length === 0 ? [] : [{ scope, chains: scoped }];
      }),
    })),
  }));
}

const SCOPE_ORDER: readonly BookScope[] = ['waiting', 'positions', 'trades', 'canceled'];

function ScopeHeading({
  scope,
  chains,
  pnlState,
  quotes,
  pricesTrustworthy,
}: {
  scope: BookScope;
  chains: readonly BookChain[];
  pnlState: FilledPnlState;
  quotes: ReadonlyMap<string, Quote>;
  pricesTrustworthy: boolean;
}) {
  const summary = scopeGroupSummary(scope, chains, pnlState, quotes, pricesTrustworthy);
  return (
    <header className="book-scope-heading">
      <span className="kicker">{scope}</span>
      <span className="muted">
        {plural(chains.length, 'chain')} · {summary.detail}
      </span>
      {summary.aggregate === null ? null : (
        <span className={summary.tone}>{summary.aggregate}</span>
      )}
      {summary.note ? <span className="muted">· {summary.note}</span> : null}
      <i />
    </header>
  );
}

export function scopeGroupSummary(
  scope: BookScope,
  chains: readonly BookChain[],
  pnlState: FilledPnlState,
  quotes: ReadonlyMap<string, Quote>,
  pricesTrustworthy: boolean,
): { detail: string; aggregate: string | null; note?: string; tone: string } {
  if (scope === 'waiting') {
    const waitingRows = chains.flatMap((chain) => chain.activeRows.filter((row) => row.isWaiting));
    // `6 buy orders` reads better than `6 waiting orders` when they all go
    // one way, and the side is the fact worth stating.
    const sides = new Set(waitingRows.map((row) => row.direction));
    const noun = sides.size === 1 ? `${[...sides][0]} order` : 'waiting order';
    return {
      detail: `${plural(waitingRows.length, noun)}, nothing bought yet`,
      aggregate: null,
      tone: 'muted',
    };
  }

  if (scope === 'positions') {
    // Ids are only unique within their own source table, so an exposure is
    // matched on both its source and its id.
    const exposureKeys = new Set([
      ...chains.flatMap((chain) => chain.positionRows.map((row) => `position:${row.rawId}`)),
      ...chains.flatMap((chain) => chain.activeRows.map((row) => `partial-buy:${row.rawId}`)),
    ]);
    let unrealized = 0;
    let everyPriceKnown = true;
    for (const exposure of pnlState.exposures) {
      if (!exposureKeys.has(`${exposure.source}:${exposure.sourceId}`)) continue;
      const marketPrice = quotes.get(exposure.symbol)?.son;
      if (marketPrice === null || marketPrice === undefined) everyPriceKnown = false;
      else unrealized += unrealizedPnl(exposure, marketPrice);
    }
    return {
      detail: 'bought, not yet sold · unrealized',
      aggregate: everyPriceKnown
        ? `${formatSignedNumber(unrealized)}${pricesTrustworthy ? '' : ' · last known'}`
        : 'not available',
      tone: !everyPriceKnown
        ? 'status-warn'
        : !pricesTrustworthy
          ? 'number-untrusted'
          : unrealized >= 0
            ? 'number-positive'
            : 'number-negative',
    };
  }

  if (scope === 'trades') {
    const trades = new Map(
      chains.flatMap((chain) => chain.sources.closedTrades).map((trade) => [trade.id, trade]),
    );
    const realized = [...trades.values()].reduce(
      (total, trade) =>
        total + realizedPnl(trade.quantity, trade.averageOpenPrice, trade.averageClosePrice),
      0,
    );
    return {
      detail: 'bought and sold · realized',
      aggregate: formatSignedNumber(realized),
      // A trades chain draws every order it ever had, and the settled ones sit
      // in --st-done; the heading says so once rather than per row.
      note: 'every order in the chain, gray where it filled',
      tone: realized >= 0 ? 'number-positive' : 'number-negative',
    };
  }

  return {
    detail: 'never opened a position, nobody retried it',
    aggregate: null,
    tone: 'muted',
  };
}
