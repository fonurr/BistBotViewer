import { useLayoutEffect, useRef, useState } from 'react';

import { formatBookTime, parseBookTimeInput } from '../../domain/bookTimeFilter';

export function BookTimeInput({
  id,
  label,
  minute,
  disabled,
  onChange,
}: {
  id: string;
  label: string;
  minute: number;
  disabled: boolean;
  onChange: (minute: number) => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const pendingCaret = useRef<number | null>(null);
  const selectOnClick = useRef(false);
  const value = draft ?? formatBookTime(minute);

  // Adding the colon must not leave the caret behind it or move an edit to
  // the end. Keep the caret attached to the number of digits already typed.
  useLayoutEffect(() => {
    const input = inputRef.current;
    if (input && document.activeElement === input && pendingCaret.current !== null) {
      input.setSelectionRange(pendingCaret.current, pendingCaret.current);
    }
    pendingCaret.current = null;
  }, [draft, minute]);

  const edit = (raw: string, caret: number) => {
    const digits = raw.replace(/\D/g, '').slice(0, 4);
    const formatted = digits.length > 2 ? `${digits.slice(0, 2)}:${digits.slice(2)}` : digits;
    const beforeCaret = raw.slice(0, caret).replace(/\D/g, '').length;
    pendingCaret.current = Math.min(formatted.length, beforeCaret + (beforeCaret > 2 ? 1 : 0));
    const parsed = parseBookTimeInput(digits);
    // Pasting the same time may change neither state value, so there is no
    // layout effect to collapse the selection after the prevented native paste.
    if ((parsed === null ? formatted : formatBookTime(parsed)) === value) {
      inputRef.current?.setSelectionRange(pendingCaret.current, pendingCaret.current);
      pendingCaret.current = null;
    }
    setDraft(parsed === null ? formatted : null);
    if (parsed !== null) onChange(parsed);
  };

  return (
    <input
      ref={inputRef}
      id={id}
      className="input book-time-input"
      type="text"
      inputMode="numeric"
      autoComplete="off"
      spellCheck={false}
      maxLength={5}
      aria-label={label}
      aria-invalid={draft !== null && draft.replace(/\D/g, '').length === 4}
      value={value}
      disabled={disabled}
      onPointerDown={(event) => {
        selectOnClick.current = document.activeElement !== event.currentTarget;
      }}
      onFocus={(event) => event.currentTarget.select()}
      onClick={(event) => {
        if (selectOnClick.current) event.currentTarget.select();
        selectOnClick.current = false;
      }}
      onChange={(event) =>
        edit(event.currentTarget.value, event.currentTarget.selectionStart ?? value.length)
      }
      onBlur={() => setDraft(null)}
      onPaste={(event) => {
        event.preventDefault();
        const start = event.currentTarget.selectionStart ?? value.length;
        const end = event.currentTarget.selectionEnd ?? start;
        const pasted = event.clipboardData.getData('text');
        edit(value.slice(0, start) + pasted + value.slice(end), start + pasted.length);
      }}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || (event.key === 'Escape' && draft !== null)) {
          event.preventDefault();
          event.stopPropagation();
          setDraft(null);
          event.currentTarget.select();
          return;
        }
        if (event.ctrlKey || event.metaKey || event.altKey) return;
        if (event.key.length === 1 && !/\d/.test(event.key)) event.preventDefault();

        const start = event.currentTarget.selectionStart;
        if (start !== event.currentTarget.selectionEnd || !value.includes(':')) return;
        // Backspace/Delete beside the automatic colon removes the neighboring
        // digit, so the caret can cross the separator in either direction.
        if (event.key === 'Backspace' && start === 3) {
          event.preventDefault();
          edit(value.slice(0, 1) + value.slice(2), 1);
        } else if (event.key === 'Delete' && start === 2) {
          event.preventDefault();
          edit(value.slice(0, 3) + value.slice(4), 2);
        }
      }}
    />
  );
}
