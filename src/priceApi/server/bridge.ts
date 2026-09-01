import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import path from 'node:path';

import type { Plugin, PreviewServer, ViteDevServer } from 'vite';
import { z } from 'zod';

import {
  applySecurityHeaders,
  assertLoopbackTarget,
  HttpInputError,
  isTrustedBrowserRequest,
  readJsonBody,
  sendJson,
  type ConnectMiddleware,
} from '../../serverBridge/http.ts';
import { BarsWorkerClient } from './barsWorkerClient.ts';

const barKeysSchema = z.object({
  keys: z
    .array(
      z.object({
        symbol: z.string().regex(/^[A-Z0-9]{1,16}$/),
        sessionDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      }),
    )
    .max(1_000),
});

const SYMBOL_PATTERN = /^[A-Z0-9]{1,16}$/;
/** Upstream refuses a stream over this many symbols and applies no part of the change. */
const MAX_STREAM_SYMBOLS = 200;
/** `/quotes` takes a far larger list than one stream may carry. */
const MAX_QUOTE_SYMBOLS = 700;

const latestBarsSchema = z.object({
  symbols: z.array(z.string().regex(SYMBOL_PATTERN)).min(1).max(MAX_STREAM_SYMBOLS),
});

/**
 * The symbols of a bounded request, or null when the list is unusable. An empty list is always
 * unusable here: upstream reads a missing `symbols` as every symbol on `/quotes` and as none on
 * `/stream`, and neither is what an empty request meant.
 */
function boundedSymbols(raw: string | null, limit: number): string[] | null {
  if (!raw) return null;
  const symbols = [...new Set(raw.split(',').map((value) => value.trim().toUpperCase()))];
  if (symbols.length === 0 || symbols.length > limit) return null;
  if (symbols.some((symbol) => !SYMBOL_PATTERN.test(symbol))) return null;
  return symbols;
}

export interface PriceBridgeOptions {
  upstreamUrl: string;
  barsDatabasePath: string;
  fixtureMode?: boolean;
}

function register(server: ViteDevServer | PreviewServer, middleware: ConnectMiddleware): void {
  server.middlewares.use((request, response, next) => {
    Promise.resolve(middleware(request, response, next)).catch(next);
  });
}

