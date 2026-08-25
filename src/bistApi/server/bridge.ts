import { randomBytes, timingSafeEqual } from 'node:crypto';
import http, { type IncomingMessage, type ServerResponse } from 'node:http';

import type { Plugin, PreviewServer, ViteDevServer } from 'vite';

import {
  applySecurityHeaders,
  assertLoopbackTarget,
  HttpInputError,
  isTrustedBrowserRequest,
  readCookie,
  readJsonBody,
  sendJson,
  type ConnectMiddleware,
} from '../../serverBridge/http.ts';

const READ_RPCS = new Set([
  'GetBots',
  'GetAccounts',
  'GetBotBudget',
  'GetActiveOrders',
  'GetCanceledOrders',
  'GetPositions',
  'GetClosedTrades',
  'GetPendingOrderRequests',
  'GetErrors',
  'GetHolidays',
]);

const MUTATING_RPCS = new Set([
  'ConfigureBot',
  'SendOrders',
  'EditOrders',
  'CancelOrders',
  'CancelPendingOrderRequests',
  'RefreshData',
]);

const CSRF_COOKIE = 'bist_viewer_csrf';
const CSRF_HEADER = 'x-botviewer-csrf';

export interface BistBridgeOptions {
  upstreamUrl: string;
  fixtureMode?: boolean;
}

function sameSecret(left: string | null, right: string | undefined, expected: string): boolean {
  if (!left || !right) return false;
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  const c = Buffer.from(expected);
  return (
    a.length === b.length && b.length === c.length && timingSafeEqual(a, b) && timingSafeEqual(b, c)
  );
}

function register(server: ViteDevServer | PreviewServer, middleware: ConnectMiddleware): void {
  server.middlewares.use((request, response, next) => {
    Promise.resolve(middleware(request, response, next)).catch(next);
  });
}

export function createBistBridgePlugin(options: BistBridgeOptions): Plugin {
  const upstreamBase = assertLoopbackTarget(options.upstreamUrl, 'BIST_VIEWER_MATRIKS_URL');
  const csrfToken = randomBytes(32).toString('base64url');

  const middleware: ConnectMiddleware = async (request, response, next) => {
    const requestUrl = new URL(request.url ?? '/', `http://${request.headers.host ?? '127.0.0.1'}`);
    if (!requestUrl.pathname.startsWith('/bridge/bist/')) return next();

    if (!isTrustedBrowserRequest(request)) {
      return sendJson(response, 403, {
        type: 'BridgeForbidden',
        information: 'The viewer bridge accepts same-origin loopback requests only.',
      });
    }

    if (request.method === 'OPTIONS') {
      return sendJson(response, 403, {
        type: 'BridgeForbidden',
        information: 'Cross-origin preflight is not accepted.',
      });
    }

    if (requestUrl.pathname === '/bridge/bist/session') {
      if (request.method !== 'GET') return sendJson(response, 405, { type: 'BadRequest' });
      response.setHeader(
        'Set-Cookie',
        `${CSRF_COOKIE}=${encodeURIComponent(csrfToken)}; HttpOnly; SameSite=Strict; Path=/`,
      );
      return sendJson(response, 200, { csrfToken });
    }

    if (options.fixtureMode) {
      return sendJson(response, 503, {
        type: 'FixtureBoundary',
        information: 'Live upstream access is disabled for this fixture server.',
        mayHaveReachedExchange: false,
      });
    }

    if (requestUrl.pathname === '/bridge/bist/events') {
      if (request.method !== 'GET') return sendJson(response, 405, { type: 'BadRequest' });
      return proxyEvents(upstreamBase, request, response);
    }

    const match = /^\/bridge\/bist\/rpc\/([A-Za-z]+)$/.exec(requestUrl.pathname);
    if (!match) return sendJson(response, 404, { type: 'BridgeNotFound' });
    if (request.method !== 'POST') return sendJson(response, 405, { type: 'BadRequest' });

    const rpcName = match[1];
    const isRead = READ_RPCS.has(rpcName);
    const isMutation = MUTATING_RPCS.has(rpcName);
    if (!isRead && !isMutation) {
      return sendJson(response, 404, {
        type: 'BridgeNotFound',
        information: 'That RPC is not exposed by the viewer bridge.',
      });
    }

    if (
      isMutation &&
      !sameSecret(
        readCookie(request, CSRF_COOKIE),
        request.headers[CSRF_HEADER] as string | undefined,
        csrfToken,
      )
    ) {
      return sendJson(response, 403, {
        type: 'BridgeForbidden',
        information: 'The write did not leave the viewer because its session token was missing.',
        mayHaveReachedExchange: false,
      });
    }

    try {
      const { raw } = await readJsonBody(request);
      await proxyRpc(upstreamBase, rpcName, raw, response, isMutation);
    } catch (error) {
      if (error instanceof HttpInputError) {
        return sendJson(response, error.status, {
          type: 'BadRequest',
          information: error.message,
          mayHaveReachedExchange: false,
        });
      }
      throw error;
    }
  };

  return {
    name: 'bot-viewer-bist-bridge',
    configureServer(server) {
      register(server, middleware);
    },
    configurePreviewServer(server) {
      register(server, middleware);
    },
  };
}

async function proxyRpc(
  upstreamBase: URL,
  rpcName: string,
  body: Buffer,
  response: ServerResponse,
  isMutation: boolean,
): Promise<void> {
  const target = new URL(rpcName, upstreamBase);
  await new Promise<void>((resolve) => {
    let settled = false;
    const upstream = http.request(
      target,
      {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          'Content-Length': String(body.length),
        },
      },
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

    upstream.setTimeout(62_000, () => {
      upstream.destroy(new Error('Upstream timeout'));
    });
    upstream.on('error', (error) => {
      if (!settled && !response.headersSent) {
        sendJson(response, 502, {
          type: 'BridgeUnavailable',
          information: isMutation
            ? 'The bridge did not receive a reply. Whether the request reached MatriksOrder is unknown.'
            : 'MatriksOrder did not answer the viewer bridge.',
          mayHaveReachedExchange: isMutation,
          detail: error.message,
        });
      }
      resolve();
    });
    upstream.end(body);
  });
}

async function proxyEvents(
  upstreamBase: URL,
  browserRequest: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const target = new URL('events', upstreamBase);
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
          type: 'BridgeUnavailable',
          information: 'The MatriksOrder event stream is unavailable.',
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
