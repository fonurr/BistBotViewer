import { CaretLeft, CaretRight, Minus, Plus } from '@phosphor-icons/react';
import { useId } from 'react';

import { FilterPopover } from '../../components/FilterPopover';
import {
  BOOK_TIME_FIELDS,
  BOOK_TIME_SIDES_DEFAULT,
  bookTimeSliderSteps,
  formatBookTime,
  stepBookTimeRange,
  type BookTimeField,
  type BookTimeRangeEdge,
} from '../../domain/bookTimeFilter';
import { BookTimeInput } from './BookTimeInput';
import type { BookFilterState } from './types';

type BookTimeSideKey = 'timeBuys' | 'timeSells' | 'timeIncludeCanceled';

/**
 * The side toggles sit across from the first clock checkboxes. `all` / `none`
 * leave them alone; only switching the filter off restores their defaults.
 */
const BOOK_TIME_SIDES: readonly { key: BookTimeSideKey; label: string }[] = [
  { key: 'timeBuys', label: 'buys' },
  { key: 'timeSells', label: 'sells' },
  { key: 'timeIncludeCanceled', label: 'include canceled' },
];

interface BookTimeFilterProps {
  filters: BookFilterState;
  onChange: (filters: BookFilterState) => void;
  open: boolean;
  setOpen: (name: string | null) => void;
}

export function BookTimeFilter({ filters, onChange, open, setOpen }: BookTimeFilterProps) {
  const off = !filters.timeFilter;
  const range = { from: filters.timeFrom, to: filters.timeTo };
  const sliderSteps = bookTimeSliderSteps(range);
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
  const toggleSide = (key: BookTimeSideKey) => onChange({ ...filters, [key]: !filters[key] });

  return (
    <FilterPopover
      name="time"
      label={
        off ? 'any time' : `${formatBookTime(filters.timeFrom)}-${formatBookTime(filters.timeTo)}`
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
                timeBuys: BOOK_TIME_SIDES_DEFAULT.buys,
                timeSells: BOOK_TIME_SIDES_DEFAULT.sells,
                timeIncludeCanceled: BOOK_TIME_SIDES_DEFAULT.includeCanceled,
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
      <div className="book-time-fields">
        <div className="book-time-clocks">
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
        </div>
        <div className="book-time-sides">
          {BOOK_TIME_SIDES.map(({ key, label }) => (
            <label
              className={`filter-option book-time-side${off ? ' filter-option-off' : ''}`}
              key={key}
            >
              <span>{label}</span>
              <input
                type="checkbox"
                disabled={off}
                checked={filters[key]}
                onChange={() => toggleSide(key)}
              />
            </label>
          ))}
        </div>
      </div>
      <div className="book-time-range">
        <div className="book-time-shift">
          <span>Time range</span>
          <div className="book-time-shift-actions">
            <button
              type="button"
              className="btn btn-secondary book-time-step"
              aria-label="Whole time range one step earlier"
              disabled={nextStep('both', -1) === null}
              onClick={() => step('both', -1)}
            >
              <CaretLeft size={12} weight="bold" aria-hidden="true" />
            </button>
            <button
              type="button"
              className="btn btn-secondary book-time-step"
              aria-label="Whole time range one step later"
              disabled={nextStep('both', 1) === null}
              onClick={() => step('both', 1)}
            >
              <CaretRight size={12} weight="bold" aria-hidden="true" />
            </button>
            <button
              type="button"
              className="btn btn-ghost book-time-reset"
              aria-label="Reset time range"
              disabled={filters.timeFrom === 0 && filters.timeTo === 1439}
              onClick={() => onChange({ ...filters, timeFrom: 0, timeTo: 1439 })}
            >
              reset
            </button>
          </div>
        </div>
        <TimeSlider
          label="Start time"
          minute={filters.timeFrom}
          steps={sliderSteps}
          disabled={off}
          earlierDisabled={nextStep('from', -1) === null}
          laterDisabled={nextStep('from', 1) === null}
          onStep={(by) => step('from', by)}
          onEdit={(minute) =>
            onChange({ ...filters, timeFrom: minute, timeTo: Math.max(minute, filters.timeTo) })
          }
          onChange={(minute) =>
            onChange({ ...filters, timeFrom: Math.min(minute, filters.timeTo) })
          }
        />
        <TimeSlider
          label="End time"
          minute={filters.timeTo}
          steps={sliderSteps}
          disabled={off}
          earlierDisabled={nextStep('to', -1) === null}
          laterDisabled={nextStep('to', 1) === null}
          onStep={(by) => step('to', by)}
          onEdit={(minute) =>
            onChange({ ...filters, timeFrom: Math.min(minute, filters.timeFrom), timeTo: minute })
          }
          onChange={(minute) =>
            onChange({ ...filters, timeTo: Math.max(minute, filters.timeFrom) })
          }
        />
      </div>
      <p className="filter-help">
        Istanbul time. Includes the entire end minute. A selected time on any buy or sell leg you
        keep ticked keeps the whole chain; canceled legs count only with <em>include canceled</em>.
      </p>
    </FilterPopover>
  );
}

function TimeSlider({
  label,
  minute,
  steps,
  disabled,
  earlierDisabled,
  laterDisabled,
  onStep,
  onEdit,
  onChange,
}: {
  label: string;
  minute: number;
  steps: readonly number[];
  disabled: boolean;
  earlierDisabled: boolean;
  laterDisabled: boolean;
  onStep: (by: 1 | -1) => void;
  onEdit: (minute: number) => void;
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
          <BookTimeInput
            id={id}
            label={label}
            minute={minute}
            disabled={disabled}
            onChange={onEdit}
          />
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
        id={`${id}-slider`}
        type="range"
        aria-label={label}
        aria-valuetext={formatBookTime(minute)}
        min={0}
        max={steps.length - 1}
        step={1}
        value={steps.indexOf(minute)}
        disabled={disabled}
        onChange={(event) => onChange(steps[Number(event.currentTarget.value)]!)}
      />
    </div>
  );
}
