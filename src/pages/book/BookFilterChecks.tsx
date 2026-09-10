interface BookFilterSide {
  key: string;
  label: string;
  checked: boolean;
  onToggle: () => void;
}

interface BookFilterChecksProps<K extends string> {
  active: boolean;
  /** Switching the filter either way; the caller decides what that restores. */
  onActiveChange: () => void;
  fields: readonly { key: K; label: string }[];
  selected: ReadonlySet<K>;
  onSelectedChange: (selected: ReadonlySet<K>) => void;
  /** The leg-side toggles across from the first checkboxes; `all` / `none` never touch them. */
  sides: readonly BookFilterSide[];
}

/**
 * The head of the Book's time and slippage popovers: the `filter` switch with
 * `all` / `none`, then the field checkboxes on the left and the leg-side toggles
 * on the right, label ahead of the box. Off leaves every box disabled.
 */
export function BookFilterChecks<K extends string>({
  active,
  onActiveChange,
  fields,
  selected,
  onSelectedChange,
  sides,
}: BookFilterChecksProps<K>) {
  const off = !active;
  const toggle = (key: K) => {
    const next = new Set(selected);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    onSelectedChange(next);
  };
  return (
    <>
      <div className="filter-picks">
        <label className="filter-switch">
          <input type="checkbox" checked={active} onChange={onActiveChange} />
          <span>filter</span>
        </label>
        <button
          type="button"
          className="btn btn-ghost"
          disabled={off}
          onClick={() => onSelectedChange(new Set(fields.map(({ key }) => key)))}
        >
          all
        </button>
        <button
          type="button"
          className="btn btn-ghost"
          disabled={off}
          onClick={() => onSelectedChange(new Set<K>())}
        >
          none
        </button>
      </div>
      <div className="book-filter-fields">
        <div className="book-filter-checks">
          {fields.map(({ key, label }) => (
            <label className={`filter-option${off ? ' filter-option-off' : ''}`} key={key}>
              <input
                type="checkbox"
                disabled={off}
                checked={selected.has(key)}
                onChange={() => toggle(key)}
              />
              <span>{label}</span>
            </label>
          ))}
        </div>
        <div className="book-filter-sides">
          {sides.map(({ key, label, checked, onToggle }) => (
            <label
              className={`filter-option book-filter-side${off ? ' filter-option-off' : ''}`}
              key={key}
            >
              <span>{label}</span>
              <input type="checkbox" disabled={off} checked={checked} onChange={onToggle} />
            </label>
          ))}
        </div>
      </div>
    </>
  );
}
