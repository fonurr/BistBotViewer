import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { accountIdentityKey } from '../../domain/accounts';
import { buildBookChains } from '../../domain/chains';
import {
  FIXTURE_DAY,
  makeAccount,
  makeActiveOrder,
  makeBot,
  makeCanceledOrder,
  makeClosedTrade,
} from '../../test/fixtures';
import { BookFilters } from './BookFilters';
import { defaultBookFilters } from './types';

describe('BookFilters account identity', () => {
  it('offers identical account numbers at different brokerages as distinct filters', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const accounts = [
      makeAccount({ brokerageId: 'BRK-1', owner: 'Owner one' }),
      makeAccount({ brokerageId: 'BRK-2', owner: 'Owner two' }),
    ];

    render(
      <BookFilters
        filters={defaultBookFilters}
        onChange={onChange}
        bots={[
          makeBot({ id: 'bot-one', brokerageId: 'BRK-1' }),
          makeBot({ id: 'bot-two', brokerageId: 'BRK-2' }),
        ]}
        accounts={accounts}
        chains={[]}
        rangeDates={[]}
        batchesLoaded
        currentSession={FIXTURE_DAY}
        onSettleDates={vi.fn()}
        noClosingOrderCount={0}
        mismatchCount={0}
        canceledCount={0}
        canceledVisible={false}
        manualOpenLegs={0}
        manualClosedChains={0}
        onToggleCanceled={vi.fn()}
        onOpenMismatch={vi.fn()}
      />,
    );

    await user.click(screen.getByRole('button', { name: '2 accounts' }));
    const firstBrokerage = screen.getByRole('checkbox', { name: /ACC-1.*BRK-1/ });
    const secondBrokerage = screen.getByRole('checkbox', { name: /ACC-1.*BRK-2/ });

    expect(firstBrokerage).toBeChecked();
    expect(secondBrokerage).toBeChecked();
    await user.click(secondBrokerage);

    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({
        accountIds: new Set([accountIdentityKey('ACC-1', 'BRK-1')]),
      }),
    );
  });
});

describe('BookFilters bot picks', () => {
  const renderFilters = (onChange: () => void) =>
    render(
      <BookFilters
        filters={defaultBookFilters}
        onChange={onChange}
        bots={[
          makeBot({ id: 'bot-on', active: true }),
          makeBot({ id: 'bot-off', active: false }),
          makeBot({ id: 'bot-also-off', active: false }),
        ]}
        accounts={[makeAccount()]}
        chains={[]}
        rangeDates={[]}
        batchesLoaded
        currentSession={FIXTURE_DAY}
        onSettleDates={vi.fn()}
        noClosingOrderCount={0}
        mismatchCount={0}
        canceledCount={0}
        canceledVisible={false}
        manualOpenLegs={0}
        manualClosedChains={0}
        onToggleCanceled={vi.fn()}
        onOpenMismatch={vi.fn()}
      />,
    );

  it('selects exactly the bots behind each pick, and none is an empty set, not every bot', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    renderFilters(onChange);

    await user.click(screen.getByRole('button', { name: '3 bots' }));

    await user.click(screen.getByRole('button', { name: 'active' }));
    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ botIds: new Set(['bot-on']) }),
    );

    await user.click(screen.getByRole('button', { name: 'inactive' }));
    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ botIds: new Set(['bot-off', 'bot-also-off']) }),
    );

    await user.click(screen.getByRole('button', { name: 'none' }));
    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ botIds: new Set<string>() }),
    );
  });

  it('keeps all meaning every bot rather than ticking the ones on screen', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    renderFilters(onChange);

    await user.click(screen.getByRole('button', { name: '3 bots' }));
    await user.click(screen.getByRole('button', { name: 'all' }));

    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ botIds: null }));
  });
});

describe('BookFilters account picks', () => {
  it('offers none beside all, an empty set rather than every account', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <BookFilters
        filters={defaultBookFilters}
        onChange={onChange}
        bots={[makeBot()]}
        accounts={[makeAccount({ brokerageId: 'BRK-1' }), makeAccount({ brokerageId: 'BRK-2' })]}
        chains={[]}
        rangeDates={[]}
        batchesLoaded
        currentSession={FIXTURE_DAY}
        onSettleDates={vi.fn()}
        noClosingOrderCount={0}
        mismatchCount={0}
        canceledCount={0}
        canceledVisible={false}
        manualOpenLegs={0}
        manualClosedChains={0}
        onToggleCanceled={vi.fn()}
        onOpenMismatch={vi.fn()}
      />,
    );

    await user.click(screen.getByRole('button', { name: '2 accounts' }));
    await user.click(screen.getByRole('button', { name: 'none' }));
    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ accountIds: new Set<string>() }),
    );
    await user.click(screen.getByRole('button', { name: 'all' }));
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ accountIds: null }));
  });
});

