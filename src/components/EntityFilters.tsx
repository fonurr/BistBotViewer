import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';

import type { Account, Bot } from '../bistApi/types';
import { accountIdentityKey } from '../domain/accounts';
import { plural } from '../domain/format';
import { FilterPopover, PopoverHeading } from './FilterPopover';

export interface FilterOption {
  key: string;
  label: ReactNode;
  /** Rows behind this option in the current window. Omitted where there is no count to give. */
  count?: number;
}

/**
 * `null` is every option, which is not the same set as "all of them ticked": a
 * page that gains a bot keeps meaning *every bot* until someone narrows it.
 */
export type FilterSelection = ReadonlySet<string> | null;

/**
 * A whole-set shortcut offered beside `all`, for a split the page can name
 * itself — `active` and `inactive` over a bot list. It states the resulting
 * selection outright rather than a predicate, so the component never has to
 * know what a bot is.
 */
export interface FilterPick {
  label: string;
  /** `null` is every option; an empty set is the deliberate none. */
  select: FilterSelection;
}

interface MultiSelectFilterProps {
  name: string;
  open: boolean;
  setOpen: (name: string | null) => void;
  heading: string;
  /** The one fact that prevents a wrong reading, above the list. */
  help?: ReactNode;
  /** The same, but below — where the fact is about what the list leaves out. */
  note?: ReactNode;
  options: readonly FilterOption[];
  /**
   * Whole-set shortcuts shown on their own row under the heading, which then
   * carries `all` alongside them instead of in its corner.
   */
  picks?: readonly FilterPick[];
  selected: FilterSelection;
  onChange: (selection: FilterSelection) => void;
  one: string;
  many: string;
  align?: 'left' | 'right';
}

/**
 * The Book's bot and account control, and the only one any page uses for them:
 * checkboxes over a known universe, `all` returning to every option, and a
 * trigger that counts the selection instead of naming it — `2 accounts` stays
 * one line where `ACL-M000005-000001, TTT-M000010-000002` does not.
 */
export function MultiSelectFilter({
  name,
  open,
  setOpen,
  heading,
  help,
  note,
  options,
  picks,
  selected,
  onChange,
  one,
  many,
  align,
}: MultiSelectFilterProps) {
  const counted = options.some((option) => option.count !== undefined);
  const toggle = (key: string) => {
    const current =
      selected === null ? new Set(options.map((option) => option.key)) : new Set(selected);
    if (current.has(key)) current.delete(key);
    else current.add(key);
    onChange(current);
  };
  return (
    <FilterPopover
      name={name}
      label={selectionLabel(selected, options.length, one, many)}
      open={open}
      setOpen={setOpen}
      align={align}
    >
      <PopoverHeading
        label={heading}
        action={picks ? undefined : 'all'}
        onAction={picks ? undefined : () => onChange(null)}
      />
      {picks ? (
        <div className="filter-picks">
          <button type="button" className="btn btn-ghost" onClick={() => onChange(null)}>
            all
          </button>
          {picks.map((pick) => (
            <button
              type="button"
              className="btn btn-ghost"
              key={pick.label}
              onClick={() => onChange(pick.select)}
            >
              {pick.label}
            </button>
          ))}
        </div>
      ) : null}
      {help ? <p className="filter-help">{help}</p> : null}
      {options.map((option) => (
        <label
          className={`filter-option${counted ? ' filter-option-counted' : ''}`}
          key={option.key}
        >
          <input
            type="checkbox"
            checked={selected === null || selected.has(option.key)}
            onChange={() => toggle(option.key)}
          />
          <span>{option.label}</span>
          {counted ? <span className="filter-count">{option.count ?? 0}</span> : null}
        </label>
      ))}
      {note ? <p className="filter-help">{note}</p> : null}
    </FilterPopover>
  );
}

interface SymbolFilterProps {
  name?: string;
  open: boolean;
  setOpen: (name: string | null) => void;
  heading: string;
  /** Every symbol the loaded rows actually name, sorted. */
  symbols: readonly string[];
  selected: ReadonlySet<string>;
  onChange: (selection: ReadonlySet<string>) => void;
  /** What a kept symbol qualifies — a chain on the Book, a round trip on Performance. */
  keptNote: (count: number, list: string) => ReactNode;
  emptyNote: ReactNode;
}

/**
 * The Book's symbol control: a search that filters the known symbols, chips that
 * toggle, and Enter taking the first match. It never accepts free text — a
 * symbol the loaded rows do not name cannot be filtered to, and a typed one
 * would silently return nothing.
 */
