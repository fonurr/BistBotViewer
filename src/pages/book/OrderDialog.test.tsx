import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, type RenderResult } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { BistApiError } from '../../bistApi/errors';
import type { ActiveOrder, CanceledOrder } from '../../bistApi/types';
import { buildBookChains, type BookChain } from '../../domain/chains';
import { makeActiveOrder, makeBot, makeBotBudget, makePosition } from '../../test/fixtures';
import { OrderDialog, type OrderDialogAction } from './OrderDialog';

const api = vi.hoisted(() => ({
  cancelOrders: vi.fn(),
  editOrders: vi.fn(),
  getActiveOrders: vi.fn(),
  getCanceledOrders: vi.fn(),
  sendOrders: vi.fn(),
}));

const runtime = vi.hoisted(() => ({
  writesHeldReason: null as string | null,
}));

vi.mock('../../bistApi/client', () => ({ bistApi: api }));
vi.mock('../../app/ViewerRuntime', () => ({
  useViewerRuntime: () => runtime,
}));

beforeEach(() => {
  api.getActiveOrders.mockResolvedValue([]);
  api.getCanceledOrders.mockResolvedValue([]);
});

afterEach(() => {
  runtime.writesHeldReason = null;
  Object.values(api).forEach((mock) => mock.mockReset());
});

