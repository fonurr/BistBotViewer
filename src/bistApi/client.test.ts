import { bistApi } from './client';
import { makeActiveOrder, makeBotBudget } from '../test/fixtures';

describe('bistApi write errors', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('rechecks the shared write hold after an awaited session bootstrap', async () => {
    vi.resetModules();
    let releaseSession!: (response: Response) => void;
    const sessionResponse = new Promise<Response>((resolve) => {
      releaseSession = resolve;
    });
    const fetchMock = vi.fn<typeof fetch>().mockReturnValueOnce(sessionResponse);
    vi.stubGlobal('fetch', fetchMock);
    const { bistApi: isolatedApi, installBistWriteGuard } = await import('./client');

    let heldReason: string | null = null;
    const uninstall = installBistWriteGuard(() => heldReason);
    const request = isolatedApi.cancelOrders('bot-1', ['order-1']);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    heldReason = 'The order stream went down.';
    releaseSession(
      new Response(JSON.stringify({ csrfToken: 's'.repeat(32) }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    await expect(request).rejects.toMatchObject({
      type: 'WriteHeld',
      mayHaveReachedExchange: false,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    uninstall();
  });

  it('restarts a budget read when an order event straddles its first snapshot', async () => {
    vi.resetModules();
    let releaseFirst!: (response: Response) => void;
    const firstResponse = new Promise<Response>((resolve) => {
      releaseFirst = resolve;
    });
    const freshBudget = makeBotBudget({ remainingBotBudget: 300_000 });
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockReturnValueOnce(firstResponse)
      .mockResolvedValueOnce(jsonResponse(freshBudget));
    vi.stubGlobal('fetch', fetchMock);
    const [{ bistApi: isolatedApi }, { recordBistWriteEvent }] = await Promise.all([
      import('./client'),
      import('./eventJournal'),
    ]);

    const request = isolatedApi.getBotBudget('bot-alpha');
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    recordBistWriteEvent({
      table: 'ActiveOrders',
      action: 'insert',
      botId: 'bot-alpha',
      row: makeActiveOrder(),
    });
    releaseFirst(jsonResponse(makeBotBudget({ remainingBotBudget: 420_000 })));

    await expect(request).resolves.toMatchObject({ remainingBotBudget: 300_000 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('preserves a queued AccountInformationUnavailable takeover', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ csrfToken: 's'.repeat(32) }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            type: 'AccountInformationUnavailable',
            information: 'The account is not being served.',
            queued: true,
            retryAt: 1_786_559_700_000,
            attemptsLeft: 3,
          }),
          { status: 503, headers: { 'Content-Type': 'application/json' } },
        ),
      );
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      bistApi.sendOrders({
        botId: 'bot-1',
        direction: 'buy',
        type: 'limit',
        stocks: [{ symbol: 'AKBNK', price: 38.16, quantity: 10 }],
      }),
    ).rejects.toMatchObject({
      type: 'AccountInformationUnavailable',
      queued: true,
      retryAt: 1_786_559_700_000,
      attemptsLeft: 3,
      mayHaveReachedExchange: false,
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('refuses a price rule the server would refuse, before any request is made', () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    // The request never becomes a promise: the schema refuses it first.
    // Both rules describe a position and the buy that opens it.
    expect(() =>
      bistApi.sendOrders({
        botId: 'bot-1',
        direction: 'sell',
        type: 'limit',
        stocks: [{ symbol: 'AKBNK', price: 38.16, quantity: 10, openPrice: { upperLimit: 5 } }],
      }),
    ).toThrow(/sell stock cannot carry openPrice/);

    // An Opening auction is matched at 09:55; a band could never act on it.
    expect(() =>
      bistApi.sendOrders({
        botId: 'bot-1',
        direction: 'buy',
        type: 'limit',
        openPrice: { lowerLimit: -9.8 },
        stocks: [
          {
            symbol: 'AKBNK',
            price: 38.16,
            openTime: { day: '2026-08-25', type: 'OpeningAuction' },
          },
        ],
      }),
    ).toThrow(/Opening auction/);

    // The exchange's own daily cap bounds a percentage read off the previous close.
    expect(() =>
      bistApi.editOrders({
        botId: 'bot-1',
        direction: 'buy',
        type: 'limit',
        orderIds: ['order-1'],
        stocks: [
          { symbol: 'AKBNK', orderId: 'order-1', price: 38.16, openPrice: { upperLimit: 10.5 } },
        ],
      }),
    ).toThrow();

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('carries a rule through, and lets an explicit null disarm one', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({}));
    vi.stubGlobal('fetch', fetchMock);

    await bistApi.editOrders({
      botId: 'bot-1',
      direction: 'buy',
      type: 'limit',
      orderIds: ['order-1'],
      stocks: [
        {
          symbol: 'AKBNK',
          orderId: 'order-1',
          price: 38.16,
          openPrice: null,
          closePrice: { stopLoss: { limit: -2, base: 'actualPrice' } },
        },
      ],
    });

    const body = JSON.parse(String(fetchMock.mock.calls.at(-1)![1].body));
    expect(body.stocks[0]).toMatchObject({
      openPrice: null,
      closePrice: { stopLoss: { limit: -2, base: 'actualPrice' } },
    });
  });
});

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}
