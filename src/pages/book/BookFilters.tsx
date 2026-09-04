import { Warning } from '@phosphor-icons/react';
import { useMemo, useState } from 'react';

import type { Account, Bot } from '../../bistApi/types';
import {
  accountOptions,
  botPicks,
  MultiSelectFilter,
  SymbolFilter,
  type FilterOption,
} from '../../components/EntityFilters';
import { DateRangeFilter } from '../../components/DateRangeFilter';
import { PopoverScrim } from '../../components/FilterPopover';
import { accountIdentityKey } from '../../domain/accounts';
import { rowReasons, type BookChain, type BookScope } from '../../domain/chains';
import { plural } from '../../domain/format';
import { displayStatus } from '../../domain/status';
import { scopeLabels, type BookFilterState } from './types';

interface BookFiltersProps {
  filters: BookFilterState;
  onChange: (filters: BookFilterState) => void;
  bots: readonly Bot[];
  accounts: readonly Account[];
  chains: readonly BookChain[];
  noClosingOrderCount: number;
  mismatchCount: number;
  canceledCount: number;
  canceledVisible: boolean;
  manualOpenLegs: number;
  manualClosedChains: number;
  onToggleCanceled: () => void;
  onOpenMismatch: () => void;
}

const scopes: readonly BookScope[] = ['waiting', 'positions', 'trades', 'canceled'];

