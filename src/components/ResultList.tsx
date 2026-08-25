export type ResultTone = 'landed' | 'accepted' | 'refused' | 'unknown' | 'not-sent';

export interface ActionResult {
  id: string;
  label: string;
  tone: ResultTone;
  detail: string;
  word?: string;
}

const resultWord: Record<ResultTone, string> = {
  landed: 'Succeeded',
  accepted: 'Accepted',
  refused: 'Refused',
  unknown: 'No answer',
  'not-sent': 'Not sent',
};

const resultClass: Record<ResultTone, string> = {
  landed: 'status-live',
  accepted: 'status-wait',
  refused: 'status-dead',
  unknown: 'status-warn',
  'not-sent': 'muted',
};

export function ResultList({ results }: { results: readonly ActionResult[] }) {
  return (
    <div className="result-list" aria-live="polite">
      {results.map((result) => (
        <div className="result-row" key={result.id}>
          <div>
            <div className="result-label">{result.label}</div>
            <div className="result-detail">{result.detail}</div>
          </div>
          <div className={`result-word ${resultClass[result.tone]}`}>
            {result.word ?? resultWord[result.tone]}
          </div>
        </div>
      ))}
    </div>
  );
}
