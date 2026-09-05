import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ResolvedPrice } from '../../priceApi/types';
import {
  makeAccount,
  makeActiveOrder,
  makeBot,
  makeBotBudget,
  makeCanceledOrder,
  makeClosedTrade,
  makeErrorRow,
  makePendingOrderRequest,
  makePosition,
  makeResolvedPrice,
} from '../../test/fixtures';
import { BookPage } from './BookPage';

const book = vi.hoisted(() => ({
  data: {} as Record<string, unknown>,
  prices: {
    trustworthy: true,
    prices: new Map<string, ResolvedPrice>(),
    error: null,
    isPending: false,
  },
}));

vi.mock('../../app/dataHooks', () => ({
  useBookData: () => book.data,
  useFleetPrices: () => book.prices,
  useBotBudgets: () => ({
    data: new Map([['bot-alpha', makeBotBudget()]]),
    isPending: false,
    isFetching: false,
    error: null,
    complete: true,
  }),
}));

const api = vi.hoisted(() => ({ cancelPendingOrderRequests: vi.fn() }));
vi.mock('../../bistApi/client', () => ({ bistApi: api }));

const priceApiMock = vi.hoisted(() => ({ getClosingAuctionBars: vi.fn() }));
vi.mock('../../priceApi/client', () => ({ priceApi: priceApiMock }));

const runtime = vi.hoisted(() => ({ writesHeldReason: null as string | null }));
vi.mock('../../app/ViewerRuntime', () => ({
  useViewerRuntime: () => ({
    writesHeldReason: runtime.writesHeldReason,
    requestReconcile: vi.fn(),
  }),
}));

function emptyRead() {
  return {
    bots: [makeBot()],
    accounts: [makeAccount()],
    activeOrders: [],
    canceledOrders: [],
    positions: [],
    closedTrades: [],
    pendingRequests: [],
    holidays: [],
    errors: [],
    isPending: false,
    isFetching: false,
    error: null,
  };
}

beforeEach(() => {
  book.prices = {
    trustworthy: true,
    prices: new Map([['THYAO', makeResolvedPrice()]]),
    error: null,
    isPending: false,
  };
  book.data = emptyRead();
  runtime.writesHeldReason = null;
  api.cancelPendingOrderRequests.mockReset();
  priceApiMock.getClosingAuctionBars.mockReset();
  priceApiMock.getClosingAuctionBars.mockResolvedValue([]);
});

afterEach(() => vi.clearAllMocks());

function renderBook() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={['/book']}>
        <BookPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('the batch range the Book opens on', () => {
  /*
   * Saturday the 22nd. Friday's orders were written past the close, so they are
   * already filed under Monday the 24th — the session the desk is working, and
   * the batch the Book has to open on. A sell scheduled for Tuesday sits one
   * batch further out, under a session nobody has reached.
   */
  const SATURDAY = Date.parse('2026-08-22T11:00:00+03:00');
  const fridayEvening = () =>
    makeActiveOrder({
      id: 9,
      clientOrderId: 'monday-open',
      chainId: 'monday-open',
      symbol: 'ASELS',
      orderTime: Date.parse('2026-08-21T18:30:00+03:00'),
      sentTime: Date.parse('2026-08-21T18:30:01+03:00'),
    });
  const scheduledForTuesday = () =>
    makeActiveOrder({
      id: 10,
      clientOrderId: 'tuesday-open',
      chainId: 'tuesday-open',
      symbol: 'KCHOL',
      status: 'Scheduled',
      scheduledTime: Date.parse('2026-08-25T10:00:00+03:00'),
      orderTime: Date.parse('2026-08-21T18:35:00+03:00'),
      sentTime: null,
    });

  it('opens on the batch the desk has reached, not on one a schedule reaches past it', () => {
    vi.spyOn(Date, 'now').mockReturnValue(SATURDAY);
    book.data = {
      ...emptyRead(),
      activeOrders: [fridayEvening(), scheduledForTuesday()],
    };
    renderBook();

    expect(screen.getByRole('button', { name: '24.08.26' })).toBeVisible();
  });

  it('waits for every read before settling, so the first one back cannot pick the day', () => {
    vi.spyOn(Date, 'now').mockReturnValue(SATURDAY);
    // The Book's nine reads land independently. Settling on a first snapshot
    // would let whichever came back first choose the day, and the default is
    // taken once and never revisited.
    book.data = { ...emptyRead(), isPending: true, activeOrders: [scheduledForTuesday()] };
    const view = renderBook();
    expect(screen.getByRole('button', { name: 'Every batch' })).toBeVisible();

    book.data = { ...emptyRead(), activeOrders: [fridayEvening(), scheduledForTuesday()] };
    view.rerender(
      <QueryClientProvider client={new QueryClient()}>
        <MemoryRouter initialEntries={['/book']}>
          <BookPage />
        </MemoryRouter>
      </QueryClientProvider>,
    );

    expect(screen.getByRole('button', { name: '24.08.26' })).toBeVisible();
  });
});

