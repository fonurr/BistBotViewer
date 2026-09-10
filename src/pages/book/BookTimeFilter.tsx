import { FilterPopover } from '../../components/FilterPopover';
import {
  BOOK_TIME_FIELDS,
  BOOK_TIME_STEPS,
  formatBookTime,
  type BookTimeField,
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
        <TimeSlider
          label="Start time"
          minute={filters.timeFrom}
          disabled={off}
          onChange={(minute) =>
            onChange({ ...filters, timeFrom: Math.min(minute, filters.timeTo) })
          }
        />
        <TimeSlider
          label="End time"
          minute={filters.timeTo}
          disabled={off}
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
  onChange,
}: {
  label: string;
  minute: number;
  disabled: boolean;
  onChange: (minute: number) => void;
}) {
  return (
    <label className="book-time-slider">
      <span className="book-time-slider-label">
        <span>{label}</span>
        <span className="book-time-value">{formatBookTime(minute)}</span>
      </span>
      <input
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
    </label>
  );
}
