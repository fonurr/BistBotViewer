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
});

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}