describe('The Book page states', () => {
  it('renders nothing in the content area when there is genuinely no data', () => {
    renderBook();

    expect(screen.getByRole('heading', { name: 'The Book' })).toBeVisible();
    expect(document.querySelector('.book-grid-wrap')).toBeNull();
    expect(document.querySelector('.book-stat-strip')).toBeNull();
    expect(screen.queryByText(/No chains match/)).not.toBeInTheDocument();
  });

  it('says which scopes are missing rather than showing a blank table', async () => {
    const user = userEvent.setup();
    book.data = { ...emptyRead(), activeOrders: [makeActiveOrder()] };
    renderBook();

    for (const scope of document.querySelectorAll('.seg-opt input')) await user.click(scope);

    expect(screen.getByText(/Nothing selected/)).toBeVisible();
  });

  it('keeps the needs-a-human count out of the filters and makes it a toggle', async () => {
    const user = userEvent.setup();
    book.data = {
      ...emptyRead(),
      positions: [makePosition()],
      errors: [makeErrorRow({ type: 'OrderAccountMismatch', information: 'seen under ACC-9' })],
    };
    renderBook();

    expect(screen.getByText('2 need a human')).toBeVisible();
    const toggle = screen.getByRole('button', { name: '1 position with no closing order' });
    expect(toggle).toHaveAttribute('aria-pressed', 'false');

    await user.click(toggle);
    expect(toggle).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByText('No closing order')).toBeVisible();
    expect(screen.getByRole('button', { name: 'no closing order ×' })).toBeVisible();

    // Clicking it again clears only that filter.
    await user.click(toggle);
    expect(toggle).toHaveAttribute('aria-pressed', 'false');
    expect(screen.queryByText('No closing order')).not.toBeInTheDocument();
  });

  it('shows the canceled rows when the never-opened scope is switched on, and leaves them shown', async () => {
    const user = userEvent.setup();
    book.data = {
      ...emptyRead(),
      positions: [makePosition()],
      canceledOrders: [
        makeCanceledOrder(),
        makeCanceledOrder({
          id: 402,
          clientOrderId: 'client-dead-only',
          matriksOrderId: 'mx-dead-only',
          chainId: 'chain-dead',
          parentClientOrderId: null,
        }),
      ],
    };
    renderBook();

    // A never-opened chain is all canceled legs: drawing that scope while they
    // are hidden would leave collapsed stubs, so the toggle follows the scope
    // in — and the scope is on from the first render.
    const toggle = document.querySelector('.canceled-global')!;
    expect(toggle).toHaveTextContent(/shown/);

    const neverOpened = screen.getByRole('checkbox', { name: 'Never Opened' });
    await user.click(neverOpened);
    await user.click(toggle);
    expect(toggle).toHaveTextContent(/hidden/);

    // Asking for the scope again brings them back with it.
    await user.click(neverOpened);
    expect(toggle).toHaveTextContent(/shown/);

    // Switching the scope back off is not a reason to hide them again: by then
    // the reader may be reading canceled legs on chains that traded.
    await user.click(neverOpened);
    expect(toggle).toHaveTextContent(/shown/);
  });

  it('counts the canceled legs the filters kept, not the whole loaded book', async () => {
    const user = userEvent.setup();
    book.data = {
      ...emptyRead(),
      positions: [makePosition()],
      canceledOrders: [
        makeCanceledOrder(),
        makeCanceledOrder({
          id: 402,
          clientOrderId: 'client-dead-only',
          matriksOrderId: 'mx-dead-only',
          chainId: 'chain-dead',
          parentClientOrderId: null,
        }),
      ],
    };
    renderBook();

    // Both dead legs are in scope on load, so both are in the count.
    const toggle = document.querySelector('.canceled-global')!;
    expect(toggle).toHaveTextContent('2 canceled orders shown');

    // Dropping the never-opened scope drops its chain, and its leg leaves the
    // count with it: the toggle counts the rows the filters kept, never the
    // whole loaded book.
    await user.click(screen.getByRole('checkbox', { name: 'Never Opened' }));
    expect(toggle).toHaveTextContent('1 canceled order shown');
  });

  it('opens the stored mismatch row verbatim, and says the viewer cannot resolve it', async () => {
    const user = userEvent.setup();
    book.data = {
      ...emptyRead(),
      positions: [makePosition()],
      errors: [
        makeErrorRow({
          id: 77,
          type: 'OrderAccountMismatch',
          information: 'now appears under ACC-9',
          context: 'exchange-order-42',
        }),
      ],
    };
    renderBook();

    await user.click(screen.getByRole('button', { name: '1 account mismatch' }));
    const dialog = screen.getByRole('dialog', { name: 'Account mismatch' });
    expect(dialog).toHaveTextContent('OrderAccountMismatch');
    expect(dialog).toHaveTextContent('now appears under ACC-9');
    expect(dialog).toHaveTextContent('exchange-order-42');
    expect(dialog).toHaveTextContent(/cannot tell which account really holds these shares/);
  });

  it('reports an incomplete snapshot and holds writes instead of drawing a partial Book', () => {
    book.data = { ...emptyRead(), error: new Error('GetPositions did not answer.') };
    renderBook();

    expect(screen.getByRole('alert')).toHaveTextContent('The order snapshot is incomplete.');
    expect(screen.getByRole('alert')).toHaveTextContent('GetPositions did not answer.');
    expect(document.querySelector('.book-grid-wrap')).toBeNull();
  });

  it('falls back to a labelled last-known unrealized figure when prices are untrustworthy', () => {
    book.data = { ...emptyRead(), positions: [makePosition()] };
    book.prices = { ...book.prices, trustworthy: false };
    renderBook();

    const strip = document.querySelector('.book-stat-strip')!;
    expect(strip).toHaveTextContent('last known');
    expect(strip.querySelector('.number-untrusted')).not.toBeNull();
  });

  it('reads a prior close for a carried-over position and fills its today cell', async () => {
    // The fixture position opened on 25.08; the test clock is well past it, so it
    // is carried over and its today figure is read from the previous session.
    book.data = { ...emptyRead(), positions: [makePosition({ quantity: 100, averagePrice: 280 })] };
    priceApiMock.getClosingAuctionBars.mockResolvedValue([
      { symbol: 'THYAO', sessionDate: '2099-01-01', close: 300, volume: 1, barTs: 1 },
    ]);
    renderBook();

    await waitFor(() =>
      expect(priceApiMock.getClosingAuctionBars).toHaveBeenCalledWith([
        expect.objectContaining({ symbol: 'THYAO' }),
      ]),
    );
    // Live price 305.5 against a 300 prior close, 100 shares — figure and percentage.
    await waitFor(() =>
      expect(document.querySelector('.book-row-opener .book-today')?.textContent).toBe(
        '+550 (+1,83%)',
      ),
    );
    const todayStat = [...document.querySelectorAll('.book-stat')].find(
      (stat) => stat.querySelector('.kicker')?.textContent === 'today',
    )!;
    expect(todayStat.textContent).toContain('+550');
    expect(todayStat.textContent).toContain('1,83%');
  });

  it("keeps a same-day chain's today figure through the session close, until midnight", () => {
    // 18:20 Istanbul on the position's own day — ten minutes past the close's grace, so
    // the trading session has already rolled to the next day, but the calendar day has
    // not. The today column must not flip its basis, or zero itself, at that boundary.
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-25T15:20:00.000Z'));
    try {
      book.data = {
        ...emptyRead(),
        positions: [makePosition({ quantity: 100, averagePrice: 280 })],
      };
      renderBook();

      // Same-day chain: still measured from entry, exactly like p&l, and it needs no
      // prior-close bar at all.
      const todayCell = document.querySelector('.book-row-opener .book-today');
      expect(todayCell?.textContent).toBe('+2.550 (+9,11%)');
      expect(priceApiMock.getClosingAuctionBars).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not read closing bars when nothing is carried over', () => {
    book.data = { ...emptyRead(), activeOrders: [makeActiveOrder()] };
    renderBook();

    expect(priceApiMock.getClosingAuctionBars).not.toHaveBeenCalled();
  });
});

