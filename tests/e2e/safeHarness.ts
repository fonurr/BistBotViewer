import { expect, test as base, type Page, type Request, type Route } from '@playwright/test';

import {
  FIXTURE_NOW_MS,
  makeBookReadFixture,
  makeLogReadFixture,
  makePriceReadFixture,
  type BistReadFixture,
  type LogReadFixture,
  type PriceReadFixture,
} from '../../src/test/fixtures';

export interface BrowserReadScenario {
  bist: BistReadFixture;
  price: PriceReadFixture;
  logs: LogReadFixture;
}

export interface ObservedBridgeRequest {
  method: string;
  path: string;
  body: unknown;
}

export type FakeStreamKind = 'orders' | 'prices';

interface FakeStreamController {
  open: (lastUpdateTime?: number, kind?: FakeStreamKind) => Promise<void>;
  down: (kind?: FakeStreamKind) => Promise<void>;
  emit: (type: string, payload: unknown, kind?: FakeStreamKind) => Promise<void>;
}

interface SafeBridgeHarness {
  requests: ObservedBridgeRequest[];
  stream: FakeStreamController;
  useScenario: (scenario: BrowserReadScenario) => void;
}

interface HarnessFixtures {
  safeBridge: SafeBridgeHarness;
}

const writeRpcs = new Set([
  'RefreshData',
  'ConfigureBot',
  'SendOrders',
  'EditOrders',
  'CancelOrders',
  'CancelPendingOrderRequests',
]);

export function makeBrowserScenario(
  overrides: Partial<BrowserReadScenario> = {},
): BrowserReadScenario {
  return {
    bist: makeBookReadFixture(),
    price: makePriceReadFixture(),
    logs: makeLogReadFixture(),
    ...overrides,
  };
}

