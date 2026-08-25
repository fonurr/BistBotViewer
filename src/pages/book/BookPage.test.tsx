import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Quote } from '../../priceApi/types';
import {
  makeAccount,
  makeActiveOrder,
  makeBot,
  makeBotBudget,
  makeErrorRow,
  makePosition,
  makeQuote,
} from '../../test/fixtures';
import { BookPage } from './BookPage';

const book = vi.hoisted(() => ({
  data: {} as Record<string, unknown>,
  prices: {
    trustworthy: true,
    quotes: new Map<string, Quote>(),
    status: null,
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

vi.mock('../../app/ViewerRuntime', () => ({
  useViewerRuntime: () => ({ writesHeldReason: null, requestReconcile: vi.fn() }),
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
    quotes: new Map([['THYAO', makeQuote()]]),
    status: null,
    error: null,
    isPending: false,
  };
  book.data = emptyRead();
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

    await user.click(document.querySelector('.seg-opt input')!);
    await user.click(document.querySelectorAll('.seg-opt input')[1]!);

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
});
