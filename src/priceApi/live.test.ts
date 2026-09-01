import { makeQuote } from '../test/fixtures/bist';
import { subscribeToPriceEvents, type PriceLiveHandlers } from './live';

class FakeEventSource {
  static latest: FakeEventSource | null = null;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;
  private readonly listeners = new Map<string, Array<(event: Event) => void>>();

  constructor(readonly url: string) {
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

  close() {
    this.closed = true;
  }
}

function handlers(): PriceLiveHandlers {
  return {
    open: vi.fn(),
    error: vi.fn(),
    protocolError: vi.fn(),
    subscribed: vi.fn(),
    quote: vi.fn(),
    status: vi.fn(),
    stopped: vi.fn(),
  };
}

describe('the price stream boundary', () => {
  beforeEach(() => vi.stubGlobal('EventSource', FakeEventSource as unknown as typeof EventSource));
  afterEach(() => vi.unstubAllGlobals());

  it('passes a valid quote through and reports the subscribed set', () => {
    const listeners = handlers();
    subscribeToPriceEvents('/bridge/price/stream?symbols=THYAO', listeners);

    FakeEventSource.latest?.emit('quote', JSON.stringify(makeQuote()));
    FakeEventSource.latest?.emit(
      'subscribed',
      JSON.stringify({ stream_id: 'abc', symbols: ['THYAO'], accepted: ['THYAO'], rejected: [] }),
    );

    expect(listeners.quote).toHaveBeenCalledOnce();
    expect(listeners.subscribed).toHaveBeenCalledWith(
      expect.objectContaining({ stream_id: 'abc', symbols: ['THYAO'] }),
    );
    expect(listeners.protocolError).not.toHaveBeenCalled();
  });

  it('carries the producer status, which is also the stream keep-alive', () => {
    const listeners = handlers();
    subscribeToPriceEvents('/bridge/price/stream?symbols=THYAO', listeners);

    FakeEventSource.latest?.emit(
      'status',
      JSON.stringify({
        feed: 'stalled',
        feed_age_ms: 120_000,
        producer_uptime_s: 900,
        reconnects: 2,
        tracked_symbols: 646,
        server_ts: 1,
      }),
    );

    expect(listeners.status).toHaveBeenCalledWith(
      expect.objectContaining({ feed: 'stalled', feed_age_ms: 120_000 }),
    );
  });

  it('reports the session ending so the viewer can fall back to stored bars', () => {
    const listeners = handlers();
    subscribeToPriceEvents('/bridge/price/stream?symbols=THYAO', listeners);

    FakeEventSource.latest?.emit('stopped', JSON.stringify({ reason: 'seans sonu' }));

    expect(listeners.stopped).toHaveBeenCalledWith('seans sonu');
  });

  it('escalates a malformed event rather than pricing a row off it', () => {
    const listeners = handlers();
    subscribeToPriceEvents('/bridge/price/stream?symbols=THYAO', listeners);

    FakeEventSource.latest?.emit('quote', '{not json');
    FakeEventSource.latest?.emit('quote', JSON.stringify({ symbol: 'THYAO', feed: 'nonsense' }));

    expect(listeners.protocolError).toHaveBeenCalledTimes(2);
    expect(listeners.quote).not.toHaveBeenCalled();
  });

  it('closes the stream when the subscription is dropped', () => {
    const unsubscribe = subscribeToPriceEvents('/bridge/price/stream?symbols=THYAO', handlers());
    unsubscribe();
    expect(FakeEventSource.latest?.closed).toBe(true);
  });
});