describe('OrderDialog write safety', () => {
  it('preserves a Turkish decimal price and refuses a fractional share count', async () => {
    const user = userEvent.setup();
    const chain = chainFor({ activeOrders: [makeActiveOrder()] });
    const row = chain.activeRows[0]!;
    api.editOrders.mockResolvedValue({});
    renderDialog(chain, { kind: 'edit', row });

    const price = screen.getByLabelText('Price');
    const quantity = screen.getByLabelText('Quantity');
    expect(price).toHaveValue('68,25');
    await user.clear(price);
    await user.type(price, '38,16');
    await user.clear(quantity);
    await user.type(quantity, '1,9');

    expect(screen.getByText('Quantity must be a whole number greater than zero.')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
    expect(api.editOrders).not.toHaveBeenCalled();

    await user.clear(quantity);
    await user.type(quantity, '2');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(api.editOrders).toHaveBeenCalledTimes(1));
    expect(api.editOrders).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'limit',
        stocks: [expect.objectContaining({ price: 38.16, quantity: 2 })],
      }),
    );
  });

  it('allows a deactivated bot to edit an existing buy and reports only acceptance', async () => {
    const user = userEvent.setup();
    const chain = chainFor({ activeOrders: [makeActiveOrder()] });
    const row = chain.activeRows[0]!;
    api.editOrders.mockResolvedValue({});
    renderWithClient(
      <OrderDialog
        open
        chain={chain}
        initialAction={{ kind: 'edit', row }}
        bot={makeBot({ active: false })}
        budget={makeBotBudget()}
        holidays={[]}
        onClose={vi.fn()}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'Save' }));

    expect(await screen.findByText('Accepted')).toBeVisible();
    expect(screen.getByText(/previous confirmed values until a refresh/i)).toBeVisible();
    expect(api.editOrders).toHaveBeenCalledTimes(1);
  });

  it('lets an explicit scheduled sell become sell-all using pending-buy projection', async () => {
    const user = userEvent.setup();
    const buy = makeActiveOrder({
      orderQuantity: 100,
      clientOrderId: 'opening-buy',
      chainId: 'projected-chain',
    });
    const scheduledSell = makeActiveOrder({
      id: 102,
      clientOrderId: 'scheduled-sell',
      chainId: 'projected-chain',
      parentClientOrderId: 'opening-buy',
      direction: 'sell',
      type: 'market',
      intentType: 'market',
      orderPrice: null,
      orderQuantity: 30,
      status: 'Scheduled',
      matriksOrderId: null,
      matriksOrderId2: null,
      orderTime: null,
      sentTime: null,
      scheduledTime: Date.now() - 1_000,
      whenType: 'Retry',
    });
    const chain = chainFor({ activeOrders: [buy, scheduledSell] });
    const row = chain.activeRows.find((candidate) => candidate.clientOrderId === 'scheduled-sell')!;
    api.editOrders.mockResolvedValue({});
    renderDialog(chain, { kind: 'edit', row });

    expect(screen.getByText(/Available to this order: 100 shares/i)).toBeVisible();
    await user.clear(screen.getByLabelText('Quantity (optional)'));
    await user.click(screen.getByRole('button', { name: 'Save' }));

    expect(await screen.findByText('Schedule updated')).toBeVisible();
    expect(api.editOrders).toHaveBeenCalledWith(
      expect.objectContaining({
        direction: 'sell',
        stocks: [expect.not.objectContaining({ quantity: expect.anything() })],
      }),
    );
  });

  it('keeps a typed draft across equivalent SSE rows, then closes it on PendingCancel', async () => {
    const user = userEvent.setup();
    const order = makeActiveOrder();
    const chain = chainFor({ activeOrders: [order] });
    const row = chain.activeRows[0]!;
    const client = queryClient();
    const rendered = render(withClient(dialogElement(chain, { kind: 'edit', row }), client));
    const price = screen.getByLabelText('Price');
    await user.clear(price);
    await user.type(price, '39,75');

    const equivalentChain = chainFor({ activeOrders: [{ ...order }] });
    const equivalentRow = equivalentChain.activeRows[0]!;
    rendered.rerender(
      withClient(dialogElement(equivalentChain, { kind: 'edit', row: equivalentRow }), client),
    );
    expect(screen.getByLabelText('Price')).toHaveValue('39,75');

    const pendingChain = chainFor({
      activeOrders: [{ ...order, status: 'PendingCancel', cancelSource: 'bot' }],
    });
    const pendingRow = pendingChain.activeRows[0]!;
    rendered.rerender(
      withClient(dialogElement(pendingChain, { kind: 'edit', row: pendingRow }), client),
    );

    expect(await screen.findByText(/cancel in flight/i)).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Save' })).not.toBeInTheDocument();
    expect(api.editOrders).not.toHaveBeenCalled();
  });

  it('calls a live cancel once and reports only Accepted', async () => {
    const user = userEvent.setup();
    const chain = chainFor({ activeOrders: [makeActiveOrder()] });
    const row = chain.activeRows[0]!;
    api.cancelOrders.mockResolvedValue({});
    renderDialog(chain, { kind: 'cancel', row });

    await user.click(screen.getByRole('button', { name: 'Cancel order' }));

    expect(await screen.findByText('Accepted')).toBeVisible();
    expect(screen.queryByText('Succeeded')).not.toBeInTheDocument();
    expect(api.cancelOrders).toHaveBeenCalledTimes(1);
  });

  it('labels a server-held scheduled cancellation Removed', async () => {
    const user = userEvent.setup();
    const scheduled = makeActiveOrder({
      status: 'Scheduled',
      matriksOrderId: null,
      orderTime: null,
      sentTime: null,
      scheduledTime: Date.now() + 60_000,
    });
    const chain = chainFor({ activeOrders: [scheduled] });
    const row = chain.activeRows[0]!;
    proveScheduledRemoval(scheduled);
    api.cancelOrders.mockResolvedValue({});
    renderDialog(chain, { kind: 'cancel', row });

    await user.click(screen.getByRole('button', { name: 'Cancel order' }));

    expect(await screen.findByText('Removed')).toBeVisible();
    expect(api.getActiveOrders).toHaveBeenCalledTimes(2);
    expect(api.getCanceledOrders).toHaveBeenCalledTimes(1);
    expect(api.cancelOrders).toHaveBeenCalledTimes(1);
  });

  it('does not mark a scheduled cancel Removed when the canceled row shows exchange activity', async () => {
    const user = userEvent.setup();
    const scheduled = makeActiveOrder({
      status: 'Scheduled',
      matriksOrderId: null,
      orderTime: null,
      sentTime: null,
      scheduledTime: Date.now() + 60_000,
    });
    const chain = chainFor({ activeOrders: [scheduled] });
    const row = chain.activeRows[0]!;
    api.getActiveOrders.mockResolvedValueOnce([scheduled]).mockResolvedValueOnce([]);
    api.getCanceledOrders.mockResolvedValue([
      {
        ...confirmedScheduledRemoval(scheduled),
        matriksOrderId: 'mx-raced-to-active',
        sentTime: Date.now(),
      },
    ]);
    api.cancelOrders.mockResolvedValue({});
    renderDialog(chain, { kind: 'cancel', row });

    await user.click(screen.getByRole('button', { name: 'Cancel order' }));

    expect(await screen.findByRole('button', { name: 'Done' })).toBeVisible();
    expect(api.cancelOrders).toHaveBeenCalledTimes(1);
    expect(screen.queryByText('Removed')).not.toBeInTheDocument();
  });

  it('reports a server-owned send as Queued and never retries it', async () => {
    const user = userEvent.setup();
    const chain = chainFor({ positions: [makePosition()] });
    const row = chain.positionRows[0]!;
    api.sendOrders.mockRejectedValue(
      new BistApiError({
        kind: 'unavailable',
        type: 'AccountInformationUnavailable',
        message: 'Account information is temporarily unavailable.',
        queued: true,
        retryAt: Date.now() + 60_000,
        attemptsLeft: 2,
      }),
    );
    renderDialog(chain, { kind: 'sell', row });

    await user.click(screen.getByRole('button', { name: 'sell' }));

    expect(await screen.findByText('Queued')).toBeVisible();
    expect(screen.getByText(/server owns this request/i)).toBeVisible();
    expect(screen.queryByRole('button', { name: /retry/i })).not.toBeInTheDocument();
    expect(api.sendOrders).toHaveBeenCalledTimes(1);
  });

  it('does not perform the second fire write when the stream drops after removal', async () => {
    const user = userEvent.setup();
    const scheduled = makeActiveOrder({
      status: 'Scheduled',
      matriksOrderId: null,
      orderTime: null,
      sentTime: null,
      scheduledTime: Date.now() + 60_000,
    });
    const chain = chainFor({ activeOrders: [scheduled] });
    const row = chain.activeRows[0]!;
    proveScheduledRemoval(scheduled);
    let confirmCancel: (() => void) | undefined;
    api.cancelOrders.mockReturnValue(
      new Promise<void>((resolve) => {
        confirmCancel = resolve;
      }),
    );
    const element = dialogElement(chain, { kind: 'fire', row });
    const rendered = renderWithClient(element);

    await user.click(screen.getByRole('button', { name: 'Fire now' }));
    runtime.writesHeldReason = 'The order stream dropped.';
    rendered.rerender(withClient(element));
    confirmCancel?.();

    expect(await screen.findByText('Half done · replacement held')).toBeVisible();
    expect(screen.getByText('Not fired')).toBeVisible();
    expect(api.cancelOrders).toHaveBeenCalledTimes(1);
    expect(api.sendOrders).not.toHaveBeenCalled();
  });

  it('keeps a removed schedule distinct from its queued replacement', async () => {
    const user = userEvent.setup();
    const scheduled = makeActiveOrder({
      status: 'Scheduled',
      matriksOrderId: null,
      orderTime: null,
      sentTime: null,
      scheduledTime: Date.now() + 60_000,
    });
    const chain = chainFor({ activeOrders: [scheduled] });
    const row = chain.activeRows[0]!;
    proveScheduledRemoval(scheduled);
    api.cancelOrders.mockResolvedValue({});
    api.sendOrders.mockRejectedValue(
      new BistApiError({
        kind: 'unavailable',
        message: 'Taken over for replay.',
        queued: true,
      }),
    );
    renderDialog(chain, { kind: 'fire', row });

    await user.click(screen.getByRole('button', { name: 'Fire now' }));

    expect(await screen.findByText('Half done · replacement queued')).toBeVisible();
    expect(screen.getByText('Removed')).toBeVisible();
    expect(screen.getByText('Queued')).toBeVisible();
    expect(api.getActiveOrders).toHaveBeenCalledTimes(2);
    expect(api.getCanceledOrders).toHaveBeenCalledTimes(1);
    expect(api.cancelOrders).toHaveBeenCalledTimes(1);
    expect(api.sendOrders).toHaveBeenCalledTimes(1);
  });

  it('does not cancel or fire when the fresh preflight reveals the order became active', async () => {
    const user = userEvent.setup();
    const scheduled = makeActiveOrder({
      status: 'Scheduled',
      matriksOrderId: null,
      orderTime: null,
      sentTime: null,
      scheduledTime: Date.now() + 60_000,
    });
    const activeAfterCancel = makeActiveOrder({
      ...scheduled,
      status: 'New',
      matriksOrderId: 'mx-raced-to-active',
      orderTime: Date.now(),
      sentTime: Date.now(),
      scheduledTime: null,
    });
    const chain = chainFor({ activeOrders: [scheduled] });
    const row = chain.activeRows[0]!;
    api.getActiveOrders.mockResolvedValue([activeAfterCancel]);
    api.getCanceledOrders.mockResolvedValue([confirmedScheduledRemoval(scheduled)]);
    api.cancelOrders.mockResolvedValue({});
    renderDialog(chain, { kind: 'fire', row });

    await user.click(screen.getByRole('button', { name: 'Fire now' }));

    expect(await screen.findByRole('button', { name: 'Done' })).toBeVisible();
    expect(api.getActiveOrders).toHaveBeenCalledTimes(1);
    expect(api.getCanceledOrders).not.toHaveBeenCalled();
    expect(api.cancelOrders).not.toHaveBeenCalled();
    expect(api.sendOrders).not.toHaveBeenCalled();
    expect(screen.queryByText('Removed')).not.toBeInTheDocument();
  });

  it.each([
    ['a different client id', { clientOrderId: 'another-schedule' }],
    ['a different cancellation status', { status: 'Canceled' as const }],
    ['an exchange order time', { orderTime: Date.now() }],
    ['a server send time', { sentTime: Date.now() }],
    ['a primary Matriks id', { matriksOrderId: 'mx-already-sent' }],
    ['a secondary Matriks id', { matriksOrderId2: 'mx2-already-sent' }],
  ])('does not fire when the canceled-row proof contains %s', async (_label, unsafeFields) => {
    const user = userEvent.setup();
    const scheduled = makeActiveOrder({
      status: 'Scheduled',
      matriksOrderId: null,
      orderTime: null,
      sentTime: null,
      scheduledTime: Date.now() + 60_000,
    });
    const chain = chainFor({ activeOrders: [scheduled] });
    const row = chain.activeRows[0]!;
    api.getActiveOrders.mockReset();
    api.getActiveOrders.mockResolvedValueOnce([scheduled]).mockResolvedValueOnce([]);
    api.getCanceledOrders.mockResolvedValue([
      { ...confirmedScheduledRemoval(scheduled), ...unsafeFields },
    ]);
    api.cancelOrders.mockResolvedValue({});
    renderDialog(chain, { kind: 'fire', row });

    await user.click(screen.getByRole('button', { name: 'Fire now' }));

    expect(await screen.findByRole('button', { name: 'Done' })).toBeVisible();
    expect(api.cancelOrders).toHaveBeenCalledTimes(1);
    expect(api.sendOrders).not.toHaveBeenCalled();
    expect(screen.queryByText('Removed')).not.toBeInTheDocument();
  });

  it('stays in Sending when fresh chain and action objects arrive during an unresolved cancel', async () => {
    const user = userEvent.setup();
    const scheduled = makeActiveOrder({
      status: 'Scheduled',
      matriksOrderId: null,
      orderTime: null,
      sentTime: null,
      scheduledTime: Date.now() + 60_000,
    });
    const chain = chainFor({ activeOrders: [scheduled] });
    const row = chain.activeRows[0]!;
    proveScheduledRemoval(scheduled);
    let confirmCancel: (() => void) | undefined;
    api.cancelOrders.mockReturnValue(
      new Promise<void>((resolve) => {
        confirmCancel = resolve;
      }),
    );
    const onClose = vi.fn();
    const client = queryClient();
    const rendered = render(
      withClient(dialogElement(chain, { kind: 'cancel', row }, onClose), client),
    );

    await user.click(screen.getByRole('button', { name: 'Cancel order' }));
    await waitFor(() => expect(api.cancelOrders).toHaveBeenCalledTimes(1));
    expect(screen.getByRole('heading', { name: /Sending/ })).toBeVisible();

    const freshScheduled = { ...scheduled, scheduledTime: scheduled.scheduledTime! + 1_000 };
    const freshChain = chainFor({ activeOrders: [freshScheduled] });
    const freshRow = freshChain.activeRows[0]!;
    rendered.rerender(
      withClient(dialogElement(freshChain, { kind: 'cancel', row: freshRow }, onClose), client),
    );

    expect(screen.getByRole('heading', { name: /Sending/ })).toBeVisible();
    expect(screen.queryByRole('button', { name: /^Close$/ })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Close dialog' })).toBeDisabled();
    await user.keyboard('{Escape}');
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole('heading', { name: /Sending/ })).toBeVisible();

    confirmCancel?.();
    expect(await screen.findByText('Removed')).toBeVisible();
  });

  it('treats a semantically incomplete send reply as unknown', async () => {
    const user = userEvent.setup();
    const chain = chainFor({ positions: [makePosition()] });
    const row = chain.positionRows[0]!;
    api.sendOrders.mockResolvedValue({ toOrder: [], skippedList: [] });
    renderDialog(chain, { kind: 'sell', row });

    await user.click(screen.getByRole('button', { name: 'sell' }));

    expect(await screen.findByText('No answer')).toBeVisible();
    expect(screen.getByText(/do not send it again/i)).toBeVisible();
    expect(api.sendOrders).toHaveBeenCalledTimes(1);
  });

  it('forces an explicit replacement when a canceled buy had a reversing sell', () => {
    const buy = canceledOrder({ clientOrderId: 'buy-dead', chainId: 'buy-dead' });
    const close = canceledOrder({
      id: 402,
      clientOrderId: 'sell-dead',
      chainId: 'buy-dead',
      parentClientOrderId: 'buy-dead',
      direction: 'sell',
    });
    const chain = chainFor({ canceledOrders: [buy, close] });
    const row = chain.canceledRows.find((candidate) => candidate.clientOrderId === 'buy-dead')!;
    renderDialog(chain, { kind: 'resend', row });

    expect(screen.getByRole('radio', { name: 'Resend as it was' })).toBeDisabled();
    expect(screen.getByRole('radio', { name: 'Change it first' })).toBeChecked();
    expect(screen.getByText(/does not preserve its closeTime/i)).toBeVisible();
    expect(api.sendOrders).not.toHaveBeenCalled();
  });
});

