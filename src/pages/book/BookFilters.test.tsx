import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { accountIdentityKey } from '../../domain/accounts';
import { buildBookChains } from '../../domain/chains';
import { makeAccount, makeActiveOrder, makeBot, makeCanceledOrder } from '../../test/fixtures';
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

  it('starts off, with every box ticked and disabled', async () => {
    const user = userEvent.setup();
    renderFilters(vi.fn());

    await user.click(screen.getByRole('button', { name: 'any status' }));
    for (const box of screen.getAllByRole('checkbox', { name: /By user|By bot|Rejected/ })) {
      expect(box).toBeChecked();
      expect(box).toBeDisabled();
    }
    expect(screen.getByRole('button', { name: 'all' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'none' })).toBeDisabled();
  });

  it('switches on with every status still selected', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    renderFilters(onChange);

    await user.click(screen.getByRole('button', { name: 'any status' }));
    await user.click(screen.getByRole('checkbox', { name: 'filter' }));

    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ canceledStatusFilter: true, canceledStatuses: null }),
    );
  });

  it('drops a status once it is on, and pins every status back when switched off', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    renderFilters(onChange, { ...defaultBookFilters, canceledStatusFilter: true });

    await user.click(screen.getByRole('button', { name: '3 statuses' }));
    await user.click(screen.getByRole('checkbox', { name: /Rejected/ }));
    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ canceledStatuses: new Set(['By bot', 'By user']) }),
    );

    await user.click(screen.getByRole('checkbox', { name: 'filter' }));
    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ canceledStatusFilter: false, canceledStatuses: null }),
    );
  });

  it('counts the chains a status would keep, never the legs', async () => {
    const user = userEvent.setup();
    renderFilters(vi.fn(), { ...defaultBookFilters, canceledStatusFilter: true });

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