describe('BookFilters symbol exclusion', () => {
  const chains = buildBookChains({
    activeOrders: [
      makeActiveOrder({ id: 1, clientOrderId: 'a', chainId: 'a', symbol: 'AKBNK' }),
      makeActiveOrder({ id: 2, clientOrderId: 'b', chainId: 'b', symbol: 'GARAN' }),
    ],
    canceledOrders: [],
    positions: [],
    closedTrades: [],
  });

  const renderFilters = (onChange: () => void, filters = defaultBookFilters) =>
    render(
      <BookFilters
        filters={filters}
        onChange={onChange}
        bots={[makeBot()]}
        accounts={[makeAccount()]}
        chains={chains}
        rangeDates={[]}
        batchesLoaded
        currentSession={FIXTURE_DAY}
        onSettleDates={vi.fn()}
        noClosingOrderCount={0}
        mismatchCount={0}
        canceledCount={0}
        canceledVisible={false}
        manualOpenLegs={0}
        manualClosedChains={0}
        onToggleCanceled={vi.fn()}
        onOpenMismatch={vi.fn()}
      />,
    );

  it('switches the pick from kept to left out, and keeps the pick', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    renderFilters(onChange, { ...defaultBookFilters, symbols: new Set(['AKBNK']) });

    await user.click(screen.getByRole('button', { name: '1 symbol' }));
    expect(screen.getByRole('checkbox', { name: 'exclude' })).not.toBeChecked();
    await user.click(screen.getByRole('checkbox', { name: 'exclude' }));
    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ symbols: new Set(['AKBNK']), symbolsExcluded: true }),
    );
  });

  it('reads all but the picked symbols, striking them through', async () => {
    const user = userEvent.setup();
    renderFilters(vi.fn(), {
      ...defaultBookFilters,
      symbols: new Set(['AKBNK']),
      symbolsExcluded: true,
    });

    await user.click(screen.getByRole('button', { name: 'all but 1 symbol' }));
    expect(screen.getByRole('checkbox', { name: 'exclude' })).toBeChecked();
    const picked = screen.getByRole('button', { name: 'AKBNK' });
    expect(picked).toHaveAttribute('aria-pressed', 'true');
    expect(picked).toHaveClass('symbol-option-excluded');
    expect(screen.getByRole('button', { name: 'GARAN' })).not.toHaveClass('symbol-option-excluded');
    expect(
      screen.getByText(
        '1 symbol excluded: AKBNK. A chain drops out if any of its orders is one of them.',
      ),
    ).toBeVisible();
  });

  it('reads any symbol while nothing is picked, whichever way the switch sits', () => {
    renderFilters(vi.fn(), { ...defaultBookFilters, symbolsExcluded: true });
    expect(screen.getByRole('button', { name: 'any symbol' })).toBeVisible();
  });
});