describe('OrderDialog copy', () => {
  it('names the orders that claim the shares the sell form cannot have', () => {
    const chain = chainFor({
      positions: [makePosition()],
      activeOrders: [
        makeActiveOrder({
          id: 102,
          clientOrderId: 'client-thyao-sell-1',
          matriksOrderId: 'mx-thyao-sell-1',
          symbol: 'THYAO',
          direction: 'sell',
          orderQuantity: 40,
          chainId: 'chain-thyao',
        }),
      ],
    });
    renderDialog(chain, { kind: 'sell', row: chain.positionRows[0]! });

    expect(
      screen.getByText(/Sellable by hand: 60 of 100 — the resting limit sell claims 40/),
    ).toBeVisible();
    expect(screen.getByRole('heading', { name: 'Sell THYAO' })).toBeVisible();
  });

  it('excludes an edited sell from the claims it reports against itself', () => {
    const chain = chainFor({
      positions: [makePosition()],
      activeOrders: [
        makeActiveOrder({
          id: 102,
          clientOrderId: 'client-thyao-sell-1',
          matriksOrderId: 'mx-thyao-sell-1',
          symbol: 'THYAO',
          direction: 'sell',
          orderQuantity: 40,
          chainId: 'chain-thyao',
        }),
      ],
    });
    renderDialog(chain, { kind: 'edit', row: chain.activeRows[0]! });

    expect(screen.getByText(/Sellable by hand: 100 of 100\./)).toBeVisible();
    expect(screen.getByRole('heading', { name: 'Edit sell THYAO' })).toBeVisible();
  });
});

