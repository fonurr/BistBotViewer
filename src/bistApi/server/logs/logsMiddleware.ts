import type { Plugin, PreviewServer, ViteDevServer } from 'vite';

import {
  HttpInputError,
  isTrustedBrowserRequest,
  readJsonBody,
  sendJson,
  type ConnectMiddleware,
} from '../../../serverBridge/http.ts';
import { logQuerySchema } from '../../logTypes.ts';
import { LogsWorkerClient, LogsWorkerError, type LogsDatabasePaths } from './logsWorkerClient.ts';

export interface LogsBridgeOptions extends LogsDatabasePaths {
  fixtureMode?: boolean;
}

export interface LogsMiddlewareBoundary {
  middleware: ConnectMiddleware;
  close: () => Promise<void>;
}

const prefix = '/bridge/bist/logs/';

function errorEnvelope(type: string, information: string): Record<string, unknown> {
  return { type, information, mayHaveReachedExchange: false };
}

function register(server: ViteDevServer | PreviewServer, middleware: ConnectMiddleware): void {
  server.middlewares.use((request, response, next) => {
    Promise.resolve(middleware(request, response, next)).catch(next);
  });
}

export function createLogsMiddleware(options: LogsBridgeOptions): LogsMiddlewareBoundary {
  // Build/config loading does not start a filesystem worker. The first matching request does,
  // while fixture mode never creates one at all.
  let worker: LogsWorkerClient | null = null;
  const getWorker = (): LogsWorkerClient | null => {
    if (options.fixtureMode) return null;
    worker ??= new LogsWorkerClient({
      errors: options.errors,
      wire: options.wire,
      api: options.api,
    });
    return worker;
  };

  const middleware: ConnectMiddleware = async (request, response, next) => {
    const requestUrl = new URL(request.url ?? '/', `http://${request.headers.host ?? '127.0.0.1'}`);
    if (!requestUrl.pathname.startsWith(prefix)) return next();

    if (!isTrustedBrowserRequest(request)) {
      return sendJson(
        response,
        403,
        errorEnvelope(
          'BridgeForbidden',
          'The log bridge accepts same-origin loopback requests only.',
        ),
      );
    }
    if (request.method === 'OPTIONS') {
      return sendJson(
        response,
        403,
        errorEnvelope('BridgeForbidden', 'Cross-origin preflight is not accepted.'),
      );
    }
    if (requestUrl.search !== '') {
      return sendJson(
        response,
        400,
        errorEnvelope('BadRequest', 'Log routes do not accept query-string parameters.'),
      );
    }
    const activeWorker = getWorker();
    if (!activeWorker) {
      return sendJson(
        response,
        503,
        errorEnvelope(
          'FixtureBoundary',
          'Live log database access is disabled for this fixture server.',
        ),
      );
    }

    try {
      if (requestUrl.pathname === `${prefix}extents`) {
        if (request.method !== 'GET') {
          return sendJson(
            response,
            405,
            errorEnvelope('BadRequest', 'The log extents route only accepts GET.'),
          );
        }
        return sendJson(response, 200, await activeWorker.extents());
      }

      if (requestUrl.pathname === `${prefix}query`) {
        if (request.method !== 'POST') {
          return sendJson(
            response,
            405,
            errorEnvelope('BadRequest', 'The log query route only accepts POST.'),
          );
        }
        const { value } = await readJsonBody(request, 16_384);
        const parsed = logQuerySchema.safeParse(value);
        if (!parsed.success) {
          throw new HttpInputError(400, 'The bounded log query is invalid.');
        }
        return sendJson(response, 200, await activeWorker.query(parsed.data));
      }

      return sendJson(
        response,
        404,
        errorEnvelope('BridgeNotFound', 'That log bridge route does not exist.'),
      );
    } catch (error) {
      if (error instanceof HttpInputError) {
        return sendJson(response, error.status, errorEnvelope('BadRequest', error.message));
      }
      if (error instanceof LogsWorkerError && error.code === 'INVALID_INPUT') {
        return sendJson(
          response,
          400,
          errorEnvelope('BadRequest', 'The bounded log query is invalid.'),
        );
      }
      if (error instanceof LogsWorkerError && error.code === 'SCHEMA_MISMATCH') {
        return sendJson(
          response,
          503,
          errorEnvelope(
            'LogDatabaseSchemaMismatch',
            'The selected log database does not match the viewer contract.',
          ),
        );
      }
      return sendJson(
        response,
        503,
        errorEnvelope(
          'LogDatabaseUnavailable',
          'The selected log database could not answer this bounded read.',
        ),
      );
    }
  };

  return {
    middleware,
    close: async () => {
      await worker?.close();
    },
  };
}

export function createLogsBridgePlugin(options: LogsBridgeOptions): Plugin {
  const boundary = createLogsMiddleware(options);

  const attachClose = (server: ViteDevServer | PreviewServer): void => {
    server.httpServer?.once('close', () => void boundary.close());
  };

  return {
    name: 'bot-viewer-logs-bridge',
    configureServer(server) {
      register(server, boundary.middleware);
      attachClose(server);
    },
    configurePreviewServer(server) {
      register(server, boundary.middleware);
      attachClose(server);
    },
    closeBundle() {
      return boundary.close();
    },
  };
}