export function SymbolFilter({
  name = 'symbols',
  open,
  setOpen,
  heading,
  symbols,
  selected,
  onChange,
  keptNote,
  emptyNote,
}: SymbolFilterProps) {
  const [query, setQuery] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) requestAnimationFrame(() => inputRef.current?.focus());
  }, [open]);

  const trimmed = query.trim().toUpperCase();
  const matching = !trimmed
    ? symbols
    : [...symbols]
        .sort((left, right) => {
          const leftPrefix = left.startsWith(trimmed) ? 0 : 1;
          const rightPrefix = right.startsWith(trimmed) ? 0 : 1;
          if (leftPrefix !== rightPrefix) return leftPrefix - rightPrefix;
          return left.localeCompare(right);
        })
        .filter((symbol) => symbol.includes(trimmed));

  const toggle = (symbol: string) => {
    const next = new Set(selected);
    if (next.has(symbol)) next.delete(symbol);
    else next.add(symbol);
    onChange(next);
  };

  const handleKey = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter' && matching[0]) {
      event.preventDefault();
      toggle(matching[0]);
    }
    if (event.key === 'Escape' && query) {
      event.stopPropagation();
      setQuery('');
    }
  };

  return (
    <FilterPopover
      name={name}
      label={selected.size === 0 ? 'any symbol' : plural(selected.size, 'symbol')}
      open={open}
      setOpen={setOpen}
      className={`symbol-filter${selected.size === 0 ? ' filter-unset' : ''}`}
      onEscape={() => {
        if (query) {
          setQuery('');
          return false;
        }
        return true;
      }}
    >
      <PopoverHeading label={heading} action="clear" onAction={() => onChange(new Set<string>())} />
      <input
        ref={inputRef}
        className="input symbol-search"
        value={query}
        onChange={(event) => setQuery(event.target.value.toUpperCase())}
        onKeyDown={handleKey}
        placeholder="filter · enter toggles"
        aria-label="Filter symbols"
      />
      <div className="symbol-options">
        {matching.map((symbol, index) => (
          <button
            type="button"
            className={`tag symbol-option${selected.has(symbol) ? ' tag-accent' : ' tag-neutral'}${
              trimmed && index === 0 ? ' symbol-enter-target' : ''
            }`}
            key={symbol}
            onClick={() => toggle(symbol)}
          >
            {symbol}
          </button>
        ))}
      </div>
      {matching.length === 0 ? (
        <p className="filter-help">
          {trimmed ? (
            <>
              No symbol here matches <span className="book-inline-value">{trimmed}</span>.{' '}
            </>
          ) : null}
          {emptyNote}
        </p>
      ) : null}
      {selected.size > 0 ? (
        <p className="filter-help">{keptNote(selected.size, [...selected].sort().join(', '))}</p>
      ) : null}
    </FilterPopover>
  );
}

/**
 * The bot shortcuts every page offers beside `all`: `none`, and the two halves
 * of the switch. Each names the exact set it selects at the moment it is
 * offered — a bot that is turned on afterwards is not retroactively in a set
 * chosen as `active`, which is the honest reading of a stored selection.
 */
export function botPicks(bots: readonly Bot[]): FilterPick[] {
  return [
    { label: 'none', select: new Set<string>() },
    { label: 'active', select: new Set(bots.filter((bot) => bot.active).map((bot) => bot.id)) },
    { label: 'inactive', select: new Set(bots.filter((bot) => !bot.active).map((bot) => bot.id)) },
  ];
}

/** One option per account, in the identity shape every selector keys on. */
export function accountOptions(accounts: readonly Account[]): FilterOption[] {
  return accounts.map((account) => ({
    key: accountIdentityKey(account.accountId, account.brokerageId),
    label: (
      <>
        {account.accountId} · {account.brokerageId}
        {account.owner ? <span className="muted"> · {account.owner}</span> : null}
      </>
    ),
  }));
}

/**
 * `null` and a full set are the same view, so they read the same. A partial
 * selection of one names its count, never the member — the chips below the
 * toolbar are what name members, one chip each.
 */
export function selectionLabel(
  values: FilterSelection,
  total: number,
  one: string,
  many: string,
): string {
  if (values === null || values.size === total) return `${total} ${total === 1 ? one : many}`;
  if (values.size === 1) return `1 ${one}`;
  return `${values.size} ${many}`;
}