function renderDialog(chain: BookChain, action: OrderDialogAction): RenderResult {
  return renderWithClient(dialogElement(chain, action));
}

function dialogElement(
  chain: BookChain,
  action: OrderDialogAction,
  onClose: () => void = vi.fn(),
): ReactElement {
  return (
    <OrderDialog
      open
      chain={chain}
      initialAction={action}
      bot={makeBot()}
      budget={makeBotBudget()}
      holidays={[]}
      onClose={onClose}
    />
  );
}

const queryClient = () =>
  new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });

function renderWithClient(element: ReactElement): RenderResult {
  return render(withClient(element));
}

function withClient(element: ReactElement, client = queryClient()): ReactElement {
  return <QueryClientProvider client={client}>{element}</QueryClientProvider>;
}

function chainFor(input: {
  activeOrders?: ActiveOrder[];
  canceledOrders?: CanceledOrder[];
  positions?: ReturnType<typeof makePosition>[];
}): BookChain {
  const [chain] = buildBookChains({
    activeOrders: input.activeOrders ?? [],
    canceledOrders: input.canceledOrders ?? [],
    positions: input.positions ?? [],
    closedTrades: [],
  });
  if (!chain) throw new Error('The fixture did not create a Book chain.');
  return chain;
}

function canceledOrder(overrides: Partial<CanceledOrder> = {}): CanceledOrder {
  return {
    id: 401,
    botId: 'bot-alpha',
    clientOrderId: 'buy-dead',
    matriksOrderId: 'mx-dead',
    matriksOrderId2: null,
    symbol: 'AKBNK',
    orderTime: Date.now() - 60_000,
    sentTime: Date.now() - 59_000,
    cancelTime: Date.now() - 30_000,
    orderQuantity: 40,
    canceledQuantity: 40,
    direction: 'buy',
    type: 'limit',
    orderPrice: 68.25,
    timeInForce: '0',
    status: 'Canceled',
    explanation: null,
    retryCount: 0,
    intentType: 'limit',
    cancelAtFloor: false,
    chainId: 'buy-dead',
    parentClientOrderId: null,
    retryOfClientOrderId: null,
    ...overrides,
  };
}

function proveScheduledRemoval(order: ActiveOrder): void {
  api.getActiveOrders.mockReset();
  api.getActiveOrders.mockResolvedValueOnce([order]).mockResolvedValueOnce([]);
  api.getCanceledOrders.mockResolvedValue([confirmedScheduledRemoval(order)]);
}

function confirmedScheduledRemoval(order: ActiveOrder): CanceledOrder {
  return canceledOrder({
    id: order.id,
    botId: order.botId,
    clientOrderId: order.clientOrderId,
    matriksOrderId: null,
    matriksOrderId2: null,
    symbol: order.symbol,
    orderTime: null,
    sentTime: null,
    cancelTime: Date.now(),
    orderQuantity: order.orderQuantity ?? 0,
    canceledQuantity: order.orderQuantity ?? 0,
    direction: order.direction,
    type: order.type,
    orderPrice: order.orderPrice,
    timeInForce: order.timeInForce,
    status: 'CanceledByBot',
    retryCount: order.retryCount,
    intentType: order.intentType,
    cancelAtFloor: order.cancelAtFloor,
    chainId: order.chainId,
    parentClientOrderId: order.parentClientOrderId,
    retryOfClientOrderId: order.retryOfClientOrderId,
  });
}
