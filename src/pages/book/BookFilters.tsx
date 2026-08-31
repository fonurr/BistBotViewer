import { Warning } from '@phosphor-icons/react';
import { useMemo, useState } from 'react';

import type { Account, Bot } from '../../bistApi/types';
import {
  accountOptions,
  botPicks,
  MultiSelectFilter,
  SymbolFilter,
} from '../../components/EntityFilters';
import { FilterPopover, PopoverHeading, PopoverScrim } from '../../components/FilterPopover';
import { accountIdentityKey } from '../../domain/accounts';
import type { BookChain, BookScope } from '../../domain/chains';
import { formatDateKey, plural } from '../../domain/format';
import type { BookFilterState } from './types';

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

const scopes: Array<{ key: BookScope; label: string }> = [
  { key: 'waiting', label: 'Waiting' },
  { key: 'positions', label: 'Positions' },
  { key: 'trades', label: 'Trades' },
  { key: 'canceled', label: 'Canceled' },
];

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
      batchFrom: null,
      batchTo: null,
      noClosingOrder: true,
    });
  };

  const dateLabel =
    filters.batchFrom === null && filters.batchTo === null
      ? 'Every batch'
      : `${filters.batchFrom ? formatDateKey(filters.batchFrom) : 'first'} → ${
          filters.batchTo ? formatDateKey(filters.batchTo) : 'latest'
        }`;

  return (
    <>
      <div className="book-toolbar">
        <div className="seg" aria-label="Book scopes">
          {scopes.map((scope) => (
            <label className="seg-opt" key={scope.key}>
              <input
                type="checkbox"
                checked={filters.scopes.has(scope.key)}
                onChange={() => toggleScope(scope.key)}
              />
              <span>{scope.label}</span>
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
        <FilterPopover
          name="dates"
          label={dateLabel}
          open={open === 'dates'}
          setOpen={setOpen}
          align="right"
        >
          <PopoverHeading label="batch range" />
          <button
            type="button"
            className="filter-preset"
            onClick={() => {
              const today = batchDates.at(-1) ?? null;
              onChange({ ...filters, batchFrom: today, batchTo: today, noClosingOrder: false });
            }}
          >
            <span>Latest batch</span>
            <span className="filter-count">{batchDates.at(-1) ? '1 batch' : 'none'}</span>
          </button>
          <button
            type="button"
            className="filter-preset"
            onClick={() =>
              onChange({
                ...filters,
                batchFrom: batchDates.at(-5) ?? batchDates[0] ?? null,
                batchTo: batchDates.at(-1) ?? null,
                noClosingOrder: false,
              })
            }
          >
            <span>Last 5 sessions</span>
            <span className="filter-count">
              {plural(Math.min(5, batchDates.length), 'batch', 'batches')}
            </span>
          </button>
          <button
            type="button"
            className="filter-preset"
            onClick={() =>
              onChange({ ...filters, batchFrom: null, batchTo: null, noClosingOrder: false })
            }
          >
            <span>Everything</span>
            <span className="filter-count">{plural(batchDates.length, 'batch', 'batches')}</span>
          </button>
          <div className="date-fields">
            <label className="field">
              <span>From</span>
              <input
                className="input"
                type="date"
                value={filters.batchFrom ?? ''}
                min={batchDates[0]}
                max={filters.batchTo ?? batchDates.at(-1)}
                onChange={(event) =>
                  onChange({
                    ...filters,
                    batchFrom: event.target.value || null,
                    noClosingOrder: false,
                  })
                }
              />
            </label>
            <label className="field">
              <span>To</span>
              <input
                className="input"
                type="date"
                value={filters.batchTo ?? ''}
                min={filters.batchFrom ?? batchDates[0]}
                max={batchDates.at(-1)}
                onChange={(event) =>
                  onChange({
                    ...filters,
                    batchTo: event.target.value || null,
                    noClosingOrder: false,
                  })
                }
              />
            </label>
          </div>
          <p className="filter-help">
            These are batch dates, not calendar days — a session where no bot ran has no batch and
            simply is not in the list.
          </p>
        </FilterPopover>
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

function countBy<T>(values: readonly T[], key: (value: T) => string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(key(value), (counts.get(key(value)) ?? 0) + 1);
  return counts;
}
