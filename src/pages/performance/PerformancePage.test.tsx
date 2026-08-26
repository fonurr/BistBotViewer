import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import type { ReactElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { CanceledOrder } from '../../bistApi/types';
import {
  FIXTURE_DAY,
  FIXTURE_NOW_MS,
  makeAccount,
  makeBot,
  makeBotBudget,
  makeClosedTrade,
  makePerformanceReadFixture,
} from '../../test/fixtures';
import { PerformancePage, scopeCanceledRetries, shouldPollClosingBars } from './PerformancePage';

const api = vi.hoisted(() => ({
  getBots: vi.fn(),
  getAccounts: vi.fn(),
  getClosedTrades: vi.fn(),
  getCanceledOrders: vi.fn(),
  getHolidays: vi.fn(),
  getBotBudget: vi.fn(),
}));

const price = vi.hoisted(() => ({
  getClosingAuctionBars: vi.fn(),
}));

vi.mock('../../bistApi/client', () => ({ bistApi: api }));
vi.mock('../../priceApi/client', () => ({ priceApi: price }));

beforeEach(() => {
  Object.values(api).forEach((mock) => mock.mockReset());
  price.getClosingAuctionBars.mockReset();
  vi.spyOn(Date, 'now').mockReturnValue(FIXTURE_NOW_MS);
  useFixture();
});

describe('Performance source trust', () => {
  it('polls only while a required current-session closing bar is still unavailable', () => {
    const required = [{ symbol: 'THYAO', sessionDate: FIXTURE_DAY }];

    expect(shouldPollClosingBars(required, [], FIXTURE_DAY)).toBe(true);
    expect(
      shouldPollClosingBars(
        required,
        [{ symbol: 'THYAO', sessionDate: FIXTURE_DAY, close: 306, volume: 10, barTs: 1 }],
        FIXTURE_DAY,
      ),
    ).toBe(false);
    expect(shouldPollClosingBars(required, [], '2026-08-26')).toBe(false);
  });

  it.each([
    ['getBots', 'GetBots'],
    ['getAccounts', 'GetAccounts'],
    ['getClosedTrades', 'GetClosedTrades'],
    ['getCanceledOrders', 'GetCanceledOrders'],
    ['getHolidays', 'GetHolidays'],
  ] as const)('withholds derived claims when %s fails', async (method, label) => {
    api[method].mockRejectedValueOnce(new Error(`${label} unavailable`));

    renderPerformance();

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Performance reads are incomplete.');
    expect(alert).toHaveTextContent(`${label} unavailable`);
    expect(screen.queryByText('configured limits')).not.toBeInTheDocument();
    expect(screen.queryByText('the retry ledger')).not.toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
    expect(screen.queryByText(/· 0 trades$/)).not.toBeInTheDocument();
    expect(price.getClosingAuctionBars).not.toHaveBeenCalled();
  });

  it('does not call an unresolved bars read missing data', async () => {
    price.getClosingAuctionBars.mockReturnValueOnce(new Promise(() => undefined));

    renderPerformance();

    expect(await screen.findByLabelText('Loading closing-auction bars')).toBeInTheDocument();
    expect(screen.queryByText('configured limits')).not.toBeInTheDocument();
    expect(screen.queryByText(/boundary bars (?:are )?missing/i)).not.toBeInTheDocument();
  });

  it('reports a failed bars read as unavailable rather than missing', async () => {
    price.getClosingAuctionBars.mockRejectedValueOnce(new Error('bars service unavailable'));

    renderPerformance();

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Closing-bar comparison unavailable.');
    expect(alert).toHaveTextContent('bars service unavailable');
    expect(
      screen.getByRole('cell', { name: 'bars.db read failed; availability unknown' }),
    ).toBeInTheDocument();
    expect(
      screen.queryByText(/\d+ required hold-boundary bars are missing/i),
    ).not.toBeInTheDocument();
  });

  it('distinguishes a successful empty bars read with explicit no-bars copy', async () => {
    renderPerformance();

    expect(await screen.findByText(/No closing-auction bars were returned/)).toBeInTheDocument();
    const symbolRow = screen.getByRole('cell', { name: 'THYAO' }).closest('tr');
    expect(symbolRow).not.toBeNull();
    expect(within(symbolRow!).getByRole('cell', { name: /no bars/ })).toBeInTheDocument();
    expect(
      within(symbolRow!).getByRole('cell', { name: '1 boundary bars missing' }),
    ).toBeInTheDocument();
  });
});

describe('Performance scope and unavailable values', () => {
  it('scopes canceled retry edges by bot, symbol, and Istanbul cancellation date', () => {
    const rows = [
      canceled({ id: 1 }),
      canceled({ id: 2, botId: 'bot-beta' }),
      canceled({ id: 3, symbol: 'GARAN' }),
      canceled({ id: 4, cancelTime: Date.parse('2026-08-24T12:00:00+03:00') }),
      canceled({ id: 5, cancelTime: null }),
      canceled({ id: 6, retryOfClientOrderId: null }),
    ];

    const result = scopeCanceledRetries(rows, {
      scopedBot: 'bot-alpha',
      accountKey: '*',
      symbols: ['THYAO'],
      from: FIXTURE_DAY,
      to: FIXTURE_DAY,
    });

    expect(result.rows.map((row) => row.id)).toEqual([1]);
    expect(result.excludedUntimed).toBe(1);
    expect(result.accountAttributionUnavailable).toBe(false);

    expect(
      scopeCanceledRetries(rows, {
        scopedBot: 'bot-alpha',
        accountKey: 'ACC-1:BRK-1',
        symbols: ['THYAO'],
        from: FIXTURE_DAY,
        to: FIXTURE_DAY,
      }),
    ).toEqual({ rows: [], excludedUntimed: 0, accountAttributionUnavailable: true });
  });

  it('keeps identical account numbers at different brokerages separately selectable', async () => {
    const user = userEvent.setup();
    const fixture = makePerformanceReadFixture();
    fixture.bots = [
      makeBot(),
      makeBot({
        id: 'bot-beta',
        brokerageId: 'BRK-2',
        limit: 700_000,
      }),
    ];
    fixture.accounts = [
      makeAccount(),
      makeAccount({
        brokerageId: 'BRK-2',
        brokerageName: 'Second Brokerage',
        owner: 'Second Owner',
      }),
    ];
    fixture.closedTrades = [
      makeClosedTrade(),
      makeClosedTrade({
        id: 302,
        botId: 'bot-beta',
        brokerageId: 'BRK-2',
        chainId: 'chain-beta-roundtrip',
      }),
    ];
    fixture.budgets = {
      'bot-alpha': makeBotBudget(),
      'bot-beta': makeBotBudget({ limit: 700_000, remainingBotBudget: 650_000 }),
    };
    useFixture(fixture);

    renderPerformance();

    await user.click(await screen.findByRole('button', { name: '2 accounts' }));
    const accountFilter = screen.getByRole('dialog', { name: /accounts filter/i });
    // Matching account numbers at different brokerages stay distinct choices.
    const first = within(accountFilter).getByRole('radio', { name: /ACC-1.*BRK-1.*Fixture Owner/ });
    const second = within(accountFilter).getByRole('radio', { name: /ACC-1.*BRK-2.*Second Owner/ });
    expect(first).not.toBe(second);

    await user.click(second);
    expect(await screen.findByRole('button', { name: '1 account' })).toBeVisible();

    await screen.findByText(/· 1 trade$/);
    const accountSection = screen.getByText('by account').closest('section');
    expect(accountSection).not.toBeNull();
    expect(within(accountSection!).getByRole('cell', { name: 'BRK-2' })).toBeInTheDocument();
    expect(within(accountSection!).queryByRole('cell', { name: 'BRK-1' })).not.toBeInTheDocument();
  });

  it('uses warning ink for unavailable win and loss averages', async () => {
    const fixture = makePerformanceReadFixture();
    fixture.closedTrades = [
      makeClosedTrade({ averageOpenPrice: 300, averageClosePrice: 300, openOrderPrice: 300 }),
    ];
    useFixture(fixture);

    renderPerformance();

    await screen.findByText('configured limits');
    for (const label of ['avg win', 'avg loss']) {
      const stat = screen
        .getAllByText(label)
        .map((element) => element.closest('.performance-stat') as HTMLElement | null)
        .find((element) => element !== null);
      expect(stat).not.toBeNull();
      const value = within(stat!).getByText('not available');
      expect(value.tagName).toBe('STRONG');
      expect(value).toHaveClass('status-warn');
      expect(value).not.toHaveClass('number-positive');
      expect(value).not.toHaveClass('number-negative');
    }
  });

  it('keeps configured limits while a current commitment read is unavailable', async () => {
    api.getBotBudget.mockRejectedValueOnce(new Error('budget unavailable'));

    renderPerformance();

    const label = await screen.findByText('configured limits');
    const stat = label.closest('.performance-stat') as HTMLElement | null;
    expect(stat).not.toBeNull();
    expect(within(stat!).getByText('500.000')).toBeInTheDocument();
    expect(within(stat!).getByText('current committed amount unavailable')).toHaveClass(
      'status-warn',
    );
    expect(
      within(stat!).getByText(
        '1 bot · fleet scope; window and symbol filters do not change these limits',
      ),
    ).toBeInTheDocument();
    expect(within(stat!).queryByText(/0 currently committed/i)).not.toBeInTheDocument();
  });

  it('does not invent zero commitment when every selected bot is incomplete', async () => {
    const fixture = makePerformanceReadFixture();
    fixture.bots = [makeBot({ complete: false })];
    useFixture(fixture);

    renderPerformance();

    const label = await screen.findByText('configured limits');
    const stat = label.closest('.performance-stat') as HTMLElement | null;
    expect(stat).not.toBeNull();
    expect(within(stat!).getByText(/current committed amount unavailable/)).toHaveClass(
      'status-warn',
    );
    expect(within(stat!).queryByText(/0 currently committed/i)).not.toBeInTheDocument();
    expect(api.getBotBudget).not.toHaveBeenCalled();
  });
});

describe('Performance curve honesty', () => {
  it('draws a single observed day as a point rather than a rise across the window', async () => {
    renderPerformance();
    await screen.findByText('cumulative realized');

    const curve = document.querySelector('.curve-wrap')!;
    expect(curve.querySelector('polyline')).toBeNull();
    expect(curve.querySelector('polygon')).toBeNull();
    expect(curve.querySelector('circle.curve-end')).not.toBeNull();
    expect(screen.getByText('one observed day · no curve to draw')).toBeVisible();
  });

  it('draws the path once a second day exists', async () => {
    useFixture({
      ...makePerformanceReadFixture(),
      closedTrades: [
        makeClosedTrade(),
        makeClosedTrade({
          id: 302,
          positionId: 'position-thyao-second',
          chainId: 'chain-thyao-second',
          clientOpenOrderId: 'client-thyao-second-open',
          clientCloseOrderId: 'client-thyao-second-close',
          closeExecuteTime: Date.parse('2026-08-24T15:00:00+03:00'),
          closeOrderTime: Date.parse('2026-08-24T14:59:00+03:00'),
        }),
      ],
    });
    renderPerformance();
    await screen.findByText('cumulative realized');

    const curve = document.querySelector('.curve-wrap')!;
    expect(curve.querySelector('polyline')).not.toBeNull();
    expect(screen.queryByText('one observed day · no curve to draw')).not.toBeInTheDocument();
  });
});

function renderPerformance(entry = '/performance') {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: Number.POSITIVE_INFINITY },
      mutations: { retry: false },
    },
  });
  return renderWithProviders(<PerformancePage />, queryClient, entry);
}

