import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';

import type { Account, Bot } from '../../bistApi/types';
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
  const [symbolQuery, setSymbolQuery] = useState('');
  const symbolInputRef = useRef<HTMLInputElement>(null);
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
  const matchingSymbols = useMemo(() => {
    const query = symbolQuery.trim().toUpperCase();
    if (!query) return allSymbols;
    return [...allSymbols]
      .sort((left, right) => {
        const leftPrefix = left.startsWith(query) ? 0 : 1;
        const rightPrefix = right.startsWith(query) ? 0 : 1;
        if (leftPrefix !== rightPrefix) return leftPrefix - rightPrefix;
        return left.localeCompare(right);
      })
      .filter((symbol) => symbol.includes(query));
  }, [allSymbols, symbolQuery]);
  const batchDates = useMemo(
    () =>
      [
        ...new Set(props.chains.flatMap((chain) => (chain.batchDate ? [chain.batchDate] : []))),
      ].sort(),
    [props.chains],
  );

  useEffect(() => {
    if (open === 'symbols') requestAnimationFrame(() => symbolInputRef.current?.focus());
  }, [open]);

  const toggleScope = (scope: BookScope) => {
    const next = new Set(filters.scopes);
    if (next.has(scope)) next.delete(scope);
    else next.add(scope);
    onChange({ ...filters, scopes: next, noClosingOrder: false });
  };

  const toggleSetValue = (
    key: 'botIds' | 'accountIds',
    value: string,
    universe: readonly string[],
  ) => {
    const current = filters[key] === null ? new Set(universe) : new Set(filters[key]);
    if (current.has(value)) current.delete(value);
    else current.add(value);
    onChange({ ...filters, [key]: current, noClosingOrder: false });
  };

  const toggleSymbol = (symbol: string) => {
    const next = new Set(filters.symbols);
    if (next.has(symbol)) next.delete(symbol);
    else next.add(symbol);
    onChange({ ...filters, symbols: next, noClosingOrder: false });
  };

  const handleSymbolKey = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter' && matchingSymbols[0]) {
      event.preventDefault();
      toggleSymbol(matchingSymbols[0]);
    }
    if (event.key === 'Escape') {
      if (symbolQuery) {
        event.stopPropagation();
        setSymbolQuery('');
      }
    }
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

  const botLabel = selectionLabel(filters.botIds, props.bots.length, 'bot', 'bots');
  const accountLabel = selectionLabel(
    filters.accountIds,
    props.accounts.length,
    'account',
    'accounts',
  );
  const symbolLabel =
    filters.symbols.size === 0 ? 'All symbols' : plural(filters.symbols.size, 'symbol');
  const dateLabel =
    filters.batchFrom === null && filters.batchTo === null
      ? 'Every batch'
      : `${filters.batchFrom ? formatDateKey(filters.batchFrom) : 'first'} → ${
          filters.batchTo ? formatDateKey(filters.batchTo) : 'latest'
        }`;

  return (
    <>
      {props.noClosingOrderCount > 0 || props.mismatchCount > 0 ? (
        <div className="human-banner" role="status">
          <span className="human-total">
            {props.noClosingOrderCount + props.mismatchCount === 1
              ? '1 needs a human'
              : `${props.noClosingOrderCount + props.mismatchCount} need a human`}
          </span>
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
          <span className="human-unfiltered">
            never filtered · these stay visible whatever the toolbar says
          </span>
        </div>
      ) : null}
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
        <FilterPopover name="bots" label={botLabel} open={open === 'bots'} setOpen={setOpen}>
          <PopoverHeading
            label="bots with rows in this window"
            action="all"
            onAction={() => onChange({ ...filters, botIds: null, noClosingOrder: false })}
          />
          {props.bots.map((bot) => (
            <label className="filter-option filter-option-counted" key={bot.id}>
              <input
                type="checkbox"
                checked={filters.botIds === null || filters.botIds.has(bot.id)}
                onChange={() =>
                  toggleSetValue(
                    'botIds',
                    bot.id,
                    props.bots.map((value) => value.id),
                  )
                }
              />
              <span>
                {bot.id}
                {bot.accountId && bot.brokerageId ? (
                  <span className="muted">
                    {' '}
                    · {bot.accountId} · {bot.brokerageId}
                  </span>
                ) : null}
              </span>
              <span className="filter-count">{chainCountByBot.get(bot.id) ?? 0}</span>
            </label>
          ))}
          <p className="filter-help">
            Hiding a bot hides its chains, never the needs-a-human count above.
          </p>
        </FilterPopover>
        <FilterPopover
          name="accounts"
          label={accountLabel}
          open={open === 'accounts'}
          setOpen={setOpen}
        >
          <PopoverHeading label="accounts" />
          {props.accounts.map((account) => {
            const key = accountIdentityKey(account.accountId, account.brokerageId);
            return (
              <label className="filter-option" key={key}>
                <input
                  type="checkbox"
                  checked={filters.accountIds === null || filters.accountIds.has(key)}
                  onChange={() =>
                    toggleSetValue(
                      'accountIds',
                      key,
                      props.accounts.map((value) =>
                        accountIdentityKey(value.accountId, value.brokerageId),
                      ),
                    )
                  }
                />
                <span>
                  {account.accountId} · {account.brokerageId}
                  {account.owner ? <span className="muted"> · {account.owner}</span> : null}
                </span>
              </label>
            );
          })}
          {props.bots.some(
            (bot) =>
              bot.accountId &&
              bot.brokerageId &&
              !accountByKey.has(accountIdentityKey(bot.accountId, bot.brokerageId)),
          ) ? (
            <p className="filter-help status-warn">
              Some bot account labels are not in GetAccounts.
            </p>
          ) : null}
        </FilterPopover>
        <FilterPopover
          name="symbols"
          label={symbolLabel}
          open={open === 'symbols'}
          setOpen={setOpen}
          className="symbol-filter"
          onEscape={() => {
            if (symbolQuery) {
              setSymbolQuery('');
              return false;
            }
            return true;
          }}
        >
          <PopoverHeading
            label="symbols in the book"
            action="clear"
            onAction={() =>
              onChange({ ...filters, symbols: new Set<string>(), noClosingOrder: false })
            }
          />
          <input
            ref={symbolInputRef}
            className="input symbol-search"
            value={symbolQuery}
            onChange={(event) => setSymbolQuery(event.target.value.toUpperCase())}
            onKeyDown={handleSymbolKey}
            placeholder="filter · enter toggles"
            aria-label="Filter symbols"
          />
          <div className="symbol-options">
            {matchingSymbols.map((symbol, index) => (
              <button
                type="button"
                className={`tag symbol-option${filters.symbols.has(symbol) ? ' tag-accent' : ' tag-neutral'}${
                  symbolQuery && index === 0 ? ' symbol-enter-target' : ''
                }`}
                key={symbol}
                onClick={() => toggleSymbol(symbol)}
              >
                {symbol}
              </button>
            ))}
          </div>
          {matchingSymbols.length === 0 ? (
            <p className="filter-help">
              No symbol in the book matches <span className="book-inline-value">{symbolQuery}</span>
              . The list only holds symbols the loaded batches traded.
            </p>
          ) : null}
        </FilterPopover>
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
          <p className="filter-help">These are batch dates, not calendar days.</p>
        </FilterPopover>
        <span className="book-toolbar-spacer" />
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

function selectionLabel(
  values: ReadonlySet<string> | null,
  total: number,
  one: string,
  many: string,
): string {
  if (values === null || values.size === total) return `All ${many}`;
  if (values.size === 1) return `1 ${one}`;
  return `${values.size} ${many}`;
}

function countBy<T>(values: readonly T[], key: (value: T) => string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(key(value), (counts.get(key(value)) ?? 0) + 1);
  return counts;
}
