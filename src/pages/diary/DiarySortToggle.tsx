import { ArrowsDownUp } from '@phosphor-icons/react';

interface DiarySortToggleProps {
  newestFirst: boolean;
  onChange: (newestFirst: boolean) => void;
}

/**
 * One button, not two. The reading order has exactly two states and only one of
 * them can be in force, so the control names the one it is in and swaps to the
 * other when pressed — the arrows beside it say that pressing it re-sorts
 * rather than filters, which a bare sentence would not.
 */
export function DiarySortToggle({ newestFirst, onChange }: DiarySortToggleProps) {
  return (
    <button
      type="button"
      className="btn btn-ghost diary-sort"
      aria-label={`Sorted ${newestFirst ? 'newest' : 'oldest'} first — press to reverse`}
      onClick={() => onChange(!newestFirst)}
    >
      <ArrowsDownUp size={13} weight="bold" aria-hidden="true" />
      {newestFirst ? 'Newest first' : 'Oldest first'}
    </button>
  );
}
