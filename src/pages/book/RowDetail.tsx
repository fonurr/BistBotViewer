import type { BookRowDetailPart } from './rowPresentation';

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
