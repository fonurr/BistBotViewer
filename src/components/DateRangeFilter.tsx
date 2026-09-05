import { CaretLeft, CaretRight, Minus, Plus } from '@phosphor-icons/react';
import { useEffect, useMemo, useState, type ReactNode } from 'react';

import { formatDateKey } from '../domain/format';
import { FilterPopover, PopoverHeading } from './FilterPopover';

/**
 * Both ends are batch dates. `null` is not a range but the state before the
 * page's reads are in — the control resolves it to its `defaultRange` once they
 * are, so a page never has to guess a date it has not read yet.
 */
export interface DateRange {
  from: string | null;
  to: string | null;
}

/** Which end a step moves: the whole window, or one edge of it. */
type RangeEdge = 'both' | 'from' | 'to';

interface DateRangeFilterProps {
  name?: string;
  open: boolean;
  setOpen: (name: string | null) => void;
  /** Every batch date the loaded rows carry, ascending and deduplicated. */
  dates: readonly string[];
  /**
   * Whether `dates` is the whole list yet. The page's reads land one at a time,
   * and the default is taken once and never revisited — so settling on a first
   * snapshot would let whichever read came back first choose the day.
   */
  ready: boolean;
  /**
   * The batch the desk is working now — `sessionBatchDate` of this moment, not
   * today's calendar day. On a Saturday that is Monday's session, because
   * Friday's evening orders are already filed under it. The list reaches past
   * it, a scheduled order being filed under the session it is aimed at, and
   * that is where `latest` stops; the steppers and the calendar still go on.
   */
  currentSession: string;
  range: DateRange;
  onChange: (range: DateRange) => void;
  /**
   * Which range an unset filter settles on once a batch exists. The Book opens
   * on the newest session, because a day's work is what it is for; a report
   * over one day is not a report, so Performance opens on all of them.
   */
  defaultRange?: 'latest' | 'all';
  /**
   * Where the default lands, when settling on it is not the same event as a
   * reader choosing a range — the Book's `onChange` drops a deep link and
   * clears the no-exit toggle, and nobody asked it to. Defaults to `onChange`.
   */
  onSettle?: (range: DateRange) => void;
  align?: 'left' | 'right';
  /** The fact that prevents a wrong reading, under the calendar. */
  note?: ReactNode;
}

/**
 * The one batch-range control in the viewer, shared by the Book and Performance
 * so a range means the same thing on both. Every date it can reach is a batch
 * date: the steppers walk the loaded batches and the calendar refuses a day no
 * batch was filed under, because a window over a day nothing was filed in is a
 * window nobody chose.
 *
 * The cluster is five controls around one trigger — `‹` and `›` walk the whole
 * window, and the `+ / −` pair on each side moves that side's edge alone. All
 * of them stop at the loaded bounds rather than shortening the window against
 * them: a step that cannot be taken whole is not taken, and its button is
 * disabled instead.
 */
