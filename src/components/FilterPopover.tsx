import { CaretDown } from '@phosphor-icons/react';
import { useRef, type ReactNode } from 'react';

interface FilterPopoverProps {
  /** Identifies this popover in the owner's single "which one is open" state. */
  name: string;
  label: string;
  open: boolean;
  setOpen: (name: string | null) => void;
  children: ReactNode;
  align?: 'left' | 'right';
  className?: string;
  /** Return false to keep the popover open — used where Escape clears a query first. */
  onEscape?: () => boolean;
}

/**
 * The one filter control shape in the viewer: a trigger that states the current
 * selection, a popover carrying the fact that prevents a wrong reading, Escape
 * closing the top layer, and focus returning to the trigger.
 */
export function FilterPopover({
  name,
  label,
  open,
  setOpen,
  children,
  align = 'left',
  className = '',
  onEscape,
}: FilterPopoverProps) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const closeAndReturnFocus = () => {
    setOpen(null);
    requestAnimationFrame(() => triggerRef.current?.focus());
  };
  return (
    <div
      className={`filter-control ${className}`}
      onKeyDown={(event) => {
        if (event.key !== 'Escape') return;
        event.stopPropagation();
        if (!onEscape || onEscape()) closeAndReturnFocus();
      }}
    >
      <button
        ref={triggerRef}
        type="button"
        className="input filter-trigger"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen(open ? null : name)}
      >
        {label}
        <CaretDown size={11} aria-hidden="true" />
      </button>
      {open ? (
        <div
          className={`card elev-lg filter-popover filter-popover-${align}`}
          role="dialog"
          aria-label={`${label} filter`}
        >
          {children}
        </div>
      ) : null}
    </div>
  );
}

export function PopoverHeading({
  label,
  action,
  onAction,
}: {
  label: string;
  action?: string;
  onAction?: () => void;
}) {
  return (
    <div className="filter-heading">
      <span>{label}</span>
      {action ? (
        <button type="button" className="btn btn-ghost" onClick={onAction}>
          {action}
        </button>
      ) : null}
    </div>
  );
}

/** The scrim that closes an open popover on a click away from it. */
export function PopoverScrim({ onClose }: { onClose: () => void }) {
  return (
    <button className="popover-scrim" type="button" aria-label="Close filter" onClick={onClose} />
  );
}
