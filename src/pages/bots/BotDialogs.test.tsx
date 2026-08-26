import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Bot, PendingOrderRequest } from '../../bistApi/types';
import { BotConfigDialog } from './BotConfigDialog';
import { BotStatusDialog } from './BotStatusDialog';

const api = vi.hoisted(() => ({
  getBots: vi.fn(),
  getActiveOrders: vi.fn(),
  getPositions: vi.fn(),
  getClosedTrades: vi.fn(),
  getPendingOrderRequests: vi.fn(),
  getBotBudget: vi.fn(),
  configureBot: vi.fn(),
}));

const runtime = vi.hoisted(() => ({
  writesHeldReason: null as string | null,
}));

beforeEach(() => {
  api.getPendingOrderRequests.mockResolvedValue([]);
});

vi.mock('../../bistApi/client', () => ({ bistApi: api }));
vi.mock('../../app/ViewerRuntime', () => ({
  useViewerRuntime: () => runtime,
}));

afterEach(() => {
  runtime.writesHeldReason = null;
  Object.values(api).forEach((mock) => mock.mockReset());
});

describe('bot ConfigureBot dialogs', () => {
  it('sends an id-only Add once and names it Created only after defaults reconcile', async () => {
    const user = userEvent.setup();
    const created = bot({
      id: 'fresh',
      algoritmId: null,
      accountId: null,
      brokerageId: null,
      emails: null,
      limit: 100_000,
      limitPercentage: 100,
      limitPerPosition: 20_000,
      limitPercentagePerPosition: 100,
      forbiddenStocks: [],
      active: true,
      description: null,
      complete: false,
    });
    api.getBots.mockResolvedValueOnce([]).mockResolvedValueOnce([created]);
    api.configureBot.mockResolvedValue({});

    renderDialog(
      <BotConfigDialog
        mode="add"
        bot={null}
        bots={[]}
        accounts={[]}
        activeOrders={[]}
        positions={[]}
        pendingRequests={[]}
        budget={undefined}
        onClose={vi.fn()}
      />,
    );
    await user.type(screen.getByLabelText('bot id'), 'fresh');
    await user.click(screen.getByRole('button', { name: 'Create bot' }));

    expect(await screen.findByText('Created fresh')).toBeInTheDocument();
    expect(api.configureBot).toHaveBeenCalledTimes(1);
    expect(api.configureBot).toHaveBeenCalledWith({ id: 'fresh' });
    expect(api.getBots).toHaveBeenCalledTimes(2);
  });

  it('blocks a duplicate discovered by the fresh Add preflight', async () => {
    const user = userEvent.setup();
    api.getBots.mockResolvedValueOnce([bot({ id: 'fresh' })]);

    renderDialog(
      <BotConfigDialog
        mode="add"
        bot={null}
        bots={[]}
        accounts={[]}
        activeOrders={[]}
        positions={[]}
        pendingRequests={[]}
        budget={undefined}
        onClose={vi.fn()}
      />,
    );
    await user.type(screen.getByLabelText('bot id'), 'fresh');
    await user.click(screen.getByRole('button', { name: 'Create bot' }));

    expect(await screen.findByText(/would overwrite it/i)).toBeInTheDocument();
    expect(api.configureBot).not.toHaveBeenCalled();
  });

  it('blocks Add when an orphan queued basket still owns the id', async () => {
    const user = userEvent.setup();
    api.getBots.mockResolvedValueOnce([]);
    api.getPendingOrderRequests.mockResolvedValueOnce([pendingRequest({ botId: 'fresh' })]);

    renderDialog(
      <BotConfigDialog
        mode="add"
        bot={null}
        bots={[]}
        accounts={[]}
        activeOrders={[]}
        positions={[]}
        pendingRequests={[]}
        budget={undefined}
        onClose={vi.fn()}
      />,
    );
    await user.type(screen.getByLabelText('bot id'), 'fresh');
    await user.click(screen.getByRole('button', { name: 'Create bot' }));

    expect(await screen.findByText(/could replay old orders/i)).toBeInTheDocument();
    expect(api.configureBot).not.toHaveBeenCalled();
  });

  it('blocks a routing change when a queued basket appeared after the form opened', async () => {
    const user = userEvent.setup();
    const original = bot();
    api.getBots.mockResolvedValueOnce([original]);
    api.getPendingOrderRequests.mockResolvedValueOnce([pendingRequest()]);

    renderDialog(
      <BotConfigDialog
        mode="edit"
        bot={original}
        bots={[original]}
        accounts={[]}
        activeOrders={[]}
        positions={[]}
        pendingRequests={[]}
        budget={undefined}
        onClose={vi.fn()}
      />,
    );
    await user.clear(screen.getByLabelText('account id'));
    await user.type(screen.getByLabelText('account id'), 'account-2');
    await user.clear(screen.getByLabelText('brokerage id'));
    await user.type(screen.getByLabelText('brokerage id'), 'broker-2');
    await user.click(screen.getByRole('button', { name: 'Send the changes' }));

    expect(await screen.findByText(/replay against the new account/i)).toBeInTheDocument();
    expect(api.configureBot).not.toHaveBeenCalled();
  });

  it('never retries an Add whose ConfigureBot outcome is unknown', async () => {
    const user = userEvent.setup();
    api.getBots.mockResolvedValueOnce([]);
    api.configureBot.mockRejectedValueOnce(new Error('connection ended without a reply'));

    renderDialog(
      <BotConfigDialog
        mode="add"
        bot={null}
        bots={[]}
        accounts={[]}
        activeOrders={[]}
        positions={[]}
        pendingRequests={[]}
        budget={undefined}
        onClose={vi.fn()}
      />,
    );
    await user.type(screen.getByLabelText('bot id'), 'fresh');
    await user.click(screen.getByRole('button', { name: 'Create bot' }));

    expect(await screen.findByText('No answer')).toBeInTheDocument();
    expect(screen.getByText(/Do not retry/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /retry/i })).not.toBeInTheDocument();
    expect(api.configureBot).toHaveBeenCalledTimes(1);
  });

  it('trusts postflight over a zero-row delete prediction and reports deactivation', async () => {
    const user = userEvent.setup();
    const active = bot();
    const inactive = bot({ active: false });
    api.getBots.mockResolvedValueOnce([active]).mockResolvedValueOnce([inactive]);
    api.getActiveOrders.mockResolvedValueOnce([]);
    api.getPositions.mockResolvedValueOnce([]);
    api.getClosedTrades.mockResolvedValueOnce([]);
    api.configureBot.mockResolvedValueOnce({});

    renderDialog(
      <BotStatusDialog
        bot={active}
        counts={{
          activeOrders: 0,
          scheduledOrders: 0,
          positions: 0,
          closedTrades: 0,
          pendingRequests: 0,
        }}
        budget={undefined}
        onClose={vi.fn()}
      />,
    );
    await user.click(screen.getByRole('button', { name: 'Delete it' }));

    expect(await screen.findByText('Deactivated alpha')).toBeInTheDocument();
    expect(api.configureBot).toHaveBeenCalledTimes(1);
    expect(api.configureBot).toHaveBeenCalledWith({
      id: 'alpha',
      active: false,
    });
  });

  it('does not let Reactivate recreate a bot missing from fresh GetBots', async () => {
    const user = userEvent.setup();
    api.getBots.mockResolvedValueOnce([]);
    api.getActiveOrders.mockResolvedValueOnce([]);
    api.getPositions.mockResolvedValueOnce([]);
    api.getClosedTrades.mockResolvedValueOnce([]);

    renderDialog(
      <BotStatusDialog
        bot={bot({ active: false })}
        counts={{
          activeOrders: 0,
          scheduledOrders: 0,
          positions: 0,
          closedTrades: 1,
          pendingRequests: 0,
        }}
        budget={undefined}
        onClose={vi.fn()}
      />,
    );
    await user.click(screen.getByRole('button', { name: 'Reactivate it' }));

    expect(await screen.findByText(/would recreate a new default bot/i)).toBeInTheDocument();
    expect(api.configureBot).not.toHaveBeenCalled();
  });

  it.each([
    ['active deletion', bot()],
    ['inactive reactivation', bot({ active: false })],
  ])('blocks %s while queued baskets remain', async (_label, queuedBot) => {
    renderDialog(
      <BotStatusDialog
        bot={queuedBot}
        counts={{
          activeOrders: 0,
          scheduledOrders: 0,
          positions: 0,
          closedTrades: 0,
          pendingRequests: 1,
        }}
        budget={undefined}
        onClose={vi.fn()}
      />,
    );

    expect(screen.getByRole('button', { name: 'Cancel queued baskets first' })).toBeDisabled();
    expect(api.configureBot).not.toHaveBeenCalled();
  });
});

