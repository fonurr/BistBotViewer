import http, { type ServerResponse } from 'node:http';
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
      const rawSymbols = requestUrl.searchParams.get('symbols');
      if (!rawSymbols)
        return sendJson(response, 400, { error: 'A non-empty symbols list is required.' });
      const symbols = [
        ...new Set(rawSymbols.split(',').map((value) => value.trim().toUpperCase())),
      ];
      if (
        symbols.length === 0 ||
        symbols.length > 700 ||
        symbols.some((symbol) => !/^[A-Z0-9]{1,16}$/.test(symbol))
      ) {
        return sendJson(response, 400, { error: 'The symbols list is invalid or too large.' });
      }
      const target = new URL('quotes', upstreamBase);
      target.searchParams.set('symbols', symbols.join(','));
      return proxyGet(target, response);
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
