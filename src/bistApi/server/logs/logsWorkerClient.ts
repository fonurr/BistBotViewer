import path from 'node:path';
import { Worker } from 'node:worker_threads';

import {
  logExtentsSchema,
  logQueryResultSchema,
  logQuerySchema,
  type ApiLogQuery,
  type ApiLogQueryResult,
  type ErrorLogQuery,
  type ErrorLogQueryResult,
  type LogExtents,
  type LogQuery,
  type LogQueryResult,
  type WireLogQuery,
  type WireLogQueryResult,
} from '../../logTypes.ts';

export type LogsWorkerErrorCode = 'INVALID_INPUT' | 'SCHEMA_MISMATCH' | 'UNAVAILABLE';

export class LogsWorkerError extends Error {
  readonly code: LogsWorkerErrorCode;

  constructor(code: LogsWorkerErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'LogsWorkerError';
    this.code = code;
  }
}

export interface LogsDatabasePaths {
  errors: string;
  wire: string;
  api: string;
}

interface WorkerReply {
  id: number;
  result?: unknown;
  error?: {
    code?: unknown;
    message?: unknown;
  };
}

interface PendingRequest<T> {
  parse: (value: unknown) => T;
  resolve: (value: T) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

const REQUEST_TIMEOUT_MS = 12_000;
const MAX_PENDING_REQUESTS = 32;
const WORKER_ERROR_CODES = new Set<LogsWorkerErrorCode>([
  'INVALID_INPUT',
  'SCHEMA_MISMATCH',
  'UNAVAILABLE',
]);

export class LogsWorkerClient {
  private worker: Worker | null = null;
  private nextId = 0;
  private closing = false;
  private readonly pending = new Map<number, PendingRequest<unknown>>();
  private readonly resolvedPaths: LogsDatabasePaths;

  constructor(databasePaths: LogsDatabasePaths) {
    this.resolvedPaths = {
      errors: path.resolve(process.cwd(), databasePaths.errors),
      wire: path.resolve(process.cwd(), databasePaths.wire),
      api: path.resolve(process.cwd(), databasePaths.api),
    };
    this.spawnWorker();
  }

  private spawnWorker(): Worker {
    const worker = new Worker(
      path.resolve(process.cwd(), 'src/bistApi/server/logs/logsWorker.mjs'),
      { workerData: { databasePaths: this.resolvedPaths } },
    );
    this.worker = worker;
    worker.on('message', (reply: WorkerReply) => this.handleReply(reply));
    worker.on('messageerror', (error) => {
      if (this.worker !== worker) return;
      this.worker = null;
      this.rejectEveryRequest(
        new LogsWorkerError('UNAVAILABLE', 'The logs worker returned an unreadable message.', {
          cause: error,
        }),
      );
      void worker.terminate();
    });
    worker.on('error', (error) => {
      if (this.worker !== worker) return;
      this.worker = null;
      this.rejectEveryRequest(
        new LogsWorkerError('UNAVAILABLE', 'The logs worker failed.', {
          cause: error,
        }),
      );
    });
    worker.on('exit', (code) => {
      if (this.worker !== worker) return;
      this.worker = null;
      if (!this.closing || code !== 0) {
        this.rejectEveryRequest(
          new LogsWorkerError('UNAVAILABLE', `The logs worker exited with code ${code}.`),
        );
      }
    });
    return worker;
  }

  query(input: ErrorLogQuery): Promise<ErrorLogQueryResult>;
  query(input: WireLogQuery): Promise<WireLogQueryResult>;
  query(input: ApiLogQuery): Promise<ApiLogQueryResult>;
  query(input: LogQuery): Promise<LogQueryResult>;
  query(input: LogQuery): Promise<LogQueryResult> {
    const query = logQuerySchema.parse(input);
    return this.request({ operation: 'query', query }, (value) => {
      const result = logQueryResultSchema.parse(value);
      if (result.source !== query.source) {
        throw new LogsWorkerError(
          'SCHEMA_MISMATCH',
          'The logs worker returned a result for the wrong source.',
        );
      }
      return result;
    });
  }

  extents(): Promise<LogExtents> {
    return this.request({ operation: 'extents' }, (value) => logExtentsSchema.parse(value));
  }

  async close(): Promise<void> {
    if (this.closing) return;
    this.closing = true;
    const worker = this.worker;
    this.worker = null;
    this.rejectEveryRequest(
      new LogsWorkerError('UNAVAILABLE', 'The logs worker is shutting down.'),
    );
    await worker?.terminate();
  }

  private request<T>(message: Record<string, unknown>, parse: (value: unknown) => T): Promise<T> {
    if (this.closing) {
      return Promise.reject(new LogsWorkerError('UNAVAILABLE', 'The logs worker is not running.'));
    }
    if (this.pending.size >= MAX_PENDING_REQUESTS) {
      return Promise.reject(
        new LogsWorkerError('UNAVAILABLE', 'The logs worker has too many pending reads.'),
      );
    }
    if (this.nextId >= Number.MAX_SAFE_INTEGER) {
      return Promise.reject(
        new LogsWorkerError('UNAVAILABLE', 'The logs worker request counter is exhausted.'),
      );
    }

    const id = ++this.nextId;
    const worker = this.worker ?? this.spawnWorker();
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new LogsWorkerError('UNAVAILABLE', 'The bounded log read timed out.'));
      }, REQUEST_TIMEOUT_MS);

      this.pending.set(id, {
        parse,
        resolve,
        reject,
        timer,
      } as PendingRequest<unknown>);
      try {
        worker.postMessage({ id, ...message });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(
          new LogsWorkerError('UNAVAILABLE', 'The log read could not reach its worker.', {
            cause: error,
          }),
        );
      }
    });
  }

  private handleReply(reply: WorkerReply): void {
    if (!reply || !Number.isSafeInteger(reply.id)) {
      this.rejectEveryRequest(
        new LogsWorkerError('UNAVAILABLE', 'The logs worker returned an invalid envelope.'),
      );
      return;
    }
    const request = this.pending.get(reply.id);
    if (!request) return;
    this.pending.delete(reply.id);
    clearTimeout(request.timer);

    if (reply.error) {
      const rawCode = reply.error.code;
      const code =
        typeof rawCode === 'string' && WORKER_ERROR_CODES.has(rawCode as LogsWorkerErrorCode)
          ? (rawCode as LogsWorkerErrorCode)
          : 'UNAVAILABLE';
      request.reject(
        new LogsWorkerError(
          code,
          typeof reply.error.message === 'string'
            ? reply.error.message
            : 'The log database read failed.',
        ),
      );
      return;
    }

    try {
      request.resolve(request.parse(reply.result));
    } catch (error) {
      request.reject(
        error instanceof LogsWorkerError
          ? error
          : new LogsWorkerError(
              'SCHEMA_MISMATCH',
              'The logs worker returned a result that does not match the viewer contract.',
              { cause: error },
            ),
      );
    }
  }

  private rejectEveryRequest(error: Error): void {
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    this.pending.clear();
  }
}