export function DateRangeFilter({
  name = 'dates',
  open,
  setOpen,
  dates,
  ready,
  currentSession,
  range,
  onChange,
  defaultRange = 'all',
  onSettle,
  align = 'left',
  note,
}: DateRangeFilterProps) {
  const earliest = dates[0];
  const latest = dates.at(-1);
  /*
   * The newest batch the desk has reached. Work written past the close is
   * already the next session's, so the newest batch is routinely a day nobody
   * has traded yet and `latest` has to include it — but a scheduled order sits
   * further out still, under whichever session it is aimed at, and opening the
   * page there is not what `latest` means. Where every loaded batch is beyond
   * the current one, the nearest is the earliest, not the last. `all`, the
   * steppers and the calendar all still reach them: they are real batches.
   */
  const newest = useMemo(() => {
    const reached = dates.filter((date) => date <= currentSession);
    return reached.at(-1) ?? dates[0];
  }, [currentSession, dates]);

  // The default can only be applied once a batch is known — the list arrives
  // with the first read, and a filter cleared back to nothing comes through
  // here the same way.
  const settle = onSettle ?? onChange;
  useEffect(() => {
    if (!ready || range.from !== null || range.to !== null || latest === undefined) return;
    if (defaultRange === 'latest') settle({ from: newest ?? null, to: newest ?? null });
    else settle({ from: earliest ?? null, to: latest });
  }, [defaultRange, earliest, latest, newest, range.from, range.to, ready, settle]);

  const step = (edge: RangeEdge, by: 1 | -1) => {
    const next = stepRange(range, dates, edge, by);
    if (next) onChange(next);
  };

  return (
    <div className="date-range">
      <button
        type="button"
        className="input date-step"
        disabled={stepRange(range, dates, 'both', -1) === null}
        aria-label="Whole range one batch earlier"
        onClick={() => step('both', -1)}
      >
        <CaretLeft size={12} weight="bold" aria-hidden="true" />
      </button>
      <EdgeNudge edge="from" label="Start" range={range} dates={dates} onStep={step} />
      <FilterPopover
        name={name}
        label={rangeLabel(range)}
        open={open}
        setOpen={setOpen}
        align={align}
      >
        <PopoverHeading label="batch range" />
        <div className="filter-picks">
          <button
            type="button"
            className="btn btn-ghost"
            onClick={() => onChange({ from: newest ?? null, to: newest ?? null })}
          >
            latest
          </button>
          <button
            type="button"
            className="btn btn-ghost"
            onClick={() => {
              const reached = dates.filter((date) => date <= currentSession);
              onChange({ from: reached.at(-5) ?? earliest ?? null, to: newest ?? null });
            }}
          >
            last 5
          </button>
          <button
            type="button"
            className="btn btn-ghost"
            onClick={() => onChange({ from: earliest ?? null, to: latest ?? null })}
          >
            all
          </button>
        </div>
        <BatchCalendar dates={dates} range={range} onChange={onChange} />
        {note ? <p className="filter-help">{note}</p> : null}
      </FilterPopover>
      <EdgeNudge edge="to" label="End" range={range} dates={dates} onStep={step} />
      <button
        type="button"
        className="input date-step"
        disabled={stepRange(range, dates, 'both', 1) === null}
        aria-label="Whole range one batch later"
        onClick={() => step('both', 1)}
      >
        <CaretRight size={12} weight="bold" aria-hidden="true" />
      </button>
    </div>
  );
}

/** The stacked pair that moves one edge of the window, later above earlier. */
function EdgeNudge({
  edge,
  label,
  range,
  dates,
  onStep,
}: {
  edge: 'from' | 'to';
  label: string;
  range: DateRange;
  dates: readonly string[];
  onStep: (edge: RangeEdge, by: 1 | -1) => void;
}) {
  return (
    <div className="date-nudge">
      <button
        type="button"
        className="input"
        disabled={stepRange(range, dates, edge, 1) === null}
        aria-label={`${label} one batch later`}
        onClick={() => onStep(edge, 1)}
      >
        <Plus size={9} weight="bold" aria-hidden="true" />
      </button>
      <button
        type="button"
        className="input"
        disabled={stepRange(range, dates, edge, -1) === null}
        aria-label={`${label} one batch earlier`}
        onClick={() => onStep(edge, -1)}
      >
        <Minus size={9} weight="bold" aria-hidden="true" />
      </button>
    </div>
  );
}

const WEEKDAYS = ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'];

/**
 * A month at a time, with every day that carries no batch disabled. Two clicks
 * make a range — the first sets both ends, the second extends from it in
 * whichever direction it lands — so a single batch stays one click away.
 */
