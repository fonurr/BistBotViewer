import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  FIXTURE_NOW_MS,
  makeAccount,
  makeActiveOrder,
  makeCanceledOrder,
  makeAccountSnapshot,
  makeAccountTransaction,
  makeBot,
  makeBotHistoryEntry,
  makeBotSnapshot,
} from '../../test/fixtures';
import { DiaryPage } from './DiaryPage';

const api = vi.hoisted(() => ({
  getActiveOrders: vi.fn(),
  getCanceledOrders: vi.fn(),
  getPositions: vi.fn(),
  getClosedTrades: vi.fn(),
  getBots: vi.fn(),
  getAccounts: vi.fn(),
  getBotHistory: vi.fn(),
  getBotSnapshots: vi.fn(),
  getAccountSnapshots: vi.fn(),
  getAccountTransactions: vi.fn(),
  getErrors: vi.fn(),
}));

vi.mock('../../bistApi/client', () => ({ bistApi: api }));
vi.mock('../../app/ViewerRuntime', () => ({
  useViewerRuntime: () => ({ requestReconcile: vi.fn() }),
}));

const EARLIER = Date.parse('2026-08-24T06:00:00.000Z');
const NOW = Date.parse('2026-08-25T09:00:00.000Z');

beforeEach(() => {
  Object.values(api).forEach((mock) => mock.mockReset());
  vi.spyOn(Date, 'now').mockReturnValue(FIXTURE_NOW_MS);
  useFixture();
});

describe('Diary reads', () => {
  it('reads diary and Book order sources through the API and never a log database', async () => {
    renderDiary();
    await loaded();

    for (const read of [
      api.getActiveOrders,
      api.getCanceledOrders,
      api.getPositions,
      api.getClosedTrades,
    ])
      expect(read).toHaveBeenCalledWith('*');
    expect(api.getBotHistory).toHaveBeenCalledWith('*');
    expect(api.getBotSnapshots).toHaveBeenCalledWith('*');
    expect(api.getAccountSnapshots).toHaveBeenCalled();
    expect(api.getAccountTransactions).toHaveBeenCalled();
    // A bounded window, not the 24-hour default a bare GetErrors would take.
    expect(api.getErrors).toHaveBeenCalledWith(expect.objectContaining({ limit: 2_000 }));
  });

  it.each([
    ['getBotHistory', 'GetBotHistory'],
    ['getBotSnapshots', 'GetBotSnapshots'],
    ['getAccountSnapshots', 'GetAccountSnapshots'],
    ['getAccountTransactions', 'GetAccountTransactions'],
    ['getErrors', 'GetErrors'],
    ['getActiveOrders', 'GetActiveOrders'],
    ['getCanceledOrders', 'GetCanceledOrders'],
    ['getPositions', 'GetPositions'],
    ['getClosedTrades', 'GetClosedTrades'],
  ] as const)('says the diary is incomplete when %s fails', async (method, label) => {
    api[method].mockRejectedValueOnce(new Error(`${label} unavailable`));

    renderDiary();

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('The diary is incomplete.');
    expect(alert).toHaveTextContent(`${label} unavailable`);
  });
});

describe('Diary list', () => {
  it('opens the first day and leaves the rest behind their chevron', async () => {
    renderDiary();
    await loaded();

    expect(dayHeading('25.08.26')).toHaveAttribute('aria-expanded', 'true');
    expect(dayHeading('24.08.26')).toHaveAttribute('aria-expanded', 'false');
  });

  it('draws the time with a dimmed millisecond, the subject, and the description apart', async () => {
    const user = userEvent.setup();
    renderDiary();
    await loaded();
    // The cash movement is the older day's only entry, so open it.
    await user.click(dayHeading('24.08.26'));

    const row = screen.getByText('1.250,75 TL').closest<HTMLElement>('[role="row"]')!;
    expect(within(row).getByText('ACC-1 · BRK-1')).toBeInTheDocument();
    // 09:00:00 Istanbul, and the fraction is drawn apart from the seconds.
    expect(within(row).getByText('09:00:00')).toBeInTheDocument();
    expect(within(row).getByText('.000', { selector: '.diary-time-ms' })).toBeInTheDocument();
    expect(within(row).getByText('withdrawn', { exact: false })).toBeInTheDocument();
    // The description never restates the time or the subject beside it.
    expect(within(row).getByText('1.250,75 TL').textContent).not.toContain('ACC-1');
  });

  it('colours a field name, a value and an array delta apart', async () => {
    renderDiary();
    await loaded();

    expect(screen.getByText('forbidden', { selector: '.diary-ink-field' })).toBeInTheDocument();
    expect(screen.getByText('THYAO', { selector: '.diary-ink-added' })).toBeInTheDocument();
    expect(screen.getByText('500.000,00', { selector: '.diary-ink-value' })).toBeInTheDocument();
  });
});

