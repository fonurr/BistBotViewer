import { useRef, type KeyboardEvent, type PointerEvent } from 'react';

import {
  displayCellValue,
  payloadPreview,
  payloadText,
  rowKey,
  type LogColumn,
  type LogEnvelope,
  type SortDirection,
} from './logsModel';

interface LogsTableProps {
  rows: readonly LogEnvelope[];
  columns: readonly LogColumn[];
  widths: Readonly<Record<string, number>>;
  sort: { key: string; direction: SortDirection };
  expandedCell: string | null;
  copyFeedback: { key: string; message: string } | null;
  onSort: (key: string) => void;
  onResize: (key: string, width: number) => void;
  onTogglePayload: (key: string) => void;
  onCopyPayload: (key: string, text: string) => void;
}

const MIN_COLUMN_WIDTH = 64;
const MAX_COLUMN_WIDTH = 1_200;
const KEYBOARD_RESIZE_STEP = 16;

function cellTone(entry: LogEnvelope, column: LogColumn): string {
  const value = column.value(entry);
  if (column.key === 'type') {
    if (
      value === 'OrderAccountMismatch' ||
      value === 'AccountFeedSilent' ||
      value === 'AccountNotFound' ||
      value === 'AccountInformationUnavailable' ||
      value === 'BarsDataError' ||
      value === 'unexpected'
    ) {
      return 'logs-cell--warn';
    }
    if (
      value === 'MatriksConnectionError' ||
      value === 'MatriksFieldNotFound' ||
      value === 'error'
    ) {
      return 'logs-cell--dead';
    }
    if (value === 'routine') return 'logs-cell--muted';
  }
  if (column.key === 'status' && typeof value === 'number' && value >= 400) {
    return 'logs-cell--dead';
  }
  if (
    (column.key === 'latencyMs' || column.key === 'durationMs') &&
    typeof value === 'number' &&
    value > 1_000
  ) {
    return 'logs-cell--warn';
  }
  if (column.key === 'direction' && value === 'out') {
    return 'logs-cell--accent';
  }
  if (column.key === 'note' || column.key === 'context') {
    return 'logs-cell--muted';
  }
  return '';
}

function PayloadButton({
  entry,
  column,
  expanded,
  onToggle,
}: {
  entry: LogEnvelope;
  column: LogColumn;
  expanded: boolean;
  onToggle: () => void;
}) {
  const value = column.value(entry);
  if (value === null || value === undefined || value === '') return null;
  const panelId = `logs-payload-${rowKey(entry)}-${column.key}`;
  return (
    <button
      type="button"
      className="btn btn-ghost logs-payload-toggle"
      aria-expanded={expanded}
      aria-controls={panelId}
      onClick={onToggle}
    >
      <span className="logs-payload-preview">{payloadPreview(value)}</span>
      <span className="logs-payload-action">{expanded ? 'Collapse' : 'Expand'}</span>
    </button>
  );
}