function BatchCalendar({
  dates,
  range,
  onChange,
}: {
  dates: readonly string[];
  range: DateRange;
  onChange: (range: DateRange) => void;
}) {
  const batchDays = useMemo(() => new Set(dates), [dates]);
  const [month, setMonth] = useState(() =>
    (range.to ?? range.from ?? dates.at(-1) ?? '').slice(0, 7),
  );
  const [anchor, setAnchor] = useState<string | null>(null);
  const earliest = dates[0];
  const latest = dates.at(-1);

  if (month === '' || earliest === undefined || latest === undefined) return null;

  const days = monthDays(month);
  const label = monthLabel(month);

  const pick = (day: string) => {
    if (anchor === null) {
      setAnchor(day);
      onChange({ from: day, to: day });
      return;
    }
    setAnchor(null);
    onChange(anchor <= day ? { from: anchor, to: day } : { from: day, to: anchor });
  };

  return (
    <div className="batch-calendar">
      <div className="batch-calendar-head">
        <button
          type="button"
          className="btn btn-ghost"
          disabled={earliest >= `${month}-01`}
          aria-label="Previous month"
          onClick={() => setMonth(shiftMonth(month, -1))}
        >
          <CaretLeft size={11} weight="bold" aria-hidden="true" />
        </button>
        <span>{label}</span>
        <button
          type="button"
          className="btn btn-ghost"
          disabled={latest <= days[days.length - 1]!}
          aria-label="Next month"
          onClick={() => setMonth(shiftMonth(month, 1))}
        >
          <CaretRight size={11} weight="bold" aria-hidden="true" />
        </button>
      </div>
      <div className="batch-grid">
        {WEEKDAYS.map((weekday) => (
          <span className="batch-weekday" key={weekday}>
            {weekday}
          </span>
        ))}
        {Array.from({ length: leadingBlanks(month) }, (_, index) => (
          <span key={`blank-${index}`} />
        ))}
        {days.map((day) => {
          const batch = batchDays.has(day);
          const edge = day === range.from || day === range.to;
          // Only a batch is tinted inside the range: a weekend the window spans
          // is not a day the report holds, and shading it would say it was.
          const inside =
            batch && range.from !== null && range.to !== null && day > range.from && day < range.to;
          return (
            <button
              type="button"
              key={day}
              className={`batch-day${edge ? ' is-edge' : inside ? ' is-inside' : ''}`}
              disabled={!batch}
              aria-pressed={edge}
              aria-label={`${Number(day.slice(8))} ${label}`}
              onClick={() => pick(day)}
            >
              {Number(day.slice(8))}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/**
 * One batch reads as one date, not as a range onto itself. The `first → latest`
 * wording survives only for the moment before any batch has loaded, where there
 * is nothing yet to name.
 */
export function rangeLabel(range: DateRange): string {
  if (range.from === null && range.to === null) return 'Every batch';
  if (range.from !== null && range.from === range.to) return formatDateKey(range.from);
  return `${range.from ? formatDateKey(range.from) : 'first'} → ${
    range.to ? formatDateKey(range.to) : 'latest'
  }`;
}

/**
 * The window one loaded batch later (`1`) or earlier (`-1`), moving either the
 * whole window or one of its edges. A step that would carry an edge past the
 * loaded bounds, or past the other edge, is refused outright rather than
 * shortening the window against them — `null` is what disables the button that
 * asked for it.
 */
export function stepRange(
  range: DateRange,
  dates: readonly string[],
  edge: RangeEdge,
  by: 1 | -1,
): DateRange | null {
  const indices = rangeIndices(range, dates);
  if (indices === null) return null;
  const from = edge === 'to' ? indices.from : indices.from + by;
  const to = edge === 'from' ? indices.to : indices.to + by;
  if (from < 0 || to > dates.length - 1 || from > to) return null;
  return { from: dates[from]!, to: dates[to]! };
}

/**
 * Where the range's ends sit in the loaded batches. An end that is no longer in
 * the list — a bot filter that dropped the batch it named — resolves to the
 * nearest batch the window still reaches rather than to nothing.
 */
export function rangeIndices(
  range: DateRange,
  dates: readonly string[],
): { from: number; to: number } | null {
  if (dates.length === 0) return null;
  const last = dates.length - 1;
  const start = range.from;
  const end = range.to;
  const fromMatch = start === null ? 0 : dates.findIndex((date) => date >= start);
  const toMatch = end === null ? last : lastIndexAtOrBefore(dates, end);
  const from = fromMatch === -1 ? last : fromMatch;
  const to = toMatch === -1 ? 0 : toMatch;
  return { from: Math.min(from, to), to };
}

/** The last batch on or before a date, or `-1` where every batch is after it. */
function lastIndexAtOrBefore(dates: readonly string[], date: string): number {
  for (let index = dates.length - 1; index >= 0; index -= 1) {
    if (dates[index]! <= date) return index;
  }
  return -1;
}

function monthDays(month: string): string[] {
  const [year, index] = month.split('-').map(Number);
  const count = new Date(Date.UTC(year!, index!, 0)).getUTCDate();
  return Array.from({ length: count }, (_, day) => `${month}-${String(day + 1).padStart(2, '0')}`);
}

/** Monday-first, as the Istanbul week is read. */
function leadingBlanks(month: string): number {
  const [year, index] = month.split('-').map(Number);
  return (new Date(Date.UTC(year!, index! - 1, 1)).getUTCDay() + 6) % 7;
}

function shiftMonth(month: string, by: number): string {
  const [year, index] = month.split('-').map(Number);
  const absolute = year! * 12 + (index! - 1) + by;
  return `${String(Math.floor(absolute / 12)).padStart(4, '0')}-${String(
    (absolute % 12) + 1,
  ).padStart(2, '0')}`;
}

function monthLabel(month: string): string {
  const [year, index] = month.split('-').map(Number);
  return new Date(Date.UTC(year!, index! - 1, 1)).toLocaleString('en-GB', {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });
}
