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
  makeResolvedPrice,
} from '../../test/fixtures';
import { BookGrid } from './BookGrid';
import type { BookIntentCell } from './types';

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
    todayCalendarDate: '2026-08-25',
    closingBars: new Map<string, number>(),
    intentCells: new Map<string, BookIntentCell>(),
    calendar: new Map(),
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

    expect(document.querySelector('.book-batch-date')).toHaveTextContent('25.08.26');
    expect(screen.getByText('1 chain')).toBeVisible();
    expect(screen.getByText('bot-alpha')).toHaveAttribute('title', 'Deterministic browser fixture');
    expect(screen.getByText('buy')).toHaveClass('side-buy');
  });

  it('prints a scheduled row"s fire time in the sched column, leaving sent and order empty', () => {
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

    // The time cells are created, sched, intent, sent, order, final. A scheduled
    // row has only been written and set to fire: its fire time sits in `sched`
    // (drawn quiet like `created`), `intent` names the session that fire lands in,
    // and `sent`/`order` stay empty until it goes off — never a dash.
    const times = [...document.querySelectorAll('.book-row [role="cell"].book-time')];
    expect(times[1]).toHaveClass('book-time-minor');
    expect(times[1]!.textContent).not.toBe('');
    expect(times[2]!.textContent).not.toBe('');
    expect(times[3]!.textContent).toBe('');
    expect(times[4]!.textContent).toBe('');
    expect(screen.getByText(/^Scheduled · in/)).toBeVisible();
    // A market order's captured price is a fact the record kept, not an instruction.
    expect(document.querySelector('.book-row .captured-value')).not.toBeNull();
  });

  it('sets the intent column to the instant the plan could first trade, a batch ahead when it must', () => {
    // Friday buy, its reversing sell scheduled for the following Tuesday. One
    // chain, filed under Friday's batch; the sell intends the Tuesday fire.
    renderGrid(
      {},
      {
        activeOrders: [
          makeActiveOrder({
            id: 1,
            clientOrderId: 'buy',
            chainId: 'chain-1',
            symbol: 'THYAO',
            createdTime: Date.parse('2026-08-21T12:00:00.000Z'),
            orderTime: Date.parse('2026-08-21T12:00:01.000Z'),
            sentTime: Date.parse('2026-08-21T12:00:01.000Z'),
          }),
          makeActiveOrder({
            id: 2,
            clientOrderId: 'sell',
            parentClientOrderId: 'buy',
            chainId: 'chain-1',
            symbol: 'THYAO',
            direction: 'sell',
            status: 'Scheduled',
            matriksOrderId: null,
            orderTime: null,
            sentTime: null,
            createdTime: Date.parse('2026-08-21T12:00:00.000Z'),
            scheduledTime: Date.parse('2026-08-25T09:50:00.000Z'),
          }),
        ],
        canceledOrders: [],
        positions: [],
        closedTrades: [],
      },
    );

    const intents = [...document.querySelectorAll('.book-row')].map(
      (row) => [...row.querySelectorAll('[role="cell"].book-time')][2]?.textContent,
    );
    // The buy trades in its own Friday 15:00 instant, on the batch's own day; the
    // scheduled sell at its Tuesday 12:50 fire, four calendar days past the batch.
    expect(intents).toEqual(['15:00:00', '12:50:00+4']);
  });

  it('leaves the intent column empty when the row carries no plan', () => {
    renderGrid(
      {},
      {
        activeOrders: [],
        canceledOrders: [],
        positions: [makePosition({ createdTime: null, scheduledTime: null })],
        closedTrades: [],
      },
    );

    const intent = [...document.querySelectorAll('.book-row [role="cell"].book-time')][2];
    expect(intent?.textContent).toBe('');
  });

  const sentCell = () => [...document.querySelectorAll('.book-row [role="cell"].book-time')][3];

  it('leaves sent in muted ink when the send followed close on the plan', () => {
    const created = Date.parse('2026-08-25T07:00:00.000Z');
    renderGrid(
      {},
      {
        activeOrders: [
          makeActiveOrder({ id: 1, chainId: 'a', createdTime: created, sentTime: created + 4_000 }),
        ],
        canceledOrders: [],
        positions: [],
        closedTrades: [],
      },
    );
    expect(sentCell()).not.toHaveClass('book-time-late');
  });

  it('reddens sent when the send trailed every stamp it has by more than ten seconds', () => {
    const created = Date.parse('2026-08-25T07:00:00.000Z');
    renderGrid(
      {},
      {
        activeOrders: [
          makeActiveOrder({
            id: 2,
            chainId: 'b',
            createdTime: created,
            sentTime: created + 45_000,
          }),
        ],
        canceledOrders: [],
        positions: [],
        closedTrades: [],
      },
    );
    expect(sentCell()).toHaveClass('book-time-late');
  });

  const finalCell = () => [...document.querySelectorAll('.book-row [role="cell"].book-time')][5];

  it('reddens final on a registered row when it landed over two minutes past both intent and send', () => {
    const intent = Date.parse('2026-08-25T07:30:00.000Z');
    renderGrid(
      {},
      {
        activeOrders: [],
        canceledOrders: [],
        positions: [
          makePosition({
            createdTime: intent,
            sentTime: intent + 1_000,
            orderTime: intent + 2_000,
            finalSeenTime: intent + 5 * 60_000,
          }),
        ],
        closedTrades: [],
      },
    );

    expect(finalCell()).toHaveClass('book-time-late');
  });

  it('leaves final muted on a registered row whose send it followed within two minutes', () => {
    const intent = Date.parse('2026-08-25T07:30:00.000Z');
    renderGrid(
      {},
      {
        activeOrders: [],
        canceledOrders: [],
        positions: [
          makePosition({
            // The send waited out a feed-down window, so it sits well past intent;
            // the fill then followed the send promptly, so `final` is not late.
            createdTime: intent,
            sentTime: intent + 130_000,
            orderTime: intent + 131_000,
            finalSeenTime: intent + 200_000,
          }),
        ],
        closedTrades: [],
      },
    );

    expect(finalCell()).not.toHaveClass('book-time-late');
  });

  it('reddens final on a never-registered row when it landed over ten seconds past the intent', () => {
    const scheduledTime = Date.parse('2026-08-25T09:00:00.000Z');
    renderGrid(
      { showCanceled: true },
      {
        activeOrders: [],
        canceledOrders: [
          makeCanceledOrder({
            status: 'Canceled',
            source: 'Server',
            reason: 'AlreadyHasStock',
            orderTime: null,
            sentTime: null,
            createdTime: scheduledTime - 3 * 60 * 60 * 1_000,
            scheduledTime,
            finalSeenTime: scheduledTime + 15_000,
          }),
        ],
        positions: [],
        closedTrades: [],
      },
    );

    // No orderTime: the order never registered, so `intent` is the anchor and a
    // 15-second lag past it is late.
    expect(finalCell()).toHaveClass('book-time-late');
  });

  it('leaves final muted on a never-registered row killed promptly at its intent', () => {
    const scheduledTime = Date.parse('2026-08-25T09:00:00.000Z');
    renderGrid(
      { showCanceled: true },
      {
        activeOrders: [],
        canceledOrders: [
          makeCanceledOrder({
            status: 'Canceled',
            source: 'Server',
            reason: 'AlreadyHasStock',
            orderTime: null,
            sentTime: null,
            createdTime: scheduledTime - 3 * 60 * 60 * 1_000,
            scheduledTime,
            finalSeenTime: scheduledTime + 4_000,
          }),
        ],
        positions: [],
        closedTrades: [],
      },
    );

    expect(finalCell()).not.toHaveClass('book-time-late');
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

  it('draws the market the order was decided against between order and fill', () => {
    renderGrid();

    const headings = [...document.querySelectorAll('.book-columns [role="columnheader"]')].map(
      (cell) => cell.textContent,
    );
    expect(headings.slice(4, 8)).toEqual(['@created/slip', '@intent/slip', '@sent/slip', 'fill']);

    const market = document.querySelector('.book-row .book-market-price')!;
    // An unfilled buy has no fill to measure against, so the cell is the tape price alone.
    expect(market.textContent).toBe('68,10');
    // An observation, drawn like the asked price beside it and never like the fill.
    expect(market).not.toHaveClass('book-fill-price');
  });

  it('brightens @created/slip only for a limit order, not a market or a typeless trade', () => {
    renderGrid(
      {},
      {
        activeOrders: [
          makeActiveOrder({ id: 1, clientOrderId: 'lim', type: 'limit' }),
          makeActiveOrder({ id: 2, clientOrderId: 'mkt', type: 'market', chainId: 'mkt' }),
        ],
        canceledOrders: [],
        positions: [makePosition({ id: 3, clientOrderId: 'pos', chainId: 'pos' })],
        closedTrades: [],
      },
    );

    const created = [...document.querySelectorAll('.book-row .book-order-price')];
    // The limit order's price was a real instruction; the market capture and the
    // typeless Positions row (read as a market buy everywhere) are not.
    expect(created[0]).toHaveClass('book-order-price-live');
    expect(created[1]).not.toHaveClass('book-order-price-live');
    expect(created.at(-1)).not.toHaveClass('book-order-price-live');
  });

  it('draws the intent price it was given, and its slip only when one was resolved', () => {
    const chains = buildBookChains({
      activeOrders: [makeActiveOrder()],
      canceledOrders: [],
      positions: [],
      closedTrades: [],
    });
    const rowKey = chains[0]!.rows[0]!.key;
    renderGrid({
      intentCells: new Map([[rowKey, { price: 68.4, slip: -0.44 }]]),
    });

    const intent = document.querySelector('.book-row .book-intent-price')!;
    expect(intent.textContent).toBe('68,40 (−0,44%)');
    // A reference, never an instruction: it is not given the limit order's ink.
    expect(intent).not.toHaveClass('book-order-price-live');
  });

  it('keeps an intent price on screen when the slip beside it is withheld', () => {
    // An auction print, or an order that registered more than ten seconds late.
    const chains = buildBookChains({
      activeOrders: [makeActiveOrder()],
      canceledOrders: [],
      positions: [],
      closedTrades: [],
    });
    renderGrid({
      intentCells: new Map([[chains[0]!.rows[0]!.key, { price: 68.4, slip: null }]]),
    });

    expect(document.querySelector('.book-row .book-intent-price')!.textContent).toBe('68,40');
  });

  it('leaves the intent cell empty when the instant could not be priced', () => {
    renderGrid();

    expect(document.querySelector('.book-row .book-intent-price')!.textContent).toBe('');
  });

  it('leaves the market cell empty on a scheduled row, which decided nothing yet', () => {
    renderGrid(
      {},
      {
        activeOrders: [
          makeActiveOrder({
            status: 'Scheduled',
            matriksOrderId: null,
            orderTime: null,
            sentTime: null,
            marketPrice: null,
            scheduledTime: Date.now() + 3_600_000,
            whenType: 'BeforeClose',
          }),
        ],
        canceledOrders: [],
        positions: [],
        closedTrades: [],
      },
    );

    expect(document.querySelector('.book-row .book-market-price')!.textContent).toBe('');
  });

  it('splits a round trip"s market price per side, because it is two decisions', () => {
    // Both sides sent inside continuous trading (10:30:01 and 10:59:59 Istanbul).
    const trade = makeClosedTrade({ openSentTime: Date.parse('2026-08-25T07:30:01.000Z') });
    renderGrid({}, { activeOrders: [], canceledOrders: [], positions: [], closedTrades: [trade] });

    const markets = [...document.querySelectorAll('.book-row .book-market-price')].map(
      (cell) => cell.textContent,
    );
    // Each side carries the fill's slip from its own tape price, in parentheses.
    expect(markets).toEqual(['299,50 (+0,17%)', '306,40 (−0,13%)']);
  });

  it('keeps the market price but withholds its slip where the send was outside continuous trading', () => {
    // The fixture's buy went out at 09:29:59, into the opening queue; its sell at 10:59:59.
    renderGrid(
      {},
      { activeOrders: [], canceledOrders: [], positions: [], closedTrades: [makeClosedTrade()] },
    );

    const markets = [...document.querySelectorAll('.book-row .book-market-price')].map(
      (cell) => cell.textContent,
    );
    expect(markets).toEqual(['299,50', '306,40 (−0,13%)']);
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
    expect(screen.getByText(/asked by a person, at this interface/)).toBeVisible();
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
      finalSeenTime: Date.parse('2026-08-18T06:55:02.000Z'),
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

describe('BookGrid settled rows', () => {
  it('tints the rows that executed, and leaves the ones still in play untinted', () => {
    renderGrid(
      {},
      {
        activeOrders: [makeActiveOrder()],
        canceledOrders: [],
        positions: [],
        closedTrades: [makeClosedTrade({ id: 90, chainId: 'chain-closed' })],
      },
    );

    // A round trip draws both legs, and both are settled.
    expect(document.querySelectorAll('.book-row-done')).toHaveLength(2);
    // The resting buy is not: it is still in play, so it keeps the page ground.
    const waiting = document.querySelector('.book-scope-group .book-row')!;
    expect(waiting).not.toHaveClass('book-row-done');
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
        openFinalSeenTime: newer + 2_000,
        closeOrderTime: newer + 3_600_000,
        closeFinalSeenTime: newer + 3_603_000,
      }),
      makeClosedTrade({
        id: 502,
        symbol: 'OLDER',
        chainId: 'chain-older',
        clientOpenOrderId: 'client-older-open',
        clientCloseOrderId: 'client-older-close',
        openOrderTime: older,
        openFinalSeenTime: older + 2_000,
        closeOrderTime: older + 3_600_000,
        closeFinalSeenTime: older + 3_603_000,
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

describe('BookGrid budget headings', () => {
  /* The line is a flex row, so its spacing is `gap` rather than text. */
  const text = (element: Element | null) =>
    element === null
      ? null
      : [...element.children].map((child) => child.textContent?.trim()).join(' ');

  it('closes the batch and the bot heading with the same three figures', () => {
    renderGrid();

    // 40 shares asked for at 68,25, none filled yet: the plan stands, nothing is spent.
    const expected = '· budget 0,00 (0,00%) · 0,00 (0,00%) · 2.730,00';
    expect(text(document.querySelector('.book-date-heading .book-budget'))).toBe(expected);
    expect(text(document.querySelector('.book-bot-heading .book-budget'))).toBe(expected);
  });

  it('reserves the market buy buffer in the plan and in what the fills committed', () => {
    renderGrid(
      {},
      {
        activeOrders: [
          makeActiveOrder({
            type: 'market',
            intentType: 'market',
            status: 'PartiallyFilled',
            filledQuantity: 20,
            averagePrice: 69,
          }),
        ],
        canceledOrders: [],
        positions: [],
        closedTrades: [],
      },
    );

    // 20 x 68,25 x 1,1 committed and 20 x 69,00 paid, against 40 x 68,25 x 1,1 planned.
    expect(text(document.querySelector('.book-bot-heading .book-budget'))).toBe(
      '· budget 1.501,50 (50,00%) · 1.380,00 (45,95%) · 3.003,00',
    );
  });

  it('withholds the whole line when a visible buy has no price to plan against', () => {
    renderGrid(
      {},
      {
        activeOrders: [
          makeActiveOrder({
            status: 'Scheduled',
            matriksOrderId: null,
            orderTime: null,
            sentTime: null,
            orderQuantity: null,
            orderPrice: null,
            scheduledTime: Date.now() + 60 * 60 * 1_000,
          }),
        ],
        canceledOrders: [],
        positions: [],
        closedTrades: [],
      },
    );

    expect(text(document.querySelector('.book-bot-heading .book-budget'))).toBe(
      '· budget not available',
    );
    expect(document.querySelector('.book-budget .status-warn')).toBeVisible();
  });

  it('says nothing at all for a group whose chains own no buy', () => {
    renderGrid(
      {},
      {
        activeOrders: [
          makeActiveOrder({
            direction: 'sell',
            chainId: null,
            parentClientOrderId: null,
          }),
        ],
        canceledOrders: [],
        positions: [],
        closedTrades: [],
      },
    );

    expect(document.querySelector('.book-budget')).toBeNull();
  });
});