function renderWithProviders(element: ReactElement, queryClient: QueryClient, entry: string) {
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[entry]}>{element}</MemoryRouter>
    </QueryClientProvider>,
  );
}

function useFixture(fixture = makePerformanceReadFixture()) {
  api.getBots.mockResolvedValue(fixture.bots);
  api.getAccounts.mockResolvedValue(fixture.accounts);
  api.getClosedTrades.mockResolvedValue(fixture.closedTrades);
  api.getCanceledOrders.mockResolvedValue(fixture.canceledOrders);
  api.getHolidays.mockResolvedValue(fixture.holidays);
  api.getBotBudget.mockImplementation((botId: string) => Promise.resolve(fixture.budgets[botId]));
  price.getClosingAuctionBars.mockResolvedValue([]);
}

function canceled(overrides: Partial<CanceledOrder> = {}): CanceledOrder {
  return {
    id: 1,
    botId: 'bot-alpha',
    clientOrderId: 'canceled-thyao',
    matriksOrderId: 'mx-canceled-thyao',
    matriksOrderId2: null,
    symbol: 'THYAO',
    orderTime: Date.parse('2026-08-25T10:00:00+03:00'),
    sentTime: Date.parse('2026-08-25T10:00:01+03:00'),
    cancelTime: Date.parse('2026-08-25T10:05:00+03:00'),
    orderQuantity: 10,
    canceledQuantity: 10,
    direction: 'sell',
    type: 'limit',
    orderPrice: 300,
    timeInForce: '0',
    status: 'Rejected',
    explanation: null,
    retryCount: 1,
    intentType: 'limit',
    cancelAtFloor: false,
    chainId: 'chain-thyao-roundtrip',
    parentClientOrderId: null,
    retryOfClientOrderId: 'previous-thyao-sell',
    ...overrides,
  };
}