describe('BookFilters canceled status filter', () => {
  // Two bots, four canceled legs, three distinct display statuses — and one
  // live chain that lost nothing, so the list can be shown to hold only what
  // the canceled orders carry.
  const chains = buildBookChains({
    activeOrders: [makeActiveOrder({ id: 1, clientOrderId: 'live', chainId: 'chain-live' })],
    canceledOrders: [
      makeCanceledOrder({ id: 401, clientOrderId: 'c1', chainId: 'chain-a' }),
      makeCanceledOrder({ id: 402, clientOrderId: 'c2', chainId: 'chain-b', status: 'Rejected' }),
      makeCanceledOrder({
        id: 403,
        clientOrderId: 'c3',
        chainId: 'chain-c',
        botId: 'bot-beta',
        status: 'CanceledByBot',
      }),
      // A second leg of the same status in one chain still counts one chain.
      makeCanceledOrder({ id: 404, clientOrderId: 'c4', chainId: 'chain-c', botId: 'bot-beta' }),
    ],
    positions: [],
    closedTrades: [],
  });

  const renderFilters = (onChange: () => void, filters = defaultBookFilters) =>
    render(
      <BookFilters
        filters={filters}
        onChange={onChange}
        bots={[makeBot({ id: 'bot-alpha' }), makeBot({ id: 'bot-beta' })]}
        accounts={[makeAccount()]}
        chains={chains}
        rangeDates={[]}
        batchesLoaded
        currentSession={FIXTURE_DAY}
        onSettleDates={vi.fn()}
        noClosingOrderCount={0}
        mismatchCount={0}
        canceledCount={4}
        canceledVisible={false}
        manualOpenLegs={0}
        manualClosedChains={0}
        onToggleCanceled={vi.fn()}
        onOpenMismatch={vi.fn()}
      />,
    );

  it('lists every canceled status in the loaded book, in its display form', async () => {
    const user = userEvent.setup();
    renderFilters(vi.fn());

    await user.click(screen.getByRole('button', { name: 'any status' }));

    expect(screen.getAllByRole('checkbox').map((box) => box.getAttribute('name'))).not.toContain(
      'CanceledByUser',
    );
    expect(screen.getByRole('checkbox', { name: /By user/ })).toBeVisible();
    expect(screen.getByRole('checkbox', { name: /By bot/ })).toBeVisible();
    expect(screen.getByRole('checkbox', { name: /Rejected/ })).toBeVisible();
  });

  it('starts off, with no box ticked and every one disabled', async () => {
    const user = userEvent.setup();
    renderFilters(vi.fn());

    await user.click(screen.getByRole('button', { name: 'any status' }));
    for (const box of screen.getAllByRole('checkbox', { name: /By user|By bot|Rejected/ })) {
      expect(box).not.toBeChecked();
      expect(box).toBeDisabled();
    }
    expect(screen.getByRole('button', { name: 'all' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'none' })).toBeDisabled();
  });

  it('switches on with no status selected, the way none leaves it', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    renderFilters(onChange);

    await user.click(screen.getByRole('button', { name: 'any status' }));
    await user.click(screen.getByRole('checkbox', { name: 'filter' }));

    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ canceledStatusFilter: true, canceledStatuses: new Set() }),
    );
  });

  it('drops a status once it is on, and puts none back when switched off', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    renderFilters(onChange, {
      ...defaultBookFilters,
      canceledStatusFilter: true,
      canceledStatuses: null,
    });

    await user.click(screen.getByRole('button', { name: '3 statuses' }));
    await user.click(screen.getByRole('checkbox', { name: /Rejected/ }));
    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ canceledStatuses: new Set(['By bot', 'By user']) }),
    );

    await user.click(screen.getByRole('checkbox', { name: 'filter' }));
    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ canceledStatusFilter: false, canceledStatuses: new Set() }),
    );
  });

  it('counts the chains a status would keep, never the legs', async () => {
    const user = userEvent.setup();
    renderFilters(vi.fn(), {
      ...defaultBookFilters,
      canceledStatusFilter: true,
      canceledStatuses: null,
    });

    await user.click(screen.getByRole('button', { name: '3 statuses' }));

    // chain-a and chain-c both hold a `By user` leg; chain-c holds two.
    const byUser = screen.getByRole('checkbox', { name: /By user/ }).closest('label');
    expect(byUser).toHaveTextContent(/By user2$/);
  });

  it('offers no control at all when nothing has been canceled', () => {
    render(
      <BookFilters
        filters={defaultBookFilters}
        onChange={vi.fn()}
        bots={[makeBot()]}
        accounts={[makeAccount()]}
        chains={buildBookChains({
          activeOrders: [makeActiveOrder({ id: 1, clientOrderId: 'live', chainId: 'live' })],
          canceledOrders: [],
          positions: [],
          closedTrades: [],
        })}
        rangeDates={[]}
        batchesLoaded
        currentSession={FIXTURE_DAY}
        onSettleDates={vi.fn()}
        noClosingOrderCount={0}
        mismatchCount={0}
        canceledCount={0}
        canceledVisible={false}
        manualOpenLegs={0}
        manualClosedChains={0}
        onToggleCanceled={vi.fn()}
        onOpenMismatch={vi.fn()}
      />,
    );

    expect(screen.queryByRole('button', { name: 'any status' })).toBeNull();
  });
});

