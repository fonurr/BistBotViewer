import path from 'node:path';

import type { Plugin, PreviewServer, ViteDevServer } from 'vite';
import { z } from 'zod';

import {
  HttpInputError,
  isTrustedBrowserRequest,
  readJsonBody,
  sendJson,
  type ConnectMiddleware,
} from '../../serverBridge/http.ts';
import { IntentBarsWorkerClient } from './intentBarsWorkerClient.ts';
import { SnapshotScheduler, snapshotDayFor } from './scheduler.ts';

const intentKeysSchema = z.object({
  keys: z
    .array(
      z.object({
        symbol: z.string().regex(/^[A-Z0-9]{1,16}$/),
        ts: z.number().int(),
      }),
    )
    .max(1_000),
});

export interface HistBridgeOptions {
  /** MatriksOrder's store, read only to learn which symbols and sessions matter. */
  orderDatabasePath: string;
  minuteDatabasePath: string;
  scaleDatabasePath: string;
  /** The viewer's own SQLite cache — the only thing a request ever reads. */
  cacheDatabasePath: string;
  fixtureMode?: boolean;
}

function register(server: ViteDevServer | PreviewServer, middleware: ConnectMiddleware): void {
  server.middlewares.use((request, response, next) => {
    Promise.resolve(middleware(request, response, next)).catch(next);
  });
}

/**
 * The history bridge. Unlike the other two boundaries it has no upstream at all:
 * it answers from a SQLite cache this repo builds, and the DuckDB source behind
 * that cache is opened once a night by the scheduler and never on a request.
 * A browser therefore cannot cause `../BistData` to be touched, which is what
 * keeps its pipeline able to write.
 */
export function createHistBridgePlugin(options: HistBridgeOptions): Plugin {
  const cachePath = path.resolve(process.cwd(), options.cacheDatabasePath);
  const testRuntime = Boolean(process.env.VITEST);
  let worker: IntentBarsWorkerClient | null = null;
  let scheduler: SnapshotScheduler | null = null;

  const middleware: ConnectMiddleware = async (request, response, next) => {
    const requestUrl = new URL(request.url ?? '/', `http://${request.headers.host ?? '127.0.0.1'}`);
    if (!requestUrl.pathname.startsWith('/bridge/hist/')) return next();
    if (!isTrustedBrowserRequest(request)) {
      return sendJson(response, 403, {
        error: 'The history bridge is loopback and same-origin only.',
      });
    }
    if (request.method === 'OPTIONS') {
      return sendJson(response, 403, { error: 'Cross-origin preflight is not accepted.' });
    }
    if (options.fixtureMode) {
      return sendJson(response, 503, { error: 'Live history access is disabled for fixtures.' });
    }

    if (requestUrl.pathname === '/bridge/hist/status') {
      if (request.method !== 'GET')
        return sendJson(response, 405, { error: 'Method not allowed.' });
      try {
        if (!worker) throw new Error('The intent bars worker is not running.');
        const stamp = await worker.queryStamp();
        return sendJson(response, 200, {
          available: stamp !== null,
          snapshotFor: stamp?.snapshotFor ?? null,
          builtAt: stamp?.builtAt ?? null,
          barRows: stamp?.barRows ?? null,
          stale: stamp === null || stamp.snapshotFor !== snapshotDayFor(Date.now()),
        });
      } catch {
        // A cache that has never been built is not an error the page must handle:
        // it is the ordinary first-run state, and every intent cell stays empty.
        return sendJson(response, 200, {
          available: false,
          snapshotFor: null,
          builtAt: null,
          barRows: null,
          stale: true,
        });
      }
    }

    if (requestUrl.pathname === '/bridge/hist/bars/intent') {
      if (request.method !== 'POST')
        return sendJson(response, 405, { error: 'Method not allowed.' });
      try {
        const { value } = await readJsonBody(request, 128_000);
        const parsed = intentKeysSchema.safeParse(value);
        if (!parsed.success) throw new HttpInputError(400, 'The intent-bar query is invalid.');
        if (!worker) throw new Error('The intent bars worker is not running.');
        const rows = await worker.queryBars(parsed.data.keys);
        return sendJson(response, 200, rows);
      } catch (error) {
        if (error instanceof HttpInputError)
          return sendJson(response, error.status, { error: error.message });
        // No cache yet, or a bounded read that could not be answered. Either way
        // the page withholds the figure rather than showing a stale one.
        return sendJson(response, 503, {
          error: 'The intent-bar cache could not answer this bounded read.',
          detail: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return sendJson(response, 404, { error: 'History bridge route not found.' });
  };

  const attachClose = (server: ViteDevServer | PreviewServer) => {
    if (options.fixtureMode || testRuntime) return;
    if (!worker) worker = new IntentBarsWorkerClient(cachePath);
    if (!scheduler) {
      const activeWorker = worker;
      scheduler = new SnapshotScheduler({
        orderDbPath: path.resolve(process.cwd(), options.orderDatabasePath),
        minuteDbPath: path.resolve(process.cwd(), options.minuteDatabasePath),
        scaleDbPath: path.resolve(process.cwd(), options.scaleDatabasePath),
        cachePath,
        readSnapshotFor: async () => (await activeWorker.queryStamp())?.snapshotFor ?? null,
      });
      scheduler.start();
    }
    const httpServer = server.httpServer;
    if (httpServer) {
      const activeWorker = worker;
      const activeScheduler = scheduler;
      httpServer.once('close', () => {
        void activeScheduler.stop();
        void activeWorker.close();
      });
    }
  };

  return {
    name: 'bot-viewer-hist-bridge',
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
