import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { buildBookChains } from '../../domain/chains';
import {
  makeAccount,
  makeActiveOrder,
  makeBot,
  makeCanceledOrder,
  makeClosedTrade,
  makePosition,
  makeQuote,
} from '../../test/fixtures';
import { BookGrid } from './BookGrid';
import { defaultBookFilters } from './types';

const everyScope = {
  ...defaultBookFilters,
  scopes: new Set(['waiting', 'positions', 'trades', 'canceled'] as const),
};

function renderGrid(
  overrides: Partial<Parameters<typeof BookGrid>[0]> = {},
  input: Parameters<typeof buildBookChains>[0] = {
    activeOrders: [makeActiveOrder()],
    canceledOrders: [],
    positions: [],
    closedTrades: [],
  },
) {
  const chains = buildBookChains(input);
  const props = {
    chains,
    filters: everyScope,
    bots: [makeBot()],
    accounts: [makeAccount()],
    quotes: new Map([['THYAO', makeQuote()]]),
    pricesTrustworthy: true,
    writesHeldReason: null,
    showCanceled: false,
    openCanceledChains: new Set<string>(),
    onToggleCanceledChain: vi.fn(),
    onOpenChain: vi.fn(),
    ...overrides,
  };
  return { ...render(<BookGrid {...props} />), props, chains };
}

describe('BookGrid row vocabulary', () => {
  it('groups by batch date and bot, and inks the side word', () => {
    renderGrid();

    expect(screen.getByText('25.08.26')).toBeVisible();
    expect(screen.getByText('1 chain')).toBeVisible();
    expect(screen.getByText('bot-alpha')).toHaveAttribute('title', 'Deterministic browser fixture');
    expect(screen.getByText('buy')).toHaveClass('side-buy');
  });

  it('prints a scheduled row"s fire time in the order time column, never a dash', () => {
    const fireTime = Date.now() + 3 * 60 * 60 * 1_000;
    renderGrid(
      {},
      {
        activeOrders: [
          makeActiveOrder({
            status: 'Scheduled',
            matriksOrderId: null,
            orderTime: null,
            sentTime: null,
            type: 'market',
            scheduledTime: fireTime,
            whenType: 'BeforeClose',
          }),
        ],
        canceledOrders: [],
        positions: [],
        closedTrades: [],
      },
    );

    const time = document.querySelector('.book-row .status-wait.book-time')!;
    expect(time.textContent).not.toBe('');
    expect(screen.getByText(/^Scheduled · in/)).toBeVisible();
    // A market order's captured price is a fact the record kept, not an instruction.
    expect(document.querySelector('.book-row .captured-value')).not.toBeNull();
  });

  it('leaves a cell empty rather than substituting a dash or a zero', () => {
    renderGrid();

    const cells = [...document.querySelectorAll('.book-row [role="cell"]')].map(
      (cell) => cell.textContent,
    );
    expect(cells).not.toContain('—');
    expect(cells).not.toContain('-');
    // fill, slip and p&l have nothing to say about an unfilled buy.
    expect(cells.filter((text) => text === '').length).toBeGreaterThanOrEqual(3);
  });

  it('carries both facts on a cancel in flight and disables its actions with a reason', () => {
    renderGrid(
      {},
      {
        activeOrders: [
          makeActiveOrder({
            status: 'PartiallyFilled',
            filledQuantity: 15,
            orderQuantity: 40,
            averagePrice: 68.3,
            cancelSource: 'user',
          }),
        ],
        canceledOrders: [],
        positions: [],
        closedTrades: [],
      },
    );

    expect(screen.getByText('Partly filled · cancel in flight')).toBeVisible();
    expect(screen.getByText(/asked by a person, in the terminal/)).toBeVisible();
    expect(screen.getByText(/25 resting shares can still fill/)).toBeVisible();
    for (const name of ['edit', 'cancel']) {
      const button = screen.getByRole('button', { name });
      expect(button).toBeDisabled();
      expect(button).toHaveAttribute('title', 'A cancel is already in flight.');
    }
    expect(document.querySelector('.book-row.cancel-in-flight')).not.toBeNull();
  });

  it('renders a canceled tail behind its own toggle and opens the chain on a row click', async () => {
    const user = userEvent.setup();
    const { props } = renderGrid(
      {},
      {
        activeOrders: [],
        canceledOrders: [makeCanceledOrder()],
        positions: [makePosition()],
        closedTrades: [],
      },
    );

    const tail = document.querySelector('.canceled-tail')!;
    expect(
      within(tail as HTMLElement).getByRole('button', { name: /1 canceled order/ }),
    ).toBeVisible();
    await user.click(within(tail as HTMLElement).getByRole('button', { name: /^show/ }));
    expect(props.onToggleCanceledChain).toHaveBeenCalledTimes(1);

    await user.click(screen.getAllByRole('button', { name: /THYAO/ })[0]!);
    expect(props.onOpenChain).toHaveBeenCalled();
  });

  it('holds every row action while writes are held, with the hold as the reason', () => {
    renderGrid({ writesHeldReason: 'The order stream is not live.' });

    const action = screen.getByRole('button', { name: 'cancel' });
    expect(action).toBeDisabled();
    expect(action).toHaveAttribute('title', 'The order stream is not live.');
  });

  it('renders a closed round trip as a settled pair with its realized result', () => {
    renderGrid(
      {},
      {
        activeOrders: [],
        canceledOrders: [],
        positions: [],
        closedTrades: [makeClosedTrade()],
      },
    );

    expect(screen.getAllByText('Closed')).toHaveLength(2);
    expect(screen.getByText('+600,00')).toBeVisible();
    expect(document.querySelectorAll('.book-actions button')).toHaveLength(0);
  });
});