describe('queued baskets', () => {
  it('cancels a selection as one call per bot and reports every id separately', async () => {
    const user = userEvent.setup();
    api.cancelPendingOrderRequests.mockImplementation((botId: string, ids: number[]) =>
      Promise.resolve({
        results: ids.map((id) => ({
          id,
          outcome: id === 8 ? ('gone' as const) : ('canceled' as const),
        })),
      }),
    );
    book.data = {
      ...emptyRead(),
      bots: [makeBot(), makeBot({ id: 'bot-beta' })],
      pendingRequests: [
        makePendingOrderRequest({ id: 7 }),
        makePendingOrderRequest({ id: 8 }),
        makePendingOrderRequest({ id: 9, botId: 'bot-beta' }),
      ],
    };
    renderBook();

    expect(screen.getByText('select baskets to call several off at once')).toBeVisible();
    await user.click(screen.getByLabelText('Select queued request 7'));
    await user.click(screen.getByLabelText('Select queued request 8'));
    await user.click(screen.getByLabelText('Select queued request 9'));
    expect(screen.getByText('3 baskets selected · 2 calls, one per bot')).toBeVisible();

    await user.click(screen.getByRole('button', { name: 'call off selected' }));
    const dialog = screen.getByRole('dialog', { name: 'Cancel 3 queued requests' });
    // The confirm itemizes the calls in the order they will be made.
    expect(
      within(dialog)
        .getAllByRole('listitem')
        .map((item) => item.textContent),
    ).toEqual([
      '1 · CancelPendingOrderRequestsbot-alpha · req 7, req 8',
      '2 · CancelPendingOrderRequestsbot-beta · req 9',
    ]);

    await user.click(within(dialog).getByRole('button', { name: 'Cancel 3 requests' }));

    const rows = await within(dialog).findAllByText(/^Queued request/);
    expect(rows).toHaveLength(3);
    expect(within(dialog).getAllByText('Removed')).toHaveLength(2);
    expect(within(dialog).getByText('Gone')).toBeVisible();
    expect(api.cancelPendingOrderRequests).toHaveBeenCalledTimes(2);
    expect(api.cancelPendingOrderRequests).toHaveBeenNthCalledWith(1, 'bot-alpha', [7, 8]);
    expect(api.cancelPendingOrderRequests).toHaveBeenNthCalledWith(2, 'bot-beta', [9]);
  });

  it('holds the cancel while writes are held and sends nothing', async () => {
    const user = userEvent.setup();
    runtime.writesHeldReason = 'The order stream is not live.';
    book.data = { ...emptyRead(), pendingRequests: [makePendingOrderRequest()] };
    renderBook();

    await user.click(screen.getByLabelText('Select queued request 7'));
    expect(screen.getByRole('button', { name: 'call off selected' })).toBeDisabled();
    expect(api.cancelPendingOrderRequests).not.toHaveBeenCalled();
  });
});

