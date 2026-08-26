import {
  useEffect,
  useId,
  useRef,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';

interface ModalProps {
  open: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
  closeBlocked?: boolean;
  wide?: boolean;
  labelledBy?: string;
  /** Uppercase kicker beside the title — what kind of thing this dialog is about. */
  titleKicker?: ReactNode;
  /** One line under the title naming the record: chain id, batch, bot. */
  subtitle?: ReactNode;
  /** The figure the dialog is really about, set right of the title. */
  aside?: ReactNode;
}

const focusableSelector = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

export function Modal({
  open,
  title,
  onClose,
  children,
  closeBlocked = false,
  wide = false,
  labelledBy,
  titleKicker,
  subtitle,
  aside,
}: ModalProps) {
  const generatedTitleId = useId();
  const titleId = labelledBy ?? generatedTitleId;
  const dialogRef = useRef<HTMLDivElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!open) return;
    returnFocusRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const frame = requestAnimationFrame(() => {
      const first = dialogRef.current?.querySelector<HTMLElement>(focusableSelector);
      (first ?? dialogRef.current)?.focus();
    });
    return () => {
      cancelAnimationFrame(frame);
      document.body.style.overflow = previousOverflow;
      returnFocusRef.current?.focus();
    };
  }, [open]);

  if (!open) return null;

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.stopPropagation();
      if (!closeBlocked) onClose();
      return;
    }
    if (event.key !== 'Tab') return;
    const items = [...(dialogRef.current?.querySelectorAll<HTMLElement>(focusableSelector) ?? [])];
    if (items.length === 0) {
      event.preventDefault();
      dialogRef.current?.focus();
      return;
    }
    const first = items[0];
    const last = items.at(-1);
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last?.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first?.focus();
    }
  };

  return createPortal(
    <div
      className="dialog-backdrop viewer-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !closeBlocked) onClose();
      }}
    >
      <div
        ref={dialogRef}
        className={`dialog viewer-dialog${wide ? ' viewer-dialog-wide' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        onKeyDown={handleKeyDown}
      >
        <div className="viewer-dialog-heading">
          <div className="viewer-dialog-identity">
            <h2 className="dialog-title" id={titleId}>
              {title}
              {titleKicker ? <span className="viewer-dialog-kicker">{titleKicker}</span> : null}
            </h2>
            {subtitle ? <div className="viewer-dialog-subtitle">{subtitle}</div> : null}
          </div>
          {aside ? <div className="viewer-dialog-aside">{aside}</div> : null}
          <button
            type="button"
            className="btn btn-ghost viewer-dialog-close"
            onClick={onClose}
            disabled={closeBlocked}
            aria-label="Close dialog"
          >
            ×
          </button>
        </div>
        {children}
      </div>
    </div>,
    document.body,
  );
}