describe('Diary toolbar', () => {
  it('reverses the reading order on one button rather than two', async () => {
    const user = userEvent.setup();
    renderDiary();
    await loaded();

    const headings = () =>
      within(list())
        .getAllByRole('button', { expanded: undefined })
        .map((button) => button.textContent ?? '');
    expect(headings()[0]).toContain('25.08.26');

    await user.click(screen.getByRole('button', { name: /Sorted newest first/ }));
    expect(headings()[0]).toContain('24.08.26');
    // The first day in the new order is the one that opens itself.
    expect(dayHeading('24.08.26')).toHaveAttribute('aria-expanded', 'true');
  });

  it('opens with every type ticked and drops a kind when one is unticked', async () => {
    const user = userEvent.setup();
    renderDiary();
    await loaded();

    expect(screen.getByRole('status')).toHaveTextContent('5 entries · 2 days');

    await user.click(screen.getByRole('button', { name: '6 types' }));
    await user.click(screen.getByRole('checkbox', { name: /Account transactions/ }));

    expect(screen.getByRole('button', { name: '5 types' })).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('4 entries of 5');
  });

  it('opens with both entity filters off and asks neither', async () => {
    const user = userEvent.setup();
    renderDiary();
    await loaded();

    expect(screen.getByRole('button', { name: 'any bot' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'any account' })).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('5 entries · 2 days');

    // Off, every box behind the switch is disabled and none of them is ticked.
    await user.click(screen.getByRole('button', { name: 'any bot' }));
    const box = screen.getByRole('checkbox', { name: /bot-alpha/ });
    expect(box).toBeDisabled();
    expect(box).not.toBeChecked();
  });

  it('drops an entry that names no bot once the bot filter is switched on', async () => {
    const user = userEvent.setup();
    renderDiary();
    await loaded();

    await user.click(screen.getByRole('button', { name: 'any bot' }));
    await user.click(screen.getByRole('checkbox', { name: 'filter' }));
    // Switching on starts from nothing ticked, so the bots come back one by one.
    await user.click(screen.getByRole('checkbox', { name: /bot-alpha/ }));
    await user.keyboard('{Escape}');

    // The bot's own budget snapshot stays; the account's own snapshot does not.
    expect(screen.getByText('budget', { selector: '.diary-ink-field' })).toBeInTheDocument();
    expect(
      screen.queryByText('portfolio', { selector: '.diary-ink-field' }),
    ).not.toBeInTheDocument();
  });

  it('drops an error the server could not attribute while the account filter is on', async () => {
    const user = userEvent.setup();
    api.getErrors.mockResolvedValue([
      {
        id: 1,
        time: NOW,
        type: 'BarsDataError',
        information: '',
        accountId: null,
        brokerageId: null,
        context: null,
      },
    ]);
    renderDiary();
    await loaded();

    expect(screen.getByText('BarsDataError')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'any account' }));
    await user.click(screen.getByRole('checkbox', { name: 'filter' }));
    await user.click(screen.getByRole('checkbox', { name: /ACC-1/ }));
    await user.keyboard('{Escape}');

    // It names no account, so it is not one of the entries the filter asked for.
    expect(screen.queryByText('BarsDataError')).not.toBeInTheDocument();
    expect(screen.getByText('portfolio', { selector: '.diary-ink-field' })).toBeInTheDocument();
  });

  it('filters order stages with the account-style switch, all and none, and combines origins and symbols', async () => {
    const user = userEvent.setup();
    api.getActiveOrders.mockResolvedValue([
      makeActiveOrder({ origin: 'User', filledQuantity: 10, status: 'PartiallyFilled' }),
    ]);
    api.getCanceledOrders.mockResolvedValue([
      makeCanceledOrder({ status: 'Rejected', reason: 'InsufficientFunds' }),
    ]);
    renderDiary();
    await loaded();
    expect(screen.getByText('Fill time unavailable')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'any order stage' }));
    for (const stage of ['scheduled', 'sent', 'canceled', 'filled']) {
      expect(screen.getByRole('checkbox', { name: stage })).not.toBeChecked();
      expect(screen.getByRole('checkbox', { name: stage })).toBeDisabled();
    }
    await user.click(screen.getByRole('checkbox', { name: 'filter' }));
    expect(screen.getByRole('status')).toHaveTextContent('0 entries');
    await user.click(screen.getByRole('button', { name: 'all' }));
    expect(screen.getByRole('status')).toHaveTextContent('6 entries of 11');
    await user.click(screen.getByRole('button', { name: 'none' }));
    await user.click(screen.getByRole('checkbox', { name: 'filled' }));
    await user.keyboard('{Escape}');
    expect(screen.getByRole('status')).toHaveTextContent('1 entry of 11');
    expect(screen.getByText('partly filled')).toHaveClass('diary-ink-wait');
    expect(screen.queryByText('budget', { selector: '.diary-ink-field' })).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'any origin' }));
    await user.click(screen.getByRole('checkbox', { name: 'filter' }));
    await user.click(screen.getByRole('checkbox', { name: 'User' }));
    await user.keyboard('{Escape}');
    await user.click(screen.getByRole('button', { name: 'any symbol' }));
    await user.click(screen.getByRole('button', { name: 'THYAO' }));
    await user.keyboard('{Escape}');
    expect(screen.getByRole('status')).toHaveTextContent('0 entries');

    await user.click(screen.getByRole('button', { name: '1 stage' }));
    await user.click(screen.getByRole('checkbox', { name: 'filter' }));
    expect(screen.getByRole('checkbox', { name: 'filled' })).not.toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'filled' })).toBeDisabled();
  });

  it('warns when the error read stopped at its own cap rather than at the data', async () => {
    const user = userEvent.setup();
    // Dated onto an older day on purpose: only the first day expands, so the
    // cap is proven without asking jsdom to draw two thousand rows.
    const oldDay = Date.parse('2026-08-20T09:00:00.000Z');
    api.getErrors.mockResolvedValue(
      Array.from({ length: 2_000 }, (_, index) => ({
        id: index + 1,
        time: oldDay - index,
        type: 'BarsDataError',
        information: '',
        accountId: null,
        brokerageId: null,
        context: null,
      })),
    );

    renderDiary();
    await loaded();
    await user.click(screen.getByRole('button', { name: '6 types' }));

    expect(screen.getByText(/reach only as far back as/)).toBeInTheDocument();
  });
});