export function BookFilters(props: BookFiltersProps) {
  const { filters, onChange } = props;
  const [open, setOpen] = useState<string | null>(null);
  const accountByKey = useMemo(
    () =>
      new Map(
        props.accounts.map((account) => [
          accountIdentityKey(account.accountId, account.brokerageId),
          account,
        ]),
      ),
    [props.accounts],
  );
  const chainCountByBot = useMemo(
    () => countBy(props.chains, (chain) => chain.botId),
    [props.chains],
  );
  const allSymbols = useMemo(
    () => [...new Set(props.chains.map((chain) => chain.symbol))].sort(),
    [props.chains],
  );
  const batchDates = useMemo(
    () =>
      [
        ...new Set(props.chains.flatMap((chain) => (chain.batchDate ? [chain.batchDate] : []))),
      ].sort(),
    [props.chains],
  );
  const canceledStatuses = useMemo(() => canceledStatusOptions(props.chains), [props.chains]);
  const reasons = useMemo(() => reasonOptions(props.chains), [props.chains]);
  const sources = useMemo(() => sourceOptions(props.chains), [props.chains]);

  const toggleScope = (scope: BookScope) => {
    const next = new Set(filters.scopes);
    if (next.has(scope)) next.delete(scope);
    else next.add(scope);
    onChange({ ...filters, scopes: next, noClosingOrder: false });
  };

  const setNoExit = () => {
    if (filters.noClosingOrder) {
      onChange({ ...filters, noClosingOrder: false });
      return;
    }
    onChange({
      ...filters,
      scopes: new Set<BookScope>(['waiting', 'positions']),
      botIds: null,
      accountIds: null,
      symbols: new Set<string>(),
      canceledStatusFilter: false,
      canceledStatuses: null,
      reasonFilter: false,
      reasons: null,
      sourceFilter: false,
      sources: null,
      batchFrom: null,
      batchTo: null,
      noClosingOrder: true,
    });
  };

  return (
    <>
      <div className="book-toolbar">
        <div className="seg" aria-label="Book scopes">
          {scopes.map((scope) => (
            <label className="seg-opt" key={scope}>
              <input
                type="checkbox"
                checked={filters.scopes.has(scope)}
                onChange={() => toggleScope(scope)}
              />
              <span>{scopeLabels[scope]}</span>
            </label>
          ))}
        </div>
        <MultiSelectFilter
          name="bots"
          open={open === 'bots'}
          setOpen={setOpen}
          heading="bots with rows in this window"
          options={props.bots.map((bot) => ({
            key: bot.id,
            label: (
              <>
                {bot.id}
                {bot.accountId && bot.brokerageId ? (
                  <span className="muted">
                    {' '}
                    · {bot.accountId} · {bot.brokerageId}
                  </span>
                ) : null}
              </>
            ),
            count: chainCountByBot.get(bot.id) ?? 0,
          }))}
          picks={botPicks(props.bots)}
          selected={filters.botIds}
          onChange={(botIds) => onChange({ ...filters, botIds, noClosingOrder: false })}
          one="bot"
          many="bots"
          note="Hiding a bot hides its chains, never the red count above — a position with no exit needs a human whether its bot is in view or not."
        />
        <MultiSelectFilter
          name="accounts"
          open={open === 'accounts'}
          setOpen={setOpen}
          heading="accounts"
          help="One chain sits under one account. The mismatch in the red banner is a chain whose orders name two — it shows under both."
          options={accountOptions(props.accounts)}
          selected={filters.accountIds}
          onChange={(accountIds) => onChange({ ...filters, accountIds, noClosingOrder: false })}
          one="account"
          many="accounts"
          note={
            props.bots.some(
              (bot) =>
                bot.accountId &&
                bot.brokerageId &&
                !accountByKey.has(accountIdentityKey(bot.accountId, bot.brokerageId)),
            ) ? (
              <span className="status-warn">Some bot account labels are not in GetAccounts.</span>
            ) : undefined
          }
        />
        <SymbolFilter
          open={open === 'symbols'}
          setOpen={setOpen}
          heading="symbols in the book"
          symbols={allSymbols}
          selected={filters.symbols}
          onChange={(symbols) => onChange({ ...filters, symbols, noClosingOrder: false })}
          keptNote={(count, list) => (
            /* The one fact that prevents a wrong reading: the filter is per
               chain, not per row, so a chain with one matching leg stays. */
            <>
              {plural(count, 'symbol')} kept: {list}. A chain qualifies if any of its orders is one
              of them.
            </>
          )}
          emptyNote="The list only holds symbols the loaded batches traded."
        />
        {canceledStatuses.length > 0 ? (
          <MultiSelectFilter
            name="canceled-statuses"
            open={open === 'canceled-statuses'}
            setOpen={setOpen}
            heading="statuses on canceled orders"
            help="Every status the loaded canceled orders carry, whichever bots the rest of the toolbar keeps — this list never follows the other filters."
            options={canceledStatuses}
            picks={[{ label: 'none', select: new Set<string>() }]}
            active={props.filters.canceledStatusFilter}
            onActiveChange={(active) =>
              /* Off pins the selection back to every status, so the ticked,
                 disabled boxes are telling the truth rather than hiding a
                 narrowing that would spring back on. */
              onChange({
                ...filters,
                canceledStatusFilter: active,
                canceledStatuses: null,
                noClosingOrder: false,
              })
            }
            activeLabel="filter"
            inactiveLabel="any status"
            selected={filters.canceledStatuses}
            onChange={(canceledStatuses) =>
              onChange({ ...filters, canceledStatuses, noClosingOrder: false })
            }
            one="status"
            many="statuses"
            note="On, the Book keeps a chain only where one of its own canceled orders carries a ticked status — and then draws the whole chain, canceled legs and all. A chain that never lost a leg has nothing to match, so it drops out even with every status ticked."
          />
        ) : null}
        {reasons.length > 0 ? (
          <MultiSelectFilter
            name="reasons"
            open={open === 'reasons'}
            setOpen={setOpen}
            heading="reasons on the loaded rows"
            help="The server's own keys for why — why an order exists, why one ended, why a cancel is in flight, and why a position was closed. Every key the loaded book carries, whichever bots the rest of the toolbar keeps."
            options={reasons}
            picks={[{ label: 'none', select: new Set<string>() }]}
            active={props.filters.reasonFilter}
            onActiveChange={(active) =>
              /* Off pins the selection back to every reason, for the same cause
                 as the status filter above: the ticked, disabled boxes have to
                 be telling the truth. */
              onChange({
                ...filters,
                reasonFilter: active,
                reasons: null,
                noClosingOrder: false,
              })
            }
            activeLabel="filter"
            inactiveLabel="any reason"
            selected={filters.reasons}
            onChange={(reasons) => onChange({ ...filters, reasons, noClosingOrder: false })}
            one="reason"
            many="reasons"
            note="On, the Book keeps a chain where any one of its rows — live, scheduled, canceled or the sell that closed a trade — carries a ticked reason, and then draws the whole chain. A chain the server recorded no reason for has nothing to match, so it drops out even with every reason ticked."
          />
        ) : null}
        {sources.length > 0 ? (
          <MultiSelectFilter
            name="sources"
            open={open === 'sources'}
            setOpen={setOpen}
            heading="who ended the loaded orders"
            help="The server's own keys for who: `Broker` is Matriks or the exchange, `Bot` the calling bot, `Server` a guard or an exit this server decided, `User` a person in the MatriksIQ terminal. Every key the loaded book carries, whichever bots the rest of the toolbar keeps."
            options={sources}
            picks={[{ label: 'none', select: new Set<string>() }]}
            active={props.filters.sourceFilter}
            onActiveChange={(active) =>
              onChange({
                ...filters,
                sourceFilter: active,
                sources: null,
                noClosingOrder: false,
              })
            }
            activeLabel="filter"
            inactiveLabel="any source"
            selected={filters.sources}
            onChange={(sources) => onChange({ ...filters, sources, noClosingOrder: false })}
            one="source"
            many="sources"
            note="On, the Book keeps a chain only where one of its own dead orders names a ticked source, and then draws the whole chain. Only a stored death names who ended it, so a chain whose legs all still live has nothing to match and drops out even with every source ticked."
          />
        ) : null}
        <DateRangeFilter
          open={open === 'dates'}
          setOpen={setOpen}
          align="right"
          dates={batchDates}
          range={{ from: filters.batchFrom, to: filters.batchTo }}
          onChange={(range) =>
            onChange({
              ...filters,
              batchFrom: range.from,
              batchTo: range.to,
              noClosingOrder: false,
            })
          }
          note="These are batch dates, not calendar days — a session where no bot ran has no batch and simply is not in the list."
        />
        <span className="book-toolbar-spacer" />
        {props.noClosingOrderCount > 0 || props.mismatchCount > 0 ? (
          <div className="human-banner" role="status">
            <Warning size={14} weight="fill" aria-hidden="true" />
            <span className="human-total">
              {props.noClosingOrderCount + props.mismatchCount === 1
                ? '1 needs a human'
                : `${props.noClosingOrderCount + props.mismatchCount} need a human`}
            </span>
            <span className="human-divider" aria-hidden="true" />
            {props.noClosingOrderCount > 0 ? (
              <button type="button" onClick={setNoExit} aria-pressed={filters.noClosingOrder}>
                {plural(props.noClosingOrderCount, 'position')} with no closing order
              </button>
            ) : null}
            {props.mismatchCount > 0 ? (
              <button type="button" onClick={props.onOpenMismatch}>
                {plural(props.mismatchCount, 'account mismatch', 'account mismatches')}
              </button>
            ) : null}
            {/* SPEC 3: the counts are never filtered, and the word says so once. */}
            <span className="human-unfiltered">unfiltered</span>
          </div>
        ) : null}
        {props.canceledCount > 0 ? (
          <button
            type="button"
            className={`canceled-global${props.canceledVisible ? ' is-open' : ''}`}
            onClick={props.onToggleCanceled}
          >
            {props.canceledVisible
              ? `${plural(props.canceledCount, 'canceled order')} shown${
                  props.manualClosedChains
                    ? ` · ${plural(props.manualClosedChains, 'chain')} closed by hand`
                    : ''
                }`
              : `${plural(props.canceledCount, 'canceled order')} hidden${
                  props.manualOpenLegs ? ` · ${props.manualOpenLegs} shown by hand` : ''
                }`}
          </button>
        ) : null}
      </div>
      {open ? <PopoverScrim onClose={() => setOpen(null)} /> : null}
    </>
  );
}