describe('the canceled status filter', () => {
  // Three waiting chains: one that lost a leg to the exchange, one a person
  // ended in the terminal, and one that has lost nothing at all.
  const threeChains = () => ({
    ...emptyRead(),
    activeOrders: [
      makeActiveOrder({ id: 1, clientOrderId: 'a', chainId: 'chain-a', symbol: 'AKBNK' }),
      makeActiveOrder({ id: 2, clientOrderId: 'b', chainId: 'chain-b', symbol: 'GARAN' }),
      makeActiveOrder({ id: 3, clientOrderId: 'c', chainId: 'chain-c', symbol: 'SISE' }),
    ],
    canceledOrders: [
      makeCanceledOrder({
        id: 401,
        clientOrderId: 'a-dead',
        chainId: 'chain-a',
        symbol: 'AKBNK',
        parentClientOrderId: 'a',
        status: 'Rejected',
      }),
      makeCanceledOrder({
        id: 402,
        clientOrderId: 'b-dead',
        chainId: 'chain-b',
        symbol: 'GARAN',
        parentClientOrderId: 'b',
        status: 'CanceledByUser',
      }),
    ],
  });

  const chainsInGrid = () =>
    [...document.querySelectorAll('.book-chain')]
      .map((chain) => chain.getAttribute('aria-label')?.replace(' chain', '') ?? '')
      .sort();

  it('narrows to chains that own a canceled leg, and draws each of them whole', async () => {
    const user = userEvent.setup();
    book.data = threeChains();
    renderBook();

    expect(chainsInGrid()).toEqual(['AKBNK', 'GARAN', 'SISE']);

    await user.click(screen.getByRole('button', { name: 'any status' }));
    await user.click(screen.getByRole('checkbox', { name: 'filter' }));

    // Every status is still ticked, and the chain that lost nothing still goes:
    // it owns no canceled order, so nothing in it can match.
    expect(screen.getByRole('button', { name: '2 statuses' })).toBeVisible();
    expect(chainsInGrid()).toEqual(['AKBNK', 'GARAN']);
    expect(screen.getByRole('button', { name: 'with a canceled leg ×' })).toBeVisible();
  });

  it('keeps a chain by the status of its canceled leg, not of its live orders', async () => {
    const user = userEvent.setup();
    book.data = threeChains();
    renderBook();

    await user.click(screen.getByRole('button', { name: 'any status' }));
    await user.click(screen.getByRole('checkbox', { name: 'filter' }));
    await user.click(screen.getByRole('checkbox', { name: /Rejected/ }));

    expect(chainsInGrid()).toEqual(['GARAN']);
    expect(screen.getByRole('button', { name: '1 canceled status ×' })).toBeVisible();
  });

  it('names itself as the narrowing that emptied the Book, and switches back off', async () => {
    const user = userEvent.setup();
    book.data = threeChains();
    renderBook();

    await user.click(screen.getByRole('button', { name: 'any status' }));
    await user.click(screen.getByRole('checkbox', { name: 'filter' }));
    await user.click(screen.getByRole('button', { name: 'none' }));

    expect(screen.getByText('No canceled status is selected.', { exact: false })).toBeVisible();

    await user.click(screen.getByRole('button', { name: 'clear the canceled status filter' }));
    expect(chainsInGrid()).toEqual(['AKBNK', 'GARAN', 'SISE']);
    expect(screen.getByRole('button', { name: 'any status' })).toBeVisible();
  });
});