function list(): HTMLElement {
  return screen.getByRole('table', { name: 'Diary entries' });
}

/** The day heading inside the list, which the range trigger above it also names. */
function dayHeading(date: string): HTMLElement {
  return within(list()).getByRole('button', {
    name: new RegExp(`^${date.replaceAll('.', '\\.')}`),
  });
}

/** The reads are in once the list has drawn a day. */
async function loaded() {
  await screen.findByText('25.08.26', { selector: '.diary-date' });
}

function renderDiary() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: Number.POSITIVE_INFINITY },
      mutations: { retry: false },
    },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={['/diary']}>
        <DiaryPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function useFixture() {
  api.getActiveOrders.mockResolvedValue([]);
  api.getCanceledOrders.mockResolvedValue([]);
  api.getPositions.mockResolvedValue([]);
  api.getClosedTrades.mockResolvedValue([]);
  api.getBots.mockResolvedValue([makeBot({ forbiddenStocks: ['THYAO'], startTime: NOW })]);
  api.getAccounts.mockResolvedValue([makeAccount()]);
  api.getBotHistory.mockResolvedValue([
    makeBotHistoryEntry({ forbiddenStocks: [], startTime: EARLIER, endTime: NOW }),
  ]);
  api.getBotSnapshots.mockResolvedValue([makeBotSnapshot({ time: NOW })]);
  api.getAccountSnapshots.mockResolvedValue([makeAccountSnapshot({ time: NOW })]);
  api.getAccountTransactions.mockResolvedValue([
    makeAccountTransaction({ time: EARLIER, amount: -1_250.75 }),
  ]);
  api.getErrors.mockResolvedValue([]);
}