/**
 * The statuses the loaded canceled orders actually carry, in the display form
 * the status cells print, each counting the chains it would keep. Raw wire
 * values that share a display form share one option: a reader ticks what they
 * can see in the column, and `Canceled` and `CanceledByUser` are two different
 * words there, while every unrecognized value is the one `Unconfirmed`.
 */
export function canceledStatusOptions(chains: readonly BookChain[]): FilterOption[] {
  const chainsByStatus = new Map<string, number>();
  for (const chain of chains) {
    const statuses = new Set(chain.canceledRows.map((row) => displayStatus(row.status)));
    for (const status of statuses)
      chainsByStatus.set(status, (chainsByStatus.get(status) ?? 0) + 1);
  }
  return [...chainsByStatus.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([status, count]) => ({ key: status, label: status, count }));
}

/**
 * Every reason key the loaded rows actually carry, in the server's own form —
 * these are keys, not prose, so they are ticked exactly as the status cell
 * prints them. Each option counts the chains it would keep, never the rows: one
 * chain whose buy and reversing sell both died of `BuyGuard` is one chain.
 */
export function reasonOptions(chains: readonly BookChain[]): FilterOption[] {
  const chainsByReason = new Map<string, number>();
  for (const chain of chains) {
    const reasons = new Set(chain.rows.flatMap(rowReasons));
    for (const reason of reasons) chainsByReason.set(reason, (chainsByReason.get(reason) ?? 0) + 1);
  }
  return [...chainsByReason.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([reason, count]) => ({ key: reason, label: reason, count }));
}

/**
 * Every source key the loaded rows name, in the server's own form. Only a
 * stored death carries one — nothing says who is behind a live order — so this
 * list is built from the canceled legs, and each option counts the chains it
 * would keep rather than the legs.
 */
export function sourceOptions(chains: readonly BookChain[]): FilterOption[] {
  const chainsBySource = new Map<string, number>();
  for (const chain of chains) {
    const sources = new Set(
      chain.rows.flatMap((row) => (row.statusSource === null ? [] : [row.statusSource])),
    );
    for (const source of sources) chainsBySource.set(source, (chainsBySource.get(source) ?? 0) + 1);
  }
  return [...chainsBySource.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([source, count]) => ({ key: source, label: source, count }));
}

function countBy<T>(values: readonly T[], key: (value: T) => string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(key(value), (counts.get(key(value)) ?? 0) + 1);
  return counts;
}