describe('the reason filter', () => {
  // One reason on a live order, one on a canceled leg, one on the sell that
  // closed a round trip, and one chain the server said nothing about — so the
  // filter can be shown to read every row and not only the canceled ones.
  const fourChains = () => ({
    ...emptyRead(),
    activeOrders: [
      makeActiveOrder({
        id: 1,
        clientOrderId: 'a',
        chainId: 'chain-a',
        symbol: 'AKBNK',
        direction: 'sell',
        reason: 'ScheduledExit',
      }),
      makeActiveOrder({ id: 2, clientOrderId: 'b', chainId: 'chain-b', symbol: 'GARAN' }),
      makeActiveOrder({ id: 3, clientOrderId: 'c', chainId: 'chain-c', symbol: 'SISE' }),
    ],
    canceledOrders: [
      makeCanceledOrder({
        id: 401,
        clientOrderId: 'c-dead',
        chainId: 'chain-c',
        symbol: 'SISE',
        parentClientOrderId: 'c',
        reason: 'BuyGuard',
      }),
    ],
    closedTrades: [
      makeClosedTrade({ id: 301, chainId: 'chain-d', symbol: 'THYAO', closeReason: 'StopLoss' }),
    ],
  });

  const chainsInGrid = () =>
    [...document.querySelectorAll('.book-chain')]
      .map((chain) => chain.getAttribute('aria-label')?.replace(' chain', '') ?? '')
      .sort();

  it('narrows to chains with a recorded reason, whichever row carries it', async () => {
    const user = userEvent.setup();
    book.data = fourChains();
    renderBook();

    expect(chainsInGrid()).toEqual(['AKBNK', 'GARAN', 'SISE', 'THYAO']);

    await user.click(screen.getByRole('button', { name: 'any reason' }));
    await user.click(screen.getByRole('checkbox', { name: 'filter' }));

    // GARAN goes: every reason is still ticked, but nothing on it carries one.
    expect(chainsInGrid()).toEqual(['AKBNK', 'SISE', 'THYAO']);
    expect(screen.getByRole('button', { name: 'with a recorded reason ×' })).toBeVisible();
  });

  it('keeps a chain by a reason on a live order and by one on a closed trade alike', async () => {
    const user = userEvent.setup();
    book.data = fourChains();
    renderBook();

    await user.click(screen.getByRole('button', { name: 'any reason' }));
    await user.click(screen.getByRole('checkbox', { name: 'filter' }));
    await user.click(screen.getByRole('checkbox', { name: /BuyGuard/ }));

    expect(chainsInGrid()).toEqual(['AKBNK', 'THYAO']);
    expect(screen.getByRole('button', { name: '2 reasons ×' })).toBeVisible();
  });

  it('names itself as the narrowing that emptied the Book, and switches back off', async () => {
    const user = userEvent.setup();
    book.data = fourChains();
    renderBook();

    await user.click(screen.getByRole('button', { name: 'any reason' }));
    await user.click(screen.getByRole('checkbox', { name: 'filter' }));
    await user.click(screen.getByRole('button', { name: 'none' }));

    expect(screen.getByText('No reason is selected.', { exact: false })).toBeVisible();

    await user.click(screen.getByRole('button', { name: 'clear the reason filter' }));
    expect(chainsInGrid()).toEqual(['AKBNK', 'GARAN', 'SISE', 'THYAO']);
    expect(screen.getByRole('button', { name: 'any reason' })).toBeVisible();
  });
});

