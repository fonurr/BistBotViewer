import { CaretLeft, CaretRight, Minus, Plus } from '@phosphor-icons/react';
import { useId } from 'react';

import { FilterPopover } from '../../components/FilterPopover';
import {
  BOOK_TIME_FIELDS,
  BOOK_TIME_STEPS,
  formatBookTime,
  stepBookTimeRange,
  type BookTimeField,
  type BookTimeRangeEdge,
} from '../../domain/bookTimeFilter';
import type { BookFilterState } from './types';

interface BookTimeFilterProps {
  filters: BookFilterState;
  onChange: (filters: BookFilterState) => void;
  open: boolean;
  setOpen: (name: string | null) => void;
}

export function BookTimeFilter({ filters, onChange, open, setOpen }: BookTimeFilterProps) {
  const off = !filters.timeFilter;
  const range = { from: filters.timeFrom, to: filters.timeTo };
  const nextStep = (edge: BookTimeRangeEdge, by: 1 | -1) =>
    off ? null : stepBookTimeRange(range, edge, by);
  const step = (edge: BookTimeRangeEdge, by: 1 | -1) => {
    const next = nextStep(edge, by);
    if (next) onChange({ ...filters, timeFrom: next.from, timeTo: next.to });
  };
  const toggleField = (field: BookTimeField) => {
    const timeFields = new Set(filters.timeFields);
    if (timeFields.has(field)) timeFields.delete(field);
    else timeFields.add(field);
    onChange({ ...filters, timeFields });
  };

  return (
    <FilterPopover
      name="time"
      label={
        off
          ? 'any time'
          : `time ${formatBookTime(filters.timeFrom)} → ${formatBookTime(filters.timeTo)}`
      }
      open={open}
      setOpen={setOpen}
      className={`book-time-filter${off ? ' filter-unset' : ''}`}
    >
      <div className="filter-picks">
        <label className="filter-switch">
          <input
            type="checkbox"
            checked={filters.timeFilter}
            onChange={() =>
              onChange({
                ...filters,
                timeFilter: off,
                timeFields: new Set(BOOK_TIME_FIELDS.map(({ key }) => key)),
              })
            }
          />
          <span>filter</span>
        </label>
        <button
          type="button"
          className="btn btn-ghost"
          disabled={off}
          onClick={() =>
            onChange({
              ...filters,
              timeFields: new Set(BOOK_TIME_FIELDS.map(({ key }) => key)),
            })
          }
        >
          all
        </button>
        <button
          type="button"
          className="btn btn-ghost"
          disabled={off}
          onClick={() => onChange({ ...filters, timeFields: new Set<BookTimeField>() })}
        >
          none
        </button>
      </div>
      {BOOK_TIME_FIELDS.map(({ key, label }) => (
        <label className={`filter-option${off ? ' filter-option-off' : ''}`} key={key}>
          <input
            type="checkbox"
            disabled={off}
            checked={filters.timeFields.has(key)}
            onChange={() => toggleField(key)}
          />
          <span>{label}</span>
        </label>
      ))}
      <div className="book-time-range">
        <div className="book-time-shift">
          <button
            type="button"
            className="btn btn-secondary book-time-step"
            aria-label="Whole time range one step earlier"
            disabled={nextStep('both', -1) === null}
            onClick={() => step('both', -1)}
          >
            <CaretLeft size={12} weight="bold" aria-hidden="true" />
          </button>
          <span>Time range</span>
          <button
            type="button"
            className="btn btn-secondary book-time-step"
            aria-label="Whole time range one step later"
            disabled={nextStep('both', 1) === null}
            onClick={() => step('both', 1)}
          >
            <CaretRight size={12} weight="bold" aria-hidden="true" />
          </button>
        </div>
        <TimeSlider
          label="Start time"
          minute={filters.timeFrom}
          disabled={off}
          earlierDisabled={nextStep('from', -1) === null}
          laterDisabled={nextStep('from', 1) === null}
          onStep={(by) => step('from', by)}
          onChange={(minute) =>
            onChange({ ...filters, timeFrom: Math.min(minute, filters.timeTo) })
          }
        />
        <TimeSlider
          label="End time"
          minute={filters.timeTo}
          disabled={off}
          earlierDisabled={nextStep('to', -1) === null}
          laterDisabled={nextStep('to', 1) === null}
          onStep={(by) => step('to', by)}
          onChange={(minute) =>
            onChange({ ...filters, timeTo: Math.max(minute, filters.timeFrom) })
          }
        />
      </div>
      <p className="filter-help">
        Istanbul time. Includes the entire end minute. Any selected time on any order keeps the
        whole chain. +1 is midnight the next day.
      </p>
    </FilterPopover>
  );
}

function TimeSlider({
  label,
  minute,
  disabled,
  earlierDisabled,
  laterDisabled,
  onStep,
  onChange,
}: {
  label: string;
  minute: number;
  disabled: boolean;
  earlierDisabled: boolean;
  laterDisabled: boolean;
  onStep: (by: 1 | -1) => void;
  onChange: (minute: number) => void;
}) {
  const id = useId();
  return (
    <div className="book-time-slider">
      <div className="book-time-slider-label">
        <label htmlFor={id}>{label}</label>
        <div className="book-time-nudge">
          <button
            type="button"
            className="btn btn-secondary book-time-step"
            aria-label={`${label} one step earlier`}
            disabled={earlierDisabled}
            onClick={() => onStep(-1)}
          >
            <Minus size={12} weight="bold" aria-hidden="true" />
          </button>
          <span className="book-time-value">{formatBookTime(minute)}</span>
          <button
            type="button"
            className="btn btn-secondary book-time-step"
            aria-label={`${label} one step later`}
            disabled={laterDisabled}
            onClick={() => onStep(1)}
          >
            <Plus size={12} weight="bold" aria-hidden="true" />
          </button>
        </div>
      </div>
      <input
        id={id}
        type="range"
        aria-label={label}
        aria-valuetext={formatBookTime(minute)}
        min={0}
        max={BOOK_TIME_STEPS.length - 1}
        step={1}
        value={BOOK_TIME_STEPS.indexOf(minute)}
        disabled={disabled}
        onChange={(event) => onChange(BOOK_TIME_STEPS[Number(event.currentTarget.value)]!)}
      />
    </div>
  );
}
