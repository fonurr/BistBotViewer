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

interface FakeStreamController {
  open: (lastUpdateTime?: number) => Promise<void>;
  down: () => Promise<void>;
  emit: (type: string, payload: unknown) => Promise<void>;
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

      const fixtureState = {
        sources: [] as FixtureEventSource[],
        active() {
          return this.sources.filter((source) => source.readyState !== FixtureEventSource.CLOSED);
        },
        activeCount() {
          return this.active().length;
        },
        open(lastUpdateTime: number) {
          for (const source of this.active()) {
            source.fixtureOpen();
            source.fixtureEmit('status', { status: '', lastUpdateTime });
          }
        },
        down() {
          for (const source of this.active()) source.fixtureDown();
        },
        emit(type: string, payload: unknown) {
          for (const source of this.active()) source.fixtureEmit(type, payload);
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

    const waitForSource = () =>
      page.waitForFunction(
        () =>
          ((
            window as typeof window & {
              __BOT_VIEWER_FAKE_EVENTS__?: { activeCount: () => number };
            }
          ).__BOT_VIEWER_FAKE_EVENTS__?.activeCount() ?? 0) > 0,
      );

    await use({
      requests,
      useScenario(nextScenario) {
        scenario = nextScenario;
      },
      stream: {
        async open(lastUpdateTime = FIXTURE_NOW_MS) {
          await waitForSource();
          await page.evaluate((timestamp) => {
            const controller = (
              window as typeof window & {
                __BOT_VIEWER_FAKE_EVENTS__: { open: (value: number) => void };
              }
            ).__BOT_VIEWER_FAKE_EVENTS__;
            controller.open(timestamp);
          }, lastUpdateTime);
        },
        async down() {
          await waitForSource();
          await page.evaluate(() => {
            const controller = (
              window as typeof window & {
                __BOT_VIEWER_FAKE_EVENTS__: { down: () => void };
              }
            ).__BOT_VIEWER_FAKE_EVENTS__;
            controller.down();
          });
        },
        async emit(type, payload) {
          await waitForSource();
          await page.evaluate(
            ({ eventType, eventPayload }) => {
              const controller = (
                window as typeof window & {
                  __BOT_VIEWER_FAKE_EVENTS__: {
                    emit: (name: string, value: unknown) => void;
                  };
                }
              ).__BOT_VIEWER_FAKE_EVENTS__;
              controller.emit(eventType, eventPayload);
            },
            { eventType: type, eventPayload: payload },
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