describe('the source filter', () => {
  // Three chains that each lost a leg to a different hand, and one that has
  // lost nothing — so the filter can be shown to read the stored deaths alone.
  const fourChains = () => ({
    ...emptyRead(),
    activeOrders: [
      makeActiveOrder({ id: 1, clientOrderId: 'a', chainId: 'chain-a', symbol: 'AKBNK' }),
      makeActiveOrder({ id: 2, clientOrderId: 'b', chainId: 'chain-b', symbol: 'GARAN' }),
      makeActiveOrder({ id: 3, clientOrderId: 'c', chainId: 'chain-c', symbol: 'SISE' }),
      makeActiveOrder({ id: 4, clientOrderId: 'd', chainId: 'chain-d', symbol: 'THYAO' }),
    ],
    canceledOrders: [
      makeCanceledOrder({
        id: 401,
        clientOrderId: 'a-dead',
        chainId: 'chain-a',
        symbol: 'AKBNK',
        source: 'Server',
      }),
      makeCanceledOrder({
        id: 402,
        clientOrderId: 'b-dead',
        chainId: 'chain-b',
        symbol: 'GARAN',
        source: 'User',
      }),
      makeCanceledOrder({
        id: 403,
        clientOrderId: 'c-dead',
        chainId: 'chain-c',
        symbol: 'SISE',
        source: 'Broker',
      }),
    ],
  });

  const chainsInGrid = () =>
    [...document.querySelectorAll('.book-chain')]
      .map((chain) => chain.getAttribute('aria-label')?.replace(' chain', '') ?? '')
      .sort();

  it('prints who ended a leg beside its status', () => {
    book.data = fourChains();
    renderBook();

    // The canceled legs are drawn from the first render, with the scope.
    expect(screen.getByText(/By user · User/)).toBeVisible();
  });

  it('narrows to chains that lost a leg to a ticked hand', async () => {
    const user = userEvent.setup();
    book.data = fourChains();
    renderBook();

    expect(chainsInGrid()).toEqual(['AKBNK', 'GARAN', 'SISE', 'THYAO']);

    await user.click(screen.getByRole('button', { name: 'any source' }));
    await user.click(screen.getByRole('checkbox', { name: 'filter' }));

    // THYAO goes: every source is still ticked, but it has lost nothing.
    expect(chainsInGrid()).toEqual(['AKBNK', 'GARAN', 'SISE']);
    expect(screen.getByRole('button', { name: 'with a named source ×' })).toBeVisible();

    await user.click(screen.getByRole('checkbox', { name: /Broker/ }));
    expect(chainsInGrid()).toEqual(['AKBNK', 'GARAN']);
    expect(screen.getByRole('button', { name: '2 sources ×' })).toBeVisible();
  });

  it('names itself as the narrowing that emptied the Book, and switches back off', async () => {
    const user = userEvent.setup();
    book.data = fourChains();
    renderBook();

    await user.click(screen.getByRole('button', { name: 'any source' }));
    await user.click(screen.getByRole('checkbox', { name: 'filter' }));
    await user.click(screen.getByRole('button', { name: 'none' }));

    expect(screen.getByText('No source is selected.', { exact: false })).toBeVisible();

    await user.click(screen.getByRole('button', { name: 'clear the source filter' }));
    expect(chainsInGrid()).toEqual(['AKBNK', 'GARAN', 'SISE', 'THYAO']);
    expect(screen.getByRole('button', { name: 'any source' })).toBeVisible();
  });
});