export const test = base.extend<HarnessFixtures>({
  safeBridge: async ({ context, page }, use) => {
    let scenario = makeBrowserScenario();
    const requests: ObservedBridgeRequest[] = [];
    const violations: string[] = [];

    await page.addInitScript(() => {
      class FixtureEventSource extends EventTarget {
        static readonly CONNECTING = 0;
        static readonly OPEN = 1;
        static readonly CLOSED = 2;

        readonly CONNECTING = 0;
        readonly OPEN = 1;
        readonly CLOSED = 2;
        readonly url: string;
        readonly withCredentials: boolean;
        readyState = FixtureEventSource.CONNECTING;
        onopen: ((event: Event) => void) | null = null;
        onerror: ((event: Event) => void) | null = null;
        onmessage: ((event: MessageEvent) => void) | null = null;

        constructor(url: string | URL, init?: EventSourceInit) {
          super();
          this.url = new URL(String(url), window.location.href).href;
          this.withCredentials = Boolean(init?.withCredentials);
          fixtureState.sources.push(this);
        }

        close() {
          this.readyState = FixtureEventSource.CLOSED;
        }

        fixtureOpen() {
          if (this.readyState === FixtureEventSource.CLOSED) return;
          this.readyState = FixtureEventSource.OPEN;
          const event = new Event('open');
          this.onopen?.call(this, event);
          this.dispatchEvent(event);
        }

        fixtureDown() {
          if (this.readyState === FixtureEventSource.CLOSED) return;
          this.readyState = FixtureEventSource.CONNECTING;
          const event = new Event('error');
          this.onerror?.call(this, event);
          this.dispatchEvent(event);
        }

        fixtureEmit(type: string, payload: unknown) {
          if (this.readyState === FixtureEventSource.CLOSED) return;
          const event = new MessageEvent(type, { data: JSON.stringify(payload) });
          if (type === 'message') this.onmessage?.call(this, event);
          this.dispatchEvent(event);
        }
      }

      // Two streams reach the page now — the order stream and the price stream — and they fail
      // independently, so every control names which one it is driving.
      const paths: Record<string, string> = {
        orders: '/bridge/bist/events',
        prices: '/bridge/price/stream',
      };

      const fixtureState = {
        sources: [] as FixtureEventSource[],
        active(kind = 'orders') {
          const path = paths[kind] ?? paths.orders;
          return this.sources.filter(
            (source) =>
              source.readyState !== FixtureEventSource.CLOSED &&
              new URL(source.url).pathname === path,
          );
        },
        activeCount(kind = 'orders') {
          return this.active(kind).length;
        },
        open(lastUpdateTime: number, kind = 'orders') {
          for (const source of this.active(kind)) {
            source.fixtureOpen();
            if (kind === 'orders') source.fixtureEmit('status', { status: '', lastUpdateTime });
          }
        },
        down(kind = 'orders') {
          for (const source of this.active(kind)) source.fixtureDown();
        },
        emit(type: string, payload: unknown, kind = 'orders') {
          for (const source of this.active(kind)) source.fixtureEmit(type, payload);
        },
      };

      Object.defineProperty(window, 'EventSource', {
        configurable: false,
        value: FixtureEventSource,
        writable: false,
      });
      Object.defineProperty(window, '__BOT_VIEWER_FAKE_EVENTS__', {
        configurable: false,
        value: fixtureState,
        writable: false,
      });
    });

    const blockUpstream = async (route: Route) => {
      violations.push(`Blocked direct upstream request: ${route.request().url()}`);
      await route.abort('blockedbyclient');
    };
    await context.route(/https?:\/\/(?:127\.0\.0\.1|localhost):(?:8788|8789)\//, blockUpstream);

    const bridgeRoute = async (route: Route, request: Request) => {
      const url = new URL(request.url());
      let body: unknown = null;
      if (request.postData() !== null) {
        try {
          body = request.postDataJSON() as unknown;
        } catch {
          return reject(
            route,
            violations,
            `${request.method()} ${url.pathname} sent unreadable JSON.`,
          );
        }
      }
      requests.push({ method: request.method(), path: `${url.pathname}${url.search}`, body });

      try {
        if (url.pathname.startsWith('/bridge/bist/rpc/')) {
          if (request.method() !== 'POST') {
            return reject(route, violations, `RPC read used ${request.method()} instead of POST.`);
          }
          const rpcName = decodeURIComponent(url.pathname.slice('/bridge/bist/rpc/'.length));
          if (writeRpcs.has(rpcName)) {
            return reject(route, violations, `Blocked write RPC ${rpcName}.`);
          }
          return fulfillJson(route, rpcPayload(rpcName, body, scenario.bist));
        }

        if (url.pathname === '/bridge/price/status' && request.method() === 'GET') {
          return fulfillJson(route, scenario.price.status);
        }
        if (url.pathname === '/bridge/price/quotes' && request.method() === 'GET') {
          return fulfillJson(route, scenario.price.quotes);
        }
        if (url.pathname === '/bridge/price/bars/closing' && request.method() === 'POST') {
          return fulfillJson(route, scenario.price.closingBars);
        }
        if (url.pathname === '/bridge/price/bars/latest' && request.method() === 'POST') {
          return fulfillJson(route, scenario.price.latestBars);
        }
        if (url.pathname === '/bridge/bist/logs/extents' && request.method() === 'GET') {
          return fulfillJson(route, scenario.logs.extents);
        }
        if (url.pathname === '/bridge/bist/logs/query' && request.method() === 'POST') {
          const source = recordString(body, 'source');
          if (source !== 'errors' && source !== 'wire' && source !== 'api') {
            return reject(route, violations, 'Log query omitted a recognized source.');
          }
          return fulfillJson(route, scenario.logs.results[source]);
        }

        return reject(
          route,
          violations,
          `Unexpected bridge request: ${request.method()} ${url.pathname}${url.search}`,
        );
      } catch (error) {
        return reject(
          route,
          violations,
          error instanceof Error ? error.message : 'Fixture routing failed without an Error.',
        );
      }
    };
    await context.route('**/bridge/**', bridgeRoute);

    const waitForSource = (kind: FakeStreamKind) =>
      page.waitForFunction(
        (streamKind) =>
          ((
            window as typeof window & {
              __BOT_VIEWER_FAKE_EVENTS__?: { activeCount: (kind: string) => number };
            }
          ).__BOT_VIEWER_FAKE_EVENTS__?.activeCount(streamKind) ?? 0) > 0,
        kind,
      );

    await use({
      requests,
      useScenario(nextScenario) {
        scenario = nextScenario;
      },
      stream: {
        async open(lastUpdateTime = FIXTURE_NOW_MS, kind: FakeStreamKind = 'orders') {
          await waitForSource(kind);
          await page.evaluate(
            ({ timestamp, streamKind }) => {
              const controller = (
                window as typeof window & {
                  __BOT_VIEWER_FAKE_EVENTS__: { open: (value: number, kind: string) => void };
                }
              ).__BOT_VIEWER_FAKE_EVENTS__;
              controller.open(timestamp, streamKind);
            },
            { timestamp: lastUpdateTime, streamKind: kind },
          );
        },
        async down(kind: FakeStreamKind = 'orders') {
          await waitForSource(kind);
          await page.evaluate((streamKind) => {
            const controller = (
              window as typeof window & {
                __BOT_VIEWER_FAKE_EVENTS__: { down: (kind: string) => void };
              }
            ).__BOT_VIEWER_FAKE_EVENTS__;
            controller.down(streamKind);
          }, kind);
        },
        async emit(type, payload, kind: FakeStreamKind = 'orders') {
          await waitForSource(kind);
          await page.evaluate(
            ({ eventType, eventPayload, streamKind }) => {
              const controller = (
                window as typeof window & {
                  __BOT_VIEWER_FAKE_EVENTS__: {
                    emit: (name: string, value: unknown, kind: string) => void;
                  };
                }
              ).__BOT_VIEWER_FAKE_EVENTS__;
              controller.emit(eventType, eventPayload, streamKind);
            },
            { eventType: type, eventPayload: payload, streamKind: kind },
          );
        },
      },
    });

    await context.unroute('**/bridge/**', bridgeRoute);
    await context.unroute(/https?:\/\/(?:127\.0\.0\.1|localhost):(?:8788|8789)\//, blockUpstream);
    if (violations.length > 0) {
      throw new Error(`The browser safety boundary was crossed:\n${violations.join('\n')}`);
    }
  },
});

export { expect };

function rpcPayload(name: string, body: unknown, fixture: BistReadFixture): unknown {
  switch (name) {
    case 'GetBots':
      return fixture.bots;
    case 'GetAccounts':
      return fixture.accounts;
    case 'GetActiveOrders':
      assertAllBotsSelector(body, name);
      return fixture.activeOrders;
    case 'GetCanceledOrders':
      assertAllBotsSelector(body, name);
      return fixture.canceledOrders;
    case 'GetPositions':
      assertAllBotsSelector(body, name);
      return fixture.positions;
    case 'GetClosedTrades':
      assertAllBotsSelector(body, name);
      return fixture.closedTrades;
    case 'GetPendingOrderRequests':
      assertAllBotsSelector(body, name);
      return fixture.pendingOrderRequests;
    case 'GetHolidays':
      return fixture.holidays;
    case 'GetErrors':
      return fixture.errors;
    case 'GetBotBudget': {
      const botId = recordString(body, 'botId');
      const budget = fixture.budgets[botId ?? ''];
      if (!botId || !budget) throw new Error(`No fixture budget exists for ${String(botId)}.`);
      return budget;
    }
    default:
      throw new Error(`Unexpected read RPC ${name}.`);
  }
}

function assertAllBotsSelector(body: unknown, rpcName: string): void {
  if (recordString(body, 'botId') !== '*') {
    throw new Error(`${rpcName} did not use the bounded all-bots selector.`);
  }
}

function recordString(value: unknown, key: string): string | null {
  if (typeof value !== 'object' || value === null) return null;
  const candidate = (value as Record<string, unknown>)[key];
  return typeof candidate === 'string' ? candidate : null;
}

async function fulfillJson(route: Route, payload: unknown): Promise<void> {
  await route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify(payload),
    headers: { 'Cache-Control': 'no-store' },
  });
}

async function reject(route: Route, violations: string[], message: string): Promise<void> {
  violations.push(message);
  await route.abort('blockedbyclient');
}
