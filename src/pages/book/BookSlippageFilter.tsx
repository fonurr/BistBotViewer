import { selectionLabel } from '../../components/EntityFilters';
import { FilterPopover } from '../../components/FilterPopover';
import { BOOK_SLIPPAGE_FIELDS, BOOK_SLIPPAGE_SIDES_DEFAULT } from '../../domain/bookSlippageFilter';
import { BookFilterChecks } from './BookFilterChecks';
import type { BookFilterState } from './types';

type BookSlippageSideKey = 'slippageBuys' | 'slippageSells';

/** The same two leg-side toggles the time filter carries, and no canceled opt-in. */
const BOOK_SLIPPAGE_SIDES: readonly { key: BookSlippageSideKey; label: string }[] = [
  { key: 'slippageBuys', label: 'buys' },
  { key: 'slippageSells', label: 'sells' },
];

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
            slippageFields: new Set(BOOK_SLIPPAGE_FIELDS.map(({ key }) => key)),
            slippageBuys: BOOK_SLIPPAGE_SIDES_DEFAULT.buys,
            slippageSells: BOOK_SLIPPAGE_SIDES_DEFAULT.sells,
          })
        }
        fields={BOOK_SLIPPAGE_FIELDS}
        selected={filters.slippageFields}
        onSelectedChange={(slippageFields) => onChange({ ...filters, slippageFields })}
        sides={BOOK_SLIPPAGE_SIDES.map(({ key, label }) => ({
          key,
          label,
          checked: filters[key],
          onToggle: () => onChange({ ...filters, [key]: !filters[key] }),
        }))}
      />
      <p className="filter-help">
        A price matches a leg whose cell draws a slip; a time, a leg whose clock is drawn red or
        orange. Any ticked one on a buy or sell leg you keep ticked, canceled legs included, keeps
        the whole chain.
      </p>
    </FilterPopover>
  );
}
