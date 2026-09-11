import { CaretLeft, CaretRight, Minus, Plus } from '@phosphor-icons/react';
import { useId } from 'react';

import { FilterPopover } from '../../components/FilterPopover';
import {
  BOOK_TIME_FIELDS,
  bookTimeSliderSteps,
  formatBookTime,
  stepBookTimeRange,
  type BookTimeRangeEdge,
} from '../../domain/bookTimeFilter';
import { BookFilterChecks } from './BookFilterChecks';
import { BookTimeInput } from './BookTimeInput';
import { defaultBookFilters, keptChainDrawing, type BookFilterState } from './types';

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
      <BookFilterChecks
        active={filters.timeFilter}
        onActiveChange={() =>
          /* Either way the clocks go back to none, so switching on starts from
             nothing ticked; the range stays where it was. */
          onChange({ ...filters, timeFilter: off, timeFields: defaultBookFilters.timeFields })
        }
        fields={BOOK_TIME_FIELDS}
        selected={filters.timeFields}
        onSelectedChange={(timeFields) => onChange({ ...filters, timeFields })}
      />
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
        Istanbul time. Includes the entire end minute. A selected time on any order the side toggles
        read keeps{' '}
        {filters.ordersOnly
          ? `the chain, which then ${keptChainDrawing(filters)}.`
          : 'the whole chain.'}
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
