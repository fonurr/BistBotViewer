import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { logClient } from '../../bistApi/logClient';
import type {
  ApiLogQueryResult,
  ErrorLogQueryResult,
  LogExtents,
  LogQueryInput,
  LogQueryResult,
  WireLogQueryResult,
} from '../../bistApi/logTypes';
import { LogsDrawer } from './LogsDrawer';
import { formatDateKey, rangeToMilliseconds, shiftDateKey, todayInIstanbul } from './logsModel';

vi.mock('../../bistApi/logClient', () => ({
  logClient: {
    extents: vi.fn(),
    query: vi.fn(),
  },
}));

const ERROR_COUNTS = {
  MatriksConnectionError: 0,
  MatriksFieldNotFound: 0,
  Unspecified: 0,
  BarsDataError: 0,
  AccountNotFound: 1,
  AccountInformationUnavailable: 0,
  AccountFeedSilent: 0,
  OrderAccountMismatch: 0,
};
const TRAFFIC_COUNTS = {
  routine: 1,
  action: 0,
  unexpected: 0,
  error: 0,
};

let today: string;
let dayStart: number;
let extents: LogExtents;

function errorResult(ids = [3], total = ids.length): ErrorLogQueryResult {
  return {
    source: 'errors',
    rows: ids.map((id) => ({
      id,
      time: dayStart + id * 1_000,
      type: 'AccountNotFound' as const,
      information: `error detail ${id}`,
      accountId: id === 3 ? '115' : null,
      brokerageId: id === 3 ? '0~2409655' : null,
      context: id === 3 ? 'MX-3' : null,
    })),
    total,
    countsByType: { ...ERROR_COUNTS, AccountNotFound: total },
    extent: extents.errors,
  };
}

function wireResult(): WireLogQueryResult {
  return {
    source: 'wire',
    rows: [
      {
        id: 2,
        at: dayStart + 2_000,
        atText: `${today} 00:00:02.000`,
        target: 'matriks',
        direction: 'out',
        type: 'routine',
        operation: 'GetOrders',
        apiCommand: 1,
        ref: null,
        latencyMs: null,
        accountId: null,
        brokerageId: null,
        symbol: null,
        clientOrderId: null,
        orderId: null,
        ordStatus: null,
        note: null,
        body: '{"botId":"viewer"}',
        truncated: 0,
      },
    ],
    total: 1,
    countsByType: TRAFFIC_COUNTS,
    operationCounts: { values: [{ value: 'GetOrders', count: 1 }], complete: true },
    extent: extents.wire,
  };
}

function apiResult(): ApiLogQueryResult {
  return {
    source: 'api',
    rows: [
      {
        id: 1,
        at: dayStart + 1_000,
        atText: `${today} 00:00:01.000`,
        type: 'routine',
        method: 'POST',
        path: '/api/GetBots',
        botId: 'viewer',
        status: 200,
        durationMs: 4,
        requestBody: '{}',
        responseBody: '[]',
        errorType: null,
        note: null,
        truncated: 0,
      },
    ],
    total: 1,
    countsByType: TRAFFIC_COUNTS,
    pathCounts: { values: [{ value: '/api/GetBots', count: 1 }], complete: true },
    extent: extents.api,
  };
}

