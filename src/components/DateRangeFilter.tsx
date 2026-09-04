import { CaretLeft, CaretRight } from '@phosphor-icons/react';
import type { ReactNode } from 'react';

import { formatDateKey } from '../domain/format';
import { FilterPopover, PopoverHeading } from './FilterPopover';

/** `null` at either end is open: the first batch loaded, or the last. */
export interface DateRange {
  from: string | null;
  to: string | null;
}

interface DateRangeFilterProps {
  name?: string;
  open: boolean;
  setOpen: (name: string | null) => void;
  /** Every batch date the loaded rows carry, ascending and deduplicated. */
  dates: readonly string[];
  range: DateRange;
  onChange: (range: DateRange) => void;
  align?: 'left' | 'right';
  /** The fact that prevents a wrong reading, under the fields. */
  note?: ReactNode;
}

/**
 * The one batch-range control in the viewer, shared by the Book and
 * Performance so a range means the same thing on both. The popover carries the
 * whole-set shortcuts on the row `MultiSelectFilter` uses for `all` and `none`,
 * and a stepper sits either side of the trigger to walk the window a day at a
 * time without opening it.
 */
export function DateRangeFilter({
  name = 'dates',
  open,
  setOpen,
  dates,
  range,
  onChange,
  align = 'left',
  note,
}: DateRangeFilterProps) {
  const earliest = dates[0];
  const latest = dates.at(-1);
  const earlier = shiftRange(range, dates, -1);
  const later = shiftRange(range, dates, 1);
  const label =
    range.from === null && range.to === null
      ? 'Every batch'
      : `${range.from ? formatDateKey(range.from) : 'first'} → ${
          range.to ? formatDateKey(range.to) : 'latest'
        }`;

  return (
    <div className="date-range">
      <button
        type="button"
        className="btn btn-ghost date-step"
        disabled={earlier === null}
        aria-label="Shift the batch range one day earlier"
        onClick={() => earlier && onChange(earlier)}
      >
        <CaretLeft size={12} weight="bold" aria-hidden="true" />
      </button>
      <FilterPopover name={name} label={label} open={open} setOpen={setOpen} align={align}>
        <PopoverHeading label="batch range" />
        <div className="filter-picks">
          <button
            type="button"
            className="btn btn-ghost"
            onClick={() => onChange({ from: latest ?? null, to: latest ?? null })}
          >
            latest
          </button>
          <button
            type="button"
            className="btn btn-ghost"
            onClick={() => onChange({ from: dates.at(-5) ?? earliest ?? null, to: latest ?? null })}
          >
            last 5
          </button>
          <button
            type="button"
            className="btn btn-ghost"
            onClick={() => onChange({ from: null, to: null })}
          >
            all
          </button>
        </div>
        <div className="date-fields">
          <label className="field">
            <span>From</span>
            <input
              className="input"
              type="date"
              value={range.from ?? ''}
              min={earliest}
              max={range.to ?? latest}
              onChange={(event) => onChange({ ...range, from: event.target.value || null })}
            />
          </label>
          <label className="field">
            <span>To</span>
            <input
              className="input"
              type="date"
              value={range.to ?? ''}
              min={range.from ?? earliest}
              max={latest}
              onChange={(event) => onChange({ ...range, to: event.target.value || null })}
            />
          </label>
        </div>
        {note ? <p className="filter-help">{note}</p> : null}
      </FilterPopover>
      <button
        type="button"
        className="btn btn-ghost date-step"
        disabled={later === null}
        aria-label="Shift the batch range one day later"
        onClick={() => later && onChange(later)}
      >
        <CaretRight size={12} weight="bold" aria-hidden="true" />
      </button>
    </div>
  );
}

/**
 * The window one calendar day later (`1`) or earlier (`-1`), bounded by the
 * loaded batch dates — an open end steps from the bound it stands for. An end
 * already against the bound stays put while the other end moves, so the window
 * shortens against the edge rather than the whole step being refused. `null` is
 * only returned when neither end can move, and the stepper is disabled on it.
 */
export function shiftRange(
  range: DateRange,
  dates: readonly string[],
  days: 1 | -1,
): DateRange | null {
  const earliest = dates[0];
  const latest = dates.at(-1);
  if (earliest === undefined || latest === undefined) return null;
  const from = clamp(range.from ?? earliest, earliest, latest);
  const to = clamp(range.to ?? latest, earliest, latest);
  const canMove = (date: string) => (days === 1 ? date < latest : date > earliest);
  if (!canMove(from) && !canMove(to)) return null;
  return {
    from: canMove(from) ? shiftDate(from, days) : from,
    to: canMove(to) ? shiftDate(to, days) : to,
  };
}

function clamp(date: string, min: string, max: string): string {
  if (date < min) return min;
  return date > max ? max : date;
}

function shiftDate(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}
