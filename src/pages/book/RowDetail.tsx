import type { BookRowDetailPart, BookRowPresentation } from './rowPresentation';

interface RowDetailProps {
  detail: readonly BookRowDetailPart[] | undefined;
  /**
   * Whether the line follows something of its own — a status word in the same
   * cell — and so opens with the separator that joins it to that word. A note
   * standing on its own starts with its first clause.
   */
  lead?: boolean;
}

/**
 * The one renderer for a row's qualifier line, so the grid and the chain dialog
 * say the same thing in the same ink: the server's reason in body ink, this
 * page's own observations muted, and Matriks' verbatim words faint behind both.
 * The tones are decided in `bookRowPresentation`; this only draws them.
 */
export function RowDetail({ detail, lead = true }: RowDetailProps) {
  if (detail === undefined || detail.length === 0) return null;
  return (
    <>
      {detail.map((part, index) => (
        <span className={`book-status-${part.tone}`} key={`${index}-${part.text}`}>
          {index === 0 && !lead ? '' : ' · '}
          {part.text}
        </span>
      ))}
    </>
  );
}

/**
 * The verdict itself: the status word and, joined to it on the same middle dot
 * and in the same ink, who put the row in it. `source` is not a qualifier of
 * the status — it is the other half of the same sentence — so it never drops
 * to the muted ink the clauses after it use.
 */
export function RowVerdict({ presentation }: { presentation: BookRowPresentation }) {
  return (
    <>
      {presentation.label}
      {presentation.source === undefined ? null : ` · ${presentation.source}`}
    </>
  );
}
