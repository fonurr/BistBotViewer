interface BookFilterChecksProps<K extends string> {
  active: boolean;
  /** Switching the filter either way; the caller decides what that restores. */
  onActiveChange: () => void;
  fields: readonly { key: K; label: string }[];
  selected: ReadonlySet<K>;
  onSelectedChange: (selected: ReadonlySet<K>) => void;
}

/**
 * The head of the Book's time and slippage popovers: the `filter` switch with
 * `all` / `none`, then the field checkboxes. Off leaves every box disabled.
 * Which orders the fields are read on is not asked here — the side toggles
 * beside `matching orders only` answer that for every row filter at once.
 */
export function BookFilterChecks<K extends string>({
  active,
  onActiveChange,
  fields,
  selected,
  onSelectedChange,
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
    </>
  );
}