function installDefaultQueries(): void {
  vi.mocked(logClient.extents).mockResolvedValue(extents);
  vi.mocked(logClient.query).mockImplementation(async (rawInput) => {
    const input = rawInput as LogQueryInput;
    if (input.source === 'errors') return errorResult() as LogQueryResult;
    if (input.source === 'wire') return wireResult() as LogQueryResult;
    return apiResult() as LogQueryResult;
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  today = todayInIstanbul();
  dayStart = rangeToMilliseconds({ from: today, to: today }).fromMs;
  extents = {
    errors: { minMs: dayStart, maxMs: dayStart + 3_000 },
    wire: { minMs: dayStart, maxMs: dayStart + 2_000 },
    api: { minMs: dayStart, maxMs: dayStart + 1_000 },
  };
  installDefaultQueries();
});

describe('LogsDrawer', () => {
  it('shows exactly the three source tabs and expands and copies a wire payload', async () => {
    const user = userEvent.setup();
    const writeText = vi.spyOn(navigator.clipboard, 'writeText');
    render(<LogsDrawer open onClose={vi.fn()} />);

    expect(screen.getAllByRole('tab').map((tab) => tab.textContent)).toEqual([
      'Errors',
      'Wire log',
      'API log',
    ]);
    await screen.findByText(`1 of 1 in ${formatToday()} · newest first`);
    expect(screen.getByText('error detail 3')).toBeInTheDocument();
    expect(logClient.query).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole('tab', { name: 'Wire log' }));
    await screen.findByText('GetOrders');

    const expandButtons = screen.getAllByRole('button', { name: /Expand/ });
    await user.click(expandButtons[0]!);
    expect(document.querySelector('.logs-payload-panel pre')).toHaveTextContent(
      '"botId": "viewer"',
    );
    await user.click(screen.getByRole('button', { name: 'Copy' }));
    expect(writeText).toHaveBeenCalledWith(expect.stringContaining('"botId": "viewer"'));
    expect(await screen.findByText('Copied')).toBeInTheDocument();
  });

  it('pages with the final server-ordered id while keeping totals and counts stable', async () => {
    const firstIds = Array.from({ length: 100 }, (_, index) => 101 - index);
    vi.mocked(logClient.query).mockImplementation(async (rawInput) => {
      const input = rawInput as LogQueryInput;
      if (input.source === 'errors') {
        return (
          input.beforeId === 2
            ? {
                ...errorResult([1], 999),
                countsByType: { ...ERROR_COUNTS, AccountNotFound: 999 },
              }
            : errorResult(firstIds, 101)
        ) as LogQueryResult;
      }
      if (input.source === 'wire') return wireResult() as LogQueryResult;
      return apiResult() as LogQueryResult;
    });
    const user = userEvent.setup();
    render(<LogsDrawer open onClose={vi.fn()} />);
    await screen.findByText(`100 of 101 in ${formatToday()} · newest first`);
    expect(screen.getByRole('button', { name: 'AccountNotFound 101' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'information' }));
    await screen.findByText(`100 of 101 in ${formatToday()} · sorted by information, descending`);
    await user.click(screen.getByRole('button', { name: 'Older 1' }));
    await screen.findByText(`101 of 101 in ${formatToday()} · sorted by information, descending`);
    expect(screen.getByRole('button', { name: 'AccountNotFound 101' })).toBeInTheDocument();
    expect(logClient.query).toHaveBeenCalledWith(
      expect.objectContaining({
        source: 'errors',
        beforeId: 2,
        limit: 100,
      }),
    );
  });

  it('keeps independent Today ranges and reports the nearest stored day without clamping', async () => {
    const user = userEvent.setup();
    const storedDay = shiftDateKey(today, -3);
    const storedWindow = rangeToMilliseconds({ from: storedDay, to: storedDay });
    const todayWindow = rangeToMilliseconds({ from: today, to: today });
    extents = {
      ...extents,
      errors: {
        minMs: storedWindow.fromMs + 1_000,
        maxMs: storedWindow.fromMs + 3_000,
      },
    };
    const noErrors: ErrorLogQueryResult = {
      source: 'errors',
      rows: [],
      total: 0,
      countsByType: { ...ERROR_COUNTS, AccountNotFound: 0 },
      extent: extents.errors,
    };
    const storedErrors: ErrorLogQueryResult = {
      source: 'errors',
      rows: [
        {
          id: 3,
          time: storedWindow.fromMs + 3_000,
          type: 'AccountNotFound',
          information: 'historical error',
          accountId: null,
          brokerageId: null,
          context: null,
        },
      ],
      total: 1,
      countsByType: ERROR_COUNTS,
      extent: extents.errors,
    };
    vi.mocked(logClient.extents).mockResolvedValue(extents);
    vi.mocked(logClient.query).mockImplementation(async (rawInput) => {
      const input = rawInput as LogQueryInput;
      if (input.source === 'wire') return wireResult() as LogQueryResult;
      if (input.source === 'api') return apiResult() as LogQueryResult;
      return (
        input.fromMs === storedWindow.fromMs && input.untilMs === storedWindow.untilMs
          ? storedErrors
          : noErrors
      ) as LogQueryResult;
    });

    render(<LogsDrawer open onClose={vi.fn()} />);

    await waitFor(() =>
      expect(logClient.query).toHaveBeenCalledWith(
        expect.objectContaining({
          source: 'errors',
          fromMs: todayWindow.fromMs,
          untilMs: todayWindow.untilMs,
        }),
      ),
    );
    expect(screen.getByRole('button', { name: /Today/ })).toBeInTheDocument();
    expect(
      await screen.findByText(
        new RegExp(`The nearest day this log holds one is ${formatDateKey(storedDay)}`),
      ),
    ).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /Today/ }));
    await user.click(screen.getByRole('button', { name: 'everything' }));
    await screen.findByText('historical error');

    await user.click(screen.getByRole('tab', { name: 'Wire log' }));
    expect(screen.getByRole('button', { name: /Today/ })).toBeInTheDocument();
    await user.click(screen.getByRole('tab', { name: 'API log' }));
    expect(screen.getByRole('button', { name: /Today/ })).toBeInTheDocument();

    await user.click(screen.getByRole('tab', { name: 'Errors' }));
    await screen.findByText('historical error');
    await user.click(screen.getByRole('button', { name: /Everything/ }));
    await user.click(screen.getByRole('button', { name: 'Today' }));

    expect(screen.getByRole('button', { expanded: true })).toHaveTextContent('Today');
    expect(
      await screen.findByText(
        new RegExp(`The nearest day this log holds one is ${formatDateKey(storedDay)}`),
      ),
    ).toBeInTheDocument();
  });

  it('describes the active display order instead of always claiming newest first', async () => {
    const user = userEvent.setup();
    render(<LogsDrawer open onClose={vi.fn()} />);

    await screen.findByText(`1 of 1 in ${formatToday()} · newest first`);
    await user.click(screen.getByRole('button', { name: 'time' }));
    await screen.findByText(`1 of 1 in ${formatToday()} · oldest first`);

    await user.click(screen.getByRole('button', { name: 'type' }));
    await screen.findByText(`1 of 1 in ${formatToday()} · sorted by type, descending`);
    expect(screen.queryByText(/newest first/)).not.toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: /type/i })).toHaveAttribute(
      'aria-sort',
      'descending',
    );
  });

  it('closes the range popover before the drawer and restores invoking focus', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    const trigger = document.createElement('button');
    trigger.textContent = 'Open logs';
    document.body.append(trigger);
    trigger.focus();

    const { rerender } = render(<LogsDrawer open onClose={onClose} />);
    const close = screen.getByRole('button', { name: 'Close' });
    await waitFor(() => expect(close).toHaveFocus());
    await screen.findByText(`1 of 1 in ${formatToday()} · newest first`);

    const rangeButton = screen.getByRole('button', { name: /Today/ });
    await user.click(rangeButton);
    expect(screen.getByRole('dialog', { name: 'Days in error log' })).toBeInTheDocument();

    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog', { name: 'Days in error log' })).not.toBeInTheDocument();
    await waitFor(() => expect(rangeButton).toHaveFocus());

    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
    rerender(<LogsDrawer open={false} onClose={onClose} />);
    expect(trigger).toHaveFocus();
  });

  it('filters the wire log by operation on the server and keeps the list while boxes are ticked', async () => {
    const operations = [
      { value: 'Heartbeat', count: 5 },
      { value: 'GetOrders', count: 3 },
      { value: 'SendOrder', count: 1 },
    ];
    vi.mocked(logClient.query).mockImplementation(async (rawInput) => {
      const input = rawInput as LogQueryInput;
      if (input.source === 'errors') return errorResult() as LogQueryResult;
      if (input.source === 'api') return apiResult() as LogQueryResult;
      const base = wireResult();
      const kept = operations.filter(
        (entry) => !input.operations || input.operations.includes(entry.value),
      );
      return {
        ...base,
        rows: kept.map((entry, index) => ({
          ...base.rows[0]!,
          id: 10 + index,
          operation: entry.value,
        })),
        total: kept.reduce((total, entry) => total + entry.count, 0),
        countsByType: { ...TRAFFIC_COUNTS, routine: 9 },
        operationCounts: { values: operations, complete: true },
      } as LogQueryResult;
    });
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<LogsDrawer open onClose={onClose} />);
    await screen.findByText(`1 of 1 in ${formatToday()} · newest first`);
    expect(screen.queryByRole('button', { name: /operation/ })).not.toBeInTheDocument();

    await user.click(screen.getByRole('tab', { name: 'Wire log' }));
    const trigger = await screen.findByRole('button', { name: '3 operations' });
    await user.click(trigger);
    const popover = screen.getByRole('dialog', { name: '3 operations filter' });
    expect(
      within(popover)
        .getAllByRole('checkbox')
        .map((box) => box.closest('label')?.textContent),
    ).toEqual(['GetOrders3', 'Heartbeat5', 'SendOrder1']);

    await user.click(within(popover).getByRole('button', { name: 'none' }));
    expect(
      await screen.findByText(`No operation is ticked, so no row in ${formatToday()} is shown.`),
    ).toBeInTheDocument();
    expect(logClient.query).toHaveBeenLastCalledWith(
      expect.objectContaining({ source: 'wire', operations: [] }),
    );

    // The list is the range's, not the page's, so it survives each reload.
    await user.click(within(popover).getByRole('checkbox', { name: /^SendOrder/ }));
    await screen.findByText(`1 of 1 in ${formatToday()} · newest first`);
    await user.click(within(popover).getByRole('checkbox', { name: /^GetOrders/ }));
    await screen.findByText(`2 of 4 in ${formatToday()} · newest first`);
    expect(logClient.query).toHaveBeenLastCalledWith(
      expect.objectContaining({ source: 'wire', operations: ['GetOrders', 'SendOrder'] }),
    );
    expect(screen.getByRole('button', { name: '2 operations' })).toBeInTheDocument();

    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog', { name: /operations filter/ })).not.toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.getByRole('button', { name: '2 operations' })).toHaveFocus());

    // Each tab keeps its own selection: the API log asks for every path.
    await user.click(screen.getByRole('tab', { name: 'API log' }));
    await screen.findByRole('button', { name: '1 path' });
    expect(logClient.query).toHaveBeenLastCalledWith(
      expect.not.objectContaining({ paths: expect.anything() }),
    );
  });

  it('filters the API log by path and names the empty result', async () => {
    vi.mocked(logClient.query).mockImplementation(async (rawInput) => {
      const input = rawInput as LogQueryInput;
      if (input.source === 'errors') return errorResult() as LogQueryResult;
      if (input.source === 'wire') return wireResult() as LogQueryResult;
      const base = apiResult();
      const matching = !input.paths || input.paths.includes('/api/GetBots');
      return {
        ...base,
        rows: matching ? base.rows : [],
        total: matching ? 1 : 0,
        pathCounts: {
          values: [
            { value: '/api/GetBots', count: 1 },
            { value: '/api/SendOrders', count: 0 },
          ],
          complete: false,
        },
      } as LogQueryResult;
    });
    const user = userEvent.setup();
    render(<LogsDrawer open onClose={vi.fn()} />);
    await user.click(screen.getByRole('tab', { name: 'API log' }));
    await user.click(await screen.findByRole('button', { name: '2 paths' }));
    const popover = screen.getByRole('dialog', { name: '2 paths filter' });
    expect(popover).toHaveTextContent('These days hold more than 200 paths');

    await user.click(within(popover).getByRole('checkbox', { name: /^\/api\/GetBots/ }));
    expect(logClient.query).toHaveBeenLastCalledWith(
      expect.objectContaining({ source: 'api', paths: ['/api/SendOrders'] }),
    );
    expect(
      await screen.findByText(
        `No row in ${formatToday()} matches the ticked paths. The counts show what these days hold.`,
      ),
    ).toBeInTheDocument();

    await user.click(within(popover).getByRole('button', { name: 'all' }));
    await screen.findByText(`1 of 1 in ${formatToday()} · newest first`);
    expect(screen.getByRole('button', { name: '2 paths' })).toBeInTheDocument();
  });
});

function formatToday(): string {
  const [year, month, day] = today.split('-');
  return `${day}.${month}.${year.slice(-2)}`;
}