export function LogsTable({
  rows,
  columns,
  widths,
  sort,
  expandedCell,
  copyFeedback,
  onSort,
  onResize,
  onTogglePayload,
  onCopyPayload,
}: LogsTableProps) {
  const drag = useRef<{
    key: string;
    pointerId: number;
    startX: number;
    startWidth: number;
  } | null>(null);
  const widthFor = (column: LogColumn) => widths[column.key] ?? column.defaultWidth;
  const tableWidth = columns.reduce((total, column) => total + widthFor(column), 0);

  const startResize = (event: PointerEvent<HTMLButtonElement>, column: LogColumn) => {
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = {
      key: column.key,
      pointerId: event.pointerId,
      startX: event.clientX,
      startWidth: widthFor(column),
    };
  };

  const moveResize = (event: PointerEvent<HTMLButtonElement>) => {
    const current = drag.current;
    if (!current || current.pointerId !== event.pointerId) return;
    onResize(
      current.key,
      Math.min(
        MAX_COLUMN_WIDTH,
        Math.max(MIN_COLUMN_WIDTH, Math.round(current.startWidth + event.clientX - current.startX)),
      ),
    );
  };

  const finishResize = (event: PointerEvent<HTMLButtonElement>) => {
    if (drag.current?.pointerId !== event.pointerId) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    drag.current = null;
  };

  const resizeWithKeyboard = (event: KeyboardEvent<HTMLButtonElement>, column: LogColumn) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    const difference = event.key === 'ArrowRight' ? KEYBOARD_RESIZE_STEP : -KEYBOARD_RESIZE_STEP;
    onResize(
      column.key,
      Math.min(MAX_COLUMN_WIDTH, Math.max(MIN_COLUMN_WIDTH, widthFor(column) + difference)),
    );
  };

  return (
    <div className="logs-table-scroll" data-testid="logs-table-scroll">
      <table className="table logs-table" style={{ width: tableWidth, minWidth: tableWidth }}>
        <colgroup>
          {columns.map((column) => (
            <col key={column.key} style={{ width: widthFor(column) }} />
          ))}
        </colgroup>
        <thead>
          <tr>
            {columns.map((column) => {
              const selected = sort.key === column.key;
              const ariaSort = selected ? sort.direction : 'none';
              const width = widthFor(column);
              return (
                <th key={column.key} scope="col" aria-sort={ariaSort}>
                  <button
                    type="button"
                    className="logs-sort-button"
                    onClick={() => onSort(column.key)}
                  >
                    <span>{column.label}</span>
                    <span aria-hidden="true" className="logs-sort-mark">
                      {selected ? (sort.direction === 'ascending' ? '↑' : '↓') : '↕'}
                    </span>
                  </button>
                  <button
                    type="button"
                    className="logs-resize-handle"
                    role="separator"
                    aria-label={`Resize ${column.label} column`}
                    aria-orientation="vertical"
                    aria-valuemin={MIN_COLUMN_WIDTH}
                    aria-valuemax={MAX_COLUMN_WIDTH}
                    aria-valuenow={width}
                    onPointerDown={(event) => startResize(event, column)}
                    onPointerMove={moveResize}
                    onPointerUp={finishResize}
                    onPointerCancel={finishResize}
                    onKeyDown={(event) => resizeWithKeyboard(event, column)}
                  />
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {rows.map((entry) => {
            const key = rowKey(entry);
            const expandedColumn = columns.find(
              (column) => column.format === 'payload' && expandedCell === `${key}:${column.key}`,
            );
            const expandedValue = expandedColumn?.value(entry);
            const expansionKey = expandedColumn ? `${key}:${expandedColumn.key}` : null;
            return (
              <LogsRow
                key={key}
                entry={entry}
                columns={columns}
                expandedColumn={expandedColumn}
                expandedValue={expandedValue}
                expansionKey={expansionKey}
                copyFeedback={copyFeedback}
                onTogglePayload={onTogglePayload}
                onCopyPayload={onCopyPayload}
              />
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function LogsRow({
  entry,
  columns,
  expandedColumn,
  expandedValue,
  expansionKey,
  copyFeedback,
  onTogglePayload,
  onCopyPayload,
}: {
  entry: LogEnvelope;
  columns: readonly LogColumn[];
  expandedColumn: LogColumn | undefined;
  expandedValue: unknown;
  expansionKey: string | null;
  copyFeedback: { key: string; message: string } | null;
  onTogglePayload: (key: string) => void;
  onCopyPayload: (key: string, text: string) => void;
}) {
  const key = rowKey(entry);
  return (
    <>
      <tr>
        {columns.map((column) => {
          const value = column.value(entry);
          const cellKey = `${key}:${column.key}`;
          return (
            <td key={column.key} className={cellTone(entry, column)}>
              {column.format === 'payload' ? (
                <PayloadButton
                  entry={entry}
                  column={column}
                  expanded={expandedCellMatches(cellKey, expansionKey)}
                  onToggle={() => onTogglePayload(cellKey)}
                />
              ) : (
                displayCellValue(value, column.format)
              )}
            </td>
          );
        })}
      </tr>
      {expandedColumn && expansionKey && expandedValue !== null && (
        <tr className="logs-payload-row">
          <td colSpan={columns.length}>
            <div className="logs-payload-panel" id={`logs-payload-${key}-${expandedColumn.key}`}>
              <div className="logs-payload-heading">
                <span className="kicker">{expandedColumn.label}</span>
                <span className="logs-payload-copy-status" aria-live="polite">
                  {copyFeedback?.key === expansionKey ? copyFeedback.message : ''}
                </span>
                <button
                  type="button"
                  className="btn btn-secondary logs-copy-button"
                  onClick={() => onCopyPayload(expansionKey, payloadText(expandedValue))}
                >
                  Copy
                </button>
              </div>
              <pre tabIndex={0}>{payloadText(expandedValue)}</pre>
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

function expandedCellMatches(cellKey: string, expansionKey: string | null): boolean {
  return cellKey === expansionKey;
}
