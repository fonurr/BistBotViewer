import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { holidayCalendar } from '../../domain/calendar';
import { buildBookChains } from '../../domain/chains';
import {
  makeAccount,
  makeActiveOrder,
  makeBot,
  makeCanceledOrder,
  makeClosedTrade,
  makePosition,
  makeResolvedPrice,
} from '../../test/fixtures';
import { BookGrid } from './BookGrid';

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
    bots: [makeBot()],
    accounts: [makeAccount()],
    prices: new Map([['THYAO', makeResolvedPrice()]]),
    pricesTrustworthy: true,
    todaySessionDate: '2026-08-25',
    calendar: holidayCalendar([]),
    closingBars: new Map<string, number>(),
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
    expect(screen.getByText(/the cancel can only take the 25 that are resting/)).toBeVisible();
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
    expect(within(tail as HTMLElement).getByText('+1 canceled')).toBeVisible();
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

    // SPEC 2: the chain's own row reads `Closed`; `Filled` is the leg word.
    expect(screen.getByText('Closed')).toBeVisible();
    expect(screen.getByText('Filled')).toBeVisible();
    // The closing sell leg carries the realized result in p&l, and — since this
    // round trip opened and closed in the current session — the same figure in
    // the today column. The opening buy leg shows neither.
    expect(screen.getAllByText('+600')).toHaveLength(2);
    expect(screen.getByText('+600,00')).toBeVisible();
    expect(document.querySelectorAll('.book-actions button')).toHaveLength(0);
  });
});

describe('BookGrid today column', () => {
  const carriedOverPosition = () =>
    makePosition({
      quantity: 100,
      averagePrice: 280,
      orderTime: Date.parse('2026-08-18T06:55:00.000Z'),
      executeTime: Date.parse('2026-08-18T06:55:02.000Z'),
    });

  it('heads the grid with a today column', () => {
    renderGrid();
    expect(screen.getByRole('columnheader', { name: 'today' })).toBeVisible();
  });

  it('marks a carried-over position from the previous close when the bar is present', () => {
    renderGrid(
      { closingBars: new Map([['THYAO', 300]]) },
      {
        activeOrders: [],
        canceledOrders: [],
        positions: [carriedOverPosition()],
        closedTrades: [],
      },
    );

    // Live price 305.5 against a 300 prior close, 100 shares — with its percentage.
    const todayCell = document.querySelector('.book-row-opener .book-today')!;
    expect(todayCell.textContent).toBe('+550 (+1,83%)');
  });

  it('withholds the today figure when the prior close is missing', () => {
    renderGrid(
      { closingBars: new Map<string, number>() },
      {
        activeOrders: [],
        canceledOrders: [],
        positions: [carriedOverPosition()],
        closedTrades: [],
      },
    );

    const todayCell = document.querySelector('.book-row-opener .book-today')!;
    expect(todayCell.textContent).toBe('');
  });
});

describe('BookGrid scope groups', () => {
  it('opens each scope group with its own header line, inside the bot it belongs to', () => {
    renderGrid(
      {},
      {
        activeOrders: [makeActiveOrder()],
        canceledOrders: [],
        positions: [],
        closedTrades: [makeClosedTrade({ id: 90, chainId: 'chain-closed' })],
      },
    );

    const headings = [...document.querySelectorAll('.book-scope-heading')];
    expect(headings.map((heading) => heading.querySelector('.kicker')?.textContent)).toEqual([
      'Waiting',
      'Trades',
    ]);
    // The header opens its group: the chains it counts follow it, not the reverse.
    const botGroup = document.querySelector('.book-bot-group')!;
    expect(botGroup.querySelector('.book-scope-group')?.firstElementChild).toBe(headings[0]);
  });

  it('draws every leg of a chain the scope selected, including legs of other kinds', () => {
    const position = makePosition();
    renderGrid(
      {},
      {
        activeOrders: [
          makeActiveOrder({
            id: 200,
            clientOrderId: 'client-thyao-exit',
            chainId: position.chainId,
            parentClientOrderId: position.clientOrderId,
            direction: 'sell',
            status: 'Scheduled',
            matriksOrderId: null,
            orderTime: null,
            sentTime: null,
            scheduledTime: Date.now() + 60 * 60 * 1_000,
          }),
        ],
        canceledOrders: [],
        positions: [position],
        closedTrades: [],
      },
    );

    // One chain, filed under positions, and its waiting sell is drawn with it.
    expect(document.querySelectorAll('.book-scope-heading')).toHaveLength(1);
    expect(screen.getByText('Positions')).toBeVisible();
    expect(screen.getByText('Position')).toBeVisible();
    expect(screen.getByText(/^Scheduled · in/)).toBeVisible();
  });
});

describe('BookGrid batches', () => {
  const DAY_MS = 24 * 60 * 60 * 1_000;

  function twoBatches() {
    const newer = Date.parse('2026-08-25T06:30:00.000Z');
    const older = newer - 7 * DAY_MS;
    return [
      makeClosedTrade({
        id: 501,
        symbol: 'NEWER',
        chainId: 'chain-newer',
        clientOpenOrderId: 'client-newer-open',
        clientCloseOrderId: 'client-newer-close',
        openOrderTime: newer,
        openExecuteTime: newer + 2_000,
        closeOrderTime: newer + 3_600_000,
        closeExecuteTime: newer + 3_603_000,
      }),
      makeClosedTrade({
        id: 502,
        symbol: 'OLDER',
        chainId: 'chain-older',
        clientOpenOrderId: 'client-older-open',
        clientCloseOrderId: 'client-older-close',
        openOrderTime: older,
        openExecuteTime: older + 2_000,
        closeOrderTime: older + 3_600_000,
        closeExecuteTime: older + 3_603_000,
      }),
    ];
  }

  function renderBatches() {
    return renderGrid(
      { prices: new Map() },
      { activeOrders: [], canceledOrders: [], positions: [], closedTrades: twoBatches() },
    );
  }

  it('opens the newest batch and leaves the rest behind their chevron', () => {
    renderBatches();

    const headings = screen.getAllByRole('button', { expanded: false });
    expect(screen.getAllByRole('button', { expanded: true })).toHaveLength(1);
    // The batch still says what it holds while it is shut.
    expect(within(headings[0]!).getByText('1 chain')).toBeVisible();
    expect(screen.getAllByLabelText('NEWER chain')).toHaveLength(1);
    expect(screen.queryByLabelText('OLDER chain')).toBeNull();
    // One open batch, one column band: the columns belong to their own batch.
    expect(document.querySelectorAll('.book-columns')).toHaveLength(1);
  });

  it('opens a batch on its chevron and shuts the newest one on its own', async () => {
    const user = userEvent.setup();
    renderBatches();

    await user.click(screen.getAllByRole('button', { expanded: false })[0]!);
    expect(screen.getByLabelText('OLDER chain')).toBeVisible();
    expect(screen.getByLabelText('NEWER chain')).toBeVisible();
    expect(document.querySelectorAll('.book-columns')).toHaveLength(2);

    await user.click(screen.getAllByRole('button', { expanded: true })[0]!);
    expect(screen.queryByLabelText('NEWER chain')).toBeNull();
    expect(screen.getByLabelText('OLDER chain')).toBeVisible();
  });
});