describe('BookFilters reason filter', () => {
  // Every kind of row that carries a reason, so the list can be shown to read
  // past the canceled ones: a live order, a canceled leg, and the sell that
  // closed a round trip. One chain carries none at all.
  const chains = buildBookChains({
    activeOrders: [
      makeActiveOrder({
        id: 1,
        clientOrderId: 'live',
        chainId: 'chain-live',
        direction: 'sell',
        origin: 'StopLoss',
      }),
      makeActiveOrder({ id: 2, clientOrderId: 'quiet', chainId: 'chain-quiet', origin: null }),
    ],
    canceledOrders: [
      makeCanceledOrder({ id: 401, clientOrderId: 'c1', chainId: 'chain-a', reason: 'BuyGuard' }),
      // A second leg of the same reason in one chain still counts one chain.
      makeCanceledOrder({ id: 402, clientOrderId: 'c2', chainId: 'chain-a', reason: 'BuyGuard' }),
    ],
    positions: [],
    closedTrades: [makeClosedTrade({ id: 301, chainId: 'chain-t', closeOrigin: 'TakeProfit' })],
  });

  const renderFilters = (onChange: () => void, filters = defaultBookFilters) =>
    render(
      <BookFilters
        filters={filters}
        onChange={onChange}
        bots={[makeBot({ id: 'bot-alpha' })]}
        accounts={[makeAccount()]}
        chains={chains}
        rangeDates={[]}
        batchesLoaded
        currentSession={FIXTURE_DAY}
        onSettleDates={vi.fn()}
        noClosingOrderCount={0}
        mismatchCount={0}
        canceledCount={2}
        canceledVisible={false}
        manualOpenLegs={0}
        manualClosedChains={0}
        onToggleCanceled={vi.fn()}
        onOpenMismatch={vi.fn()}
      />,
    );

  it('lists the reasons on every kind of row, not only the canceled ones', async () => {
    const user = userEvent.setup();
    renderFilters(vi.fn());

    await user.click(screen.getByRole('button', { name: 'any reason' }));

    expect(screen.getByRole('checkbox', { name: /BuyGuard/ })).toBeVisible();
    expect(screen.getByRole('checkbox', { name: /StopLoss/ })).toBeVisible();
    expect(screen.getByRole('checkbox', { name: /TakeProfit/ })).toBeVisible();
  });

  it('starts off, with no box ticked and every one disabled', async () => {
    const user = userEvent.setup();
    renderFilters(vi.fn());

    await user.click(screen.getByRole('button', { name: 'any reason' }));
    for (const box of screen.getAllByRole('checkbox', {
      name: /BuyGuard|StopLoss|TakeProfit/,
    })) {
      expect(box).not.toBeChecked();
      expect(box).toBeDisabled();
    }
  });

  it('switches on with no reason selected, the way none leaves it', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    renderFilters(onChange);

    await user.click(screen.getByRole('button', { name: 'any reason' }));
    await user.click(screen.getByRole('checkbox', { name: 'filter' }));

    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ reasonFilter: true, reasons: new Set() }),
    );
  });

  it('drops a reason once it is on, and puts none back when switched off', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    renderFilters(onChange, { ...defaultBookFilters, reasonFilter: true, reasons: null });

    await user.click(screen.getByRole('button', { name: '3 reasons' }));
    await user.click(screen.getByRole('checkbox', { name: /StopLoss/ }));
    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ reasons: new Set(['BuyGuard', 'TakeProfit']) }),
    );

    await user.click(screen.getByRole('checkbox', { name: 'filter' }));
    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ reasonFilter: false, reasons: new Set() }),
    );
  });

  it('counts the chains a reason would keep, never the rows', async () => {
    const user = userEvent.setup();
    renderFilters(vi.fn(), { ...defaultBookFilters, reasonFilter: true, reasons: null });

    await user.click(screen.getByRole('button', { name: '3 reasons' }));

    // chain-a lost two legs to BuyGuard and is still one chain.
    expect(screen.getByRole('checkbox', { name: /BuyGuard/ }).closest('label')).toHaveTextContent(
      /BuyGuard1$/,
    );
  });

  it('offers no control at all where the server recorded no reason anywhere', () => {
    render(
      <BookFilters
        filters={defaultBookFilters}
        onChange={vi.fn()}
        bots={[makeBot()]}
        accounts={[makeAccount()]}
        chains={buildBookChains({
          activeOrders: [makeActiveOrder({ id: 1, clientOrderId: 'live', chainId: 'live' })],
          canceledOrders: [],
          positions: [],
          closedTrades: [],
        })}
        rangeDates={[]}
        batchesLoaded
        currentSession={FIXTURE_DAY}
        onSettleDates={vi.fn()}
        noClosingOrderCount={0}
        mismatchCount={0}
        canceledCount={0}
        canceledVisible={false}
        manualOpenLegs={0}
        manualClosedChains={0}
        onToggleCanceled={vi.fn()}
        onOpenMismatch={vi.fn()}
      />,
    );

    expect(screen.queryByRole('button', { name: 'any reason' })).toBeNull();
  });
});