describe('the bot record form states the arithmetic that bounds it', () => {
  it('resolves the effective per-stock cap and the committed figure against the typed limit', () => {
    renderDialog(
      <BotConfigDialog
        mode="edit"
        bot={bot()}
        bots={[bot()]}
        accounts={[]}
        activeOrders={[]}
        positions={[]}
        pendingRequests={[]}
        budget={{
          portfolioValue: 1_000_000,
          accountBuyingPower: 500_000,
          remainingBotBudget: 4_000,
          limitPercentage: 100,
          limit: 10_000,
          limitPerPosition: 2_000,
          limitPercentagePerPosition: 20,
        }}
        onClose={vi.fn()}
      />,
    );

    // min(2.000 TL, 1.000.000 x 20%) is the TL figure, and neither number alone said so.
    expect(screen.getByText(/Right now that is 2\.000 TL — the TL figure binds/)).toBeVisible();
    expect(screen.getByText(/Committed right now: 6\.000 of 10\.000/)).toBeVisible();
  });

  it('says a per-stock cap above the total cap can never bind', async () => {
    const user = userEvent.setup();
    renderDialog(
      <BotConfigDialog
        mode="edit"
        bot={bot()}
        bots={[bot()]}
        accounts={[]}
        activeOrders={[]}
        positions={[]}
        pendingRequests={[]}
        budget={undefined}
        onClose={vi.fn()}
      />,
    );

    const perStock = screen.getByLabelText(/per stock · TL/);
    await user.clear(perStock);
    await user.type(perStock, '99.000');

    expect(screen.getByText(/can never bind/)).toBeVisible();
  });

  it('does not draw an untouched edit form as a fault', () => {
    renderDialog(
      <BotConfigDialog
        mode="edit"
        bot={bot()}
        bots={[bot()]}
        accounts={[]}
        activeOrders={[]}
        positions={[]}
        pendingRequests={[]}
        budget={undefined}
        onClose={vi.fn()}
      />,
    );

    const message = screen.getByText(/Nothing has changed yet/);
    expect(message).toHaveClass('muted');
    expect(message).not.toHaveAttribute('role', 'alert');
    expect(screen.getByRole('button', { name: 'Send the changes' })).toBeDisabled();
  });
});

function renderDialog(element: ReactElement) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(<QueryClientProvider client={queryClient}>{element}</QueryClientProvider>);
}

function bot(overrides: Partial<Bot> = {}): Bot {
  return {
    id: 'alpha',
    algoritmId: 'algorithm-a',
    accountId: '0~1887087',
    brokerageId: '115',
    limitPercentage: 100,
    limit: 10_000,
    limitPerPosition: 2_000,
    limitPercentagePerPosition: 20,
    emails: ['owner@example.com'],
    forbiddenStocks: ['THYAO'],
    active: true,
    description: 'test bot',
    complete: true,
    ...overrides,
  };
}

function pendingRequest(overrides: Partial<PendingOrderRequest> = {}): PendingOrderRequest {
  return {
    id: 1,
    botId: 'alpha',
    direction: 'buy',
    request: null,
    createdTime: 1,
    retryCount: 0,
    nextAttemptTime: 2,
    ...overrides,
  };
}