export function createPriceBridgePlugin(options: PriceBridgeOptions): Plugin {
  const upstreamBase = assertLoopbackTarget(options.upstreamUrl, 'BIST_VIEWER_PRICE_URL');
  const databasePath = path.resolve(process.cwd(), options.barsDatabasePath);
  const testRuntime = Boolean(process.env.VITEST);
  let barsWorker: BarsWorkerClient | null = null;

  const middleware: ConnectMiddleware = async (request, response, next) => {
    const requestUrl = new URL(request.url ?? '/', `http://${request.headers.host ?? '127.0.0.1'}`);
    if (!requestUrl.pathname.startsWith('/bridge/price/')) return next();
    if (!isTrustedBrowserRequest(request)) {
      return sendJson(response, 403, {
        error: 'The price bridge is loopback and same-origin only.',
      });
    }
    if (request.method === 'OPTIONS') {
      return sendJson(response, 403, { error: 'Cross-origin preflight is not accepted.' });
    }
    if (options.fixtureMode) {
      return sendJson(response, 503, { error: 'Live upstream access is disabled for fixtures.' });
    }

    if (requestUrl.pathname === '/bridge/price/status') {
      if (request.method !== 'GET')
        return sendJson(response, 405, { error: 'Method not allowed.' });
      return proxyGet(new URL('status', upstreamBase), response);
    }

    if (requestUrl.pathname === '/bridge/price/quotes') {
      if (request.method !== 'GET')
        return sendJson(response, 405, { error: 'Method not allowed.' });
      const symbols = boundedSymbols(requestUrl.searchParams.get('symbols'), MAX_QUOTE_SYMBOLS);
      if (!symbols) {
        return sendJson(response, 400, { error: 'The symbols list is invalid or too large.' });
      }
      const target = new URL('quotes', upstreamBase);
      target.searchParams.set('symbols', symbols.join(','));
      return proxyGet(target, response);
    }

    if (requestUrl.pathname === '/bridge/price/stream') {
      if (request.method !== 'GET')
        return sendJson(response, 405, { error: 'Method not allowed.' });
      const symbols = boundedSymbols(requestUrl.searchParams.get('symbols'), MAX_STREAM_SYMBOLS);
      if (!symbols) {
        return sendJson(response, 400, { error: 'The symbols list is invalid or too large.' });
      }
      const target = new URL('stream', upstreamBase);
      target.searchParams.set('symbols', symbols.join(','));
      return proxyEvents(target, request, response);
    }

    if (requestUrl.pathname === '/bridge/price/bars/latest') {
      if (request.method !== 'POST')
        return sendJson(response, 405, { error: 'Method not allowed.' });
      try {
        const { value } = await readJsonBody(request, 32_000);
        const parsed = latestBarsSchema.safeParse(value);
        if (!parsed.success) throw new HttpInputError(400, 'The latest-bar query is invalid.');
        if (!barsWorker) throw new Error('The bars worker is not running.');
        const rows = await barsWorker.queryLatest([...new Set(parsed.data.symbols)]);
        return sendJson(response, 200, rows);
      } catch (error) {
        if (error instanceof HttpInputError)
          return sendJson(response, error.status, { error: error.message });
        return sendJson(response, 503, {
          error: 'bars.db could not answer this bounded read.',
          detail: error instanceof Error ? error.message : String(error),
        });
      }
    }

    if (requestUrl.pathname === '/bridge/price/bars/closing') {
      if (request.method !== 'POST')
        return sendJson(response, 405, { error: 'Method not allowed.' });
      try {
        const { value } = await readJsonBody(request, 128_000);
        const parsed = barKeysSchema.safeParse(value);
        if (!parsed.success) throw new HttpInputError(400, 'The auction-bar query is invalid.');
        if (!barsWorker) throw new Error('The bars worker is not running.');
        const rows = await barsWorker.query(parsed.data.keys);
        return sendJson(response, 200, rows);
      } catch (error) {
        if (error instanceof HttpInputError)
          return sendJson(response, error.status, { error: error.message });
        return sendJson(response, 503, {
          error: 'bars.db could not answer this bounded read.',
          detail: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return sendJson(response, 404, { error: 'Price bridge route not found.' });
  };

  const attachClose = (server: ViteDevServer | PreviewServer) => {
    if (!options.fixtureMode && !testRuntime && !barsWorker) {
      barsWorker = new BarsWorkerClient(databasePath);
    }
    const httpServer = server.httpServer;
    if (httpServer && barsWorker) {
      const activeWorker = barsWorker;
      httpServer.once('close', () => void activeWorker.close());
    }
  };

  return {
    name: 'bot-viewer-price-bridge',
    configureServer(server) {
      register(server, middleware);
      attachClose(server);
    },
    configurePreviewServer(server) {
      register(server, middleware);
      attachClose(server);
    },
  };
}

/**
 * `proxyGet` cannot carry a stream: its 2.5 s timeout would cut the connection and it buffers until
 * `end`. This is the order bridge's own event proxy — headers flushed at once, no upstream timeout,
 * and the upstream socket destroyed the moment the browser goes away so no subscription leaks.
 */
async function proxyEvents(
  target: URL,
  browserRequest: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  await new Promise<void>((resolve) => {
    const upstream = http.get(
      target,
      { headers: { Accept: 'text/event-stream' } },
      (upstreamResponse) => {
        applySecurityHeaders(response);
        response.statusCode = upstreamResponse.statusCode ?? 502;
        response.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
        response.setHeader('Cache-Control', 'no-cache, no-transform');
        response.setHeader('Connection', 'keep-alive');
        response.setHeader('X-Accel-Buffering', 'no');
        response.flushHeaders();
        upstreamResponse.pipe(response);
        upstreamResponse.on('end', resolve);
      },
    );
    upstream.setTimeout(0);
    upstream.on('error', (error) => {
      if (!response.headersSent) {
        sendJson(response, 502, {
          error: 'The DailyDataAggregator price stream is unavailable.',
          detail: error.message,
        });
      } else {
        response.end();
      }
      resolve();
    });
    browserRequest.on('close', () => {
      upstream.destroy();
      resolve();
    });
  });
}

async function proxyGet(target: URL, response: ServerResponse): Promise<void> {
  await new Promise<void>((resolve) => {
    let settled = false;
    const upstream = http.get(
      target,
      { headers: { Accept: 'application/json' } },
      (upstreamResponse) => {
        settled = true;
        applySecurityHeaders(response);
        response.statusCode = upstreamResponse.statusCode ?? 502;
        const contentType = upstreamResponse.headers['content-type'];
        if (contentType) response.setHeader('Content-Type', contentType);
        upstreamResponse.pipe(response);
        upstreamResponse.on('end', resolve);
      },
    );
    upstream.setTimeout(2_500, () => upstream.destroy(new Error('Upstream timeout')));
    upstream.on('error', (error) => {
      if (!settled && !response.headersSent) {
        sendJson(response, 502, {
          error: 'DailyDataAggregator did not answer the viewer bridge.',
          detail: error.message,
        });
      }
      resolve();
    });
  });
}
