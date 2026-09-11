import { selectionLabel } from '../../components/EntityFilters';
import { FilterPopover } from '../../components/FilterPopover';
import { BOOK_SLIPPAGE_FIELDS } from '../../domain/bookSlippageFilter';
import { BookFilterChecks } from './BookFilterChecks';
import { defaultBookFilters, keptChainDrawing, type BookFilterState } from './types';

interface BookSlippageFilterProps {
  filters: BookFilterState;
  onChange: (filters: BookFilterState) => void;
  open: boolean;
  setOpen: (name: string | null) => void;
}

export function BookSlippageFilter({ filters, onChange, open, setOpen }: BookSlippageFilterProps) {
  const off = !filters.slippageFilter;
  return (
    <FilterPopover
      name="slippage"
      label={
        off
          ? 'any slippage'
          : selectionLabel(filters.slippageFields, BOOK_SLIPPAGE_FIELDS.length, 'slip', 'slips')
      }
      open={open}
      setOpen={setOpen}
      className={`book-slippage-filter${off ? ' filter-unset' : ''}`}
    >
      <BookFilterChecks
        active={filters.slippageFilter}
        onActiveChange={() =>
          onChange({
            ...filters,
            slippageFilter: off,
            slippageFields: defaultBookFilters.slippageFields,
          })
        }
        fields={BOOK_SLIPPAGE_FIELDS}
        selected={filters.slippageFields}
        onSelectedChange={(slippageFields) => onChange({ ...filters, slippageFields })}
      />
      <p className="filter-help">
        A price matches an order whose cell draws a slip; a time, an order whose clock is drawn red
        or orange. Any ticked one on an order the side toggles read keeps{' '}
        {filters.ordersOnly
          ? `the chain, which then ${keptChainDrawing(filters)}.`
          : 'the whole chain.'}
      </p>
    </FilterPopover>
  );
}