describe('BookFilters source filter', () => {
  const chains = buildBookChains({
    activeOrders: [makeActiveOrder({ id: 1, clientOrderId: 'live', chainId: 'chain-live' })],
    canceledOrders: [
      makeCanceledOrder({ id: 401, clientOrderId: 'c1', chainId: 'chain-a', source: 'Server' }),
      // Two legs of the same hand in one chain still count one chain.
      makeCanceledOrder({ id: 402, clientOrderId: 'c2', chainId: 'chain-a', source: 'Server' }),
      makeCanceledOrder({ id: 403, clientOrderId: 'c3', chainId: 'chain-b', source: 'Broker' }),
    ],
    positions: [],
    closedTrades: [],
  });

  const renderFilters = (onChange: () => void, filters = defaultBookFilters) =>
    render(
      <BookFilters
        filters={filters}
        onChange={onChange}
        bots={[makeBot({ id: 'bot-alpha' })]}
        accounts={[makeAccount()]}
        chains={chains}
        rangeDates={[]}
        batchesLoaded
        currentSession={FIXTURE_DAY}
        onSettleDates={vi.fn()}
        noClosingOrderCount={0}
        mismatchCount={0}
        canceledCount={3}
        canceledVisible={false}
        manualOpenLegs={0}
        manualClosedChains={0}
        onToggleCanceled={vi.fn()}
        onOpenMismatch={vi.fn()}
      />,
    );

  it('lists the hands that ended the loaded orders, counting chains', async () => {
    const user = userEvent.setup();
    renderFilters(vi.fn());

    await user.click(screen.getByRole('button', { name: 'any source' }));

    expect(screen.getByRole('checkbox', { name: /Broker/ })).toBeVisible();
    expect(screen.getByRole('checkbox', { name: /Server/ }).closest('label')).toHaveTextContent(
      /Server1$/,
    );
  });

  it('starts off, with no box ticked and every one disabled', async () => {
    const user = userEvent.setup();
    renderFilters(vi.fn());

    await user.click(screen.getByRole('button', { name: 'any source' }));
    for (const box of screen.getAllByRole('checkbox', { name: /Broker|Server/ })) {
      expect(box).not.toBeChecked();
      expect(box).toBeDisabled();
    }
  });

  it('drops a source once it is on, and puts none back when switched off', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    renderFilters(onChange, { ...defaultBookFilters, sourceFilter: true, sources: null });

    await user.click(screen.getByRole('button', { name: '2 sources' }));
    await user.click(screen.getByRole('checkbox', { name: /Broker/ }));
    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ sources: new Set(['Server']) }),
    );

    await user.click(screen.getByRole('checkbox', { name: 'filter' }));
    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ sourceFilter: false, sources: new Set() }),
    );
  });

  it('offers no control at all where nothing names who ended it', () => {
    render(
      <BookFilters
        filters={defaultBookFilters}
        onChange={vi.fn()}
        bots={[makeBot()]}
        accounts={[makeAccount()]}
        chains={buildBookChains({
          activeOrders: [makeActiveOrder({ id: 1, clientOrderId: 'live', chainId: 'live' })],
          canceledOrders: [],
          positions: [],
          closedTrades: [],
        })}
        rangeDates={[]}
        batchesLoaded
        currentSession={FIXTURE_DAY}
        onSettleDates={vi.fn()}
        noClosingOrderCount={0}
        mismatchCount={0}
        canceledCount={0}
        canceledVisible={false}
        manualOpenLegs={0}
        manualClosedChains={0}
        onToggleCanceled={vi.fn()}
        onOpenMismatch={vi.fn()}
      />,
    );

    expect(screen.queryByRole('button', { name: 'any source' })).toBeNull();
  });
});

