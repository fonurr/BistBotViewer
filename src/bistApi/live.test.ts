import { subscribeToBistEvents, type BistLiveHandlers } from './live';

class FakeEventSource {
  static latest: FakeEventSource | null = null;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  private readonly listeners = new Map<string, Array<(event: Event) => void>>();

  constructor() {
    FakeEventSource.latest = this;
  }

  addEventListener(type: string, listener: (event: Event) => void) {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  emit(type: string, data: string) {
    const event = new MessageEvent(type, { data });
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }

  close() {}
}

describe('the BIST event boundary', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('escalates malformed events instead of silently leaving the stream live', () => {
    vi.stubGlobal('EventSource', FakeEventSource as unknown as typeof EventSource);
    const handlers: BistLiveHandlers = {
      open: vi.fn(),
      error: vi.fn(),
      protocolError: vi.fn(),
      status: vi.fn(),
      refreshStarted: vi.fn(),
      refreshFinished: vi.fn(),
      write: vi.fn(),
    };
    subscribeToBistEvents('/bridge/bist/events', handlers);

    FakeEventSource.latest?.emit('write', '{not json');

    expect(handlers.protocolError).toHaveBeenCalledOnce();
    expect(handlers.write).not.toHaveBeenCalled();
  });

  it('passes a valid write envelope to reconciliation', () => {
    vi.stubGlobal('EventSource', FakeEventSource as unknown as typeof EventSource);
    const handlers: BistLiveHandlers = {
      open: vi.fn(),
      error: vi.fn(),
      protocolError: vi.fn(),
      status: vi.fn(),
      refreshStarted: vi.fn(),
      refreshFinished: vi.fn(),
      write: vi.fn(),
    };
    subscribeToBistEvents('/bridge/bist/events', handlers);

    FakeEventSource.latest?.emit(
      'write',
      JSON.stringify({
        table: 'Positions',
        action: 'delete',
        botId: 'bot-1',
        row: { id: 1 },
      }),
    );

    expect(handlers.write).toHaveBeenCalledOnce();
    expect(handlers.protocolError).not.toHaveBeenCalled();
  });
});