describe('BookFilters origin filter', () => {
  const chains = buildBookChains({
    activeOrders: [
      makeActiveOrder({ id: 1, clientOrderId: 'live', chainId: 'chain-live', origin: 'User' }),
      // The ordinary bot order names no origin and cannot match.
      makeActiveOrder({ id: 2, clientOrderId: 'quiet', chainId: 'chain-quiet', origin: null }),
    ],
    canceledOrders: [
      makeCanceledOrder({ id: 401, clientOrderId: 'c1', chainId: 'chain-a', origin: 'Retry' }),
      // Two legs of the same origin in one chain still count one chain.
      makeCanceledOrder({ id: 402, clientOrderId: 'c2', chainId: 'chain-a', origin: 'Retry' }),
    ],
    positions: [],
    closedTrades: [makeClosedTrade({ id: 301, chainId: 'chain-t', closeOrigin: 'StopLoss' })],
  });

  const renderFilters = (onChange: () => void, filters = defaultBookFilters) =>
    render(
      <BookFilters
        filters={filters}
        onChange={onChange}
        bots={[makeBot({ id: 'bot-alpha' })]}
        accounts={[makeAccount()]}
        chains={chains}
        rangeDates={[]}
        batchesLoaded
        currentSession={FIXTURE_DAY}
        onSettleDates={vi.fn()}
        noClosingOrderCount={0}
        mismatchCount={0}
        canceledCount={2}
        canceledVisible={false}
        manualOpenLegs={0}
        manualClosedChains={0}
        onToggleCanceled={vi.fn()}
        onOpenMismatch={vi.fn()}
      />,
    );

  it('lists every origin the loaded rows name, counting chains', async () => {
    const user = userEvent.setup();
    renderFilters(vi.fn());

    await user.click(screen.getByRole('button', { name: 'any origin' }));

    expect(screen.getByRole('checkbox', { name: /User/ })).toBeVisible();
    expect(screen.getByRole('checkbox', { name: /StopLoss/ })).toBeVisible();
    expect(screen.getByRole('checkbox', { name: /Retry/ }).closest('label')).toHaveTextContent(
      /Retry1$/,
    );
  });

  it('starts off, with no box ticked and every one disabled', async () => {
    const user = userEvent.setup();
    renderFilters(vi.fn());

    await user.click(screen.getByRole('button', { name: 'any origin' }));
    for (const box of screen.getAllByRole('checkbox', { name: /User|Retry|StopLoss/ })) {
      expect(box).not.toBeChecked();
      expect(box).toBeDisabled();
    }
  });

  it('drops an origin once it is on, and puts none back when switched off', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    renderFilters(onChange, { ...defaultBookFilters, originFilter: true, origins: null });

    await user.click(screen.getByRole('button', { name: '3 origins' }));
    await user.click(screen.getByRole('checkbox', { name: /Retry/ }));
    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ origins: new Set(['StopLoss', 'User']) }),
    );

    await user.click(screen.getByRole('checkbox', { name: 'filter' }));
    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ originFilter: false, origins: new Set() }),
    );
  });

  it('offers no control at all where every row is an ordinary bot order', () => {
    render(
      <BookFilters
        filters={defaultBookFilters}
        onChange={vi.fn()}
        bots={[makeBot()]}
        accounts={[makeAccount()]}
        chains={buildBookChains({
          activeOrders: [makeActiveOrder({ id: 1, clientOrderId: 'live', chainId: 'live' })],
          canceledOrders: [],
          positions: [],
          closedTrades: [],
        })}
        rangeDates={[]}
        batchesLoaded
        currentSession={FIXTURE_DAY}
        onSettleDates={vi.fn()}
        noClosingOrderCount={0}
        mismatchCount={0}
        canceledCount={0}
        canceledVisible={false}
        manualOpenLegs={0}
        manualClosedChains={0}
        onToggleCanceled={vi.fn()}
        onOpenMismatch={vi.fn()}
      />,
    );

    expect(screen.queryByRole('button', { name: 'any origin' })).toBeNull();
  });
});
