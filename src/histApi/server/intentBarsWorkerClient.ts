import path from 'node:path';
import { Worker } from 'node:worker_threads';

import type { IntentBar, IntentBarKey } from '../types.ts';

/** The `meta` row, as the worker hands it back. `stale` is decided by the bridge, not here. */
export interface CacheStamp {
  snapshotFor: string | null;
  builtAt: number | null;
  barRows: number | null;
}

type IntentRow = IntentBar | CacheStamp;

interface WorkerReply {
  id: number;
  result?: IntentRow[];
  error?: string;
}

interface PendingRequest {
  resolve: (rows: IntentRow[]) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

type IntentQuery = { kind: 'bars'; keys: IntentBarKey[] } | { kind: 'status' };

const REQUEST_TIMEOUT_MS = 12_000;
const MAX_PENDING_REQUESTS = 16;

/**
 * The same shape as `priceApi`'s `BarsWorkerClient`: one worker thread, bounded
 * pending reads, and a timeout on every one of them. The worker opens and closes
 * the cache per request, so this client owning a long-lived thread never holds a
 * database handle open.
 */
export class IntentBarsWorkerClient {
  private worker: Worker | null = null;
  private nextId = 0;
  private closing = false;
  private readonly pending = new Map<number, PendingRequest>();

  constructor(private readonly databasePath: string) {
    this.spawnWorker();
  }

  private spawnWorker(): Worker {
    const worker = new Worker(
      path.resolve(process.cwd(), 'src/histApi/server/intentBarsWorker.mjs'),
    );
    this.worker = worker;
    worker.on('message', (reply: WorkerReply) => {
      const request = this.pending.get(reply.id);
      if (!request) return;
      this.pending.delete(reply.id);
      clearTimeout(request.timer);
      if (reply.error) request.reject(new Error(reply.error));
      else request.resolve(reply.result ?? []);
    });
    worker.on('error', (error) => {
      if (this.worker !== worker) return;
      this.worker = null;
      this.rejectEveryRequest(error);
    });
    worker.on('exit', (code) => {
      if (this.worker !== worker) return;
      this.worker = null;
      if (!this.closing || code !== 0) {
        this.rejectEveryRequest(new Error(`Intent bars worker exited with code ${code}.`));
      }
    });
    return worker;
  }

  queryBars(keys: IntentBarKey[]): Promise<IntentBar[]> {
    return this.run({ kind: 'bars', keys }) as Promise<IntentBar[]>;
  }

  /** Null when the cache has never been built — the bridge reports that as unavailable. */
  async queryStamp(): Promise<CacheStamp | null> {
    const rows = (await this.run({ kind: 'status' })) as CacheStamp[];
    return rows[0] ?? null;
  }

  private run(request: IntentQuery): Promise<IntentRow[]> {
    if (this.closing) return Promise.reject(new Error('The intent bars worker is not running.'));
    if (this.pending.size >= MAX_PENDING_REQUESTS) {
      return Promise.reject(new Error('The intent bars worker has too many pending reads.'));
    }
    if (this.nextId >= Number.MAX_SAFE_INTEGER) {
      return Promise.reject(new Error('The intent bars worker request counter is exhausted.'));
    }
    const id = ++this.nextId;
    const worker = this.worker ?? this.spawnWorker();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('The bounded intent bars read timed out.'));
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
      try {
        worker.postMessage({ id, databasePath: this.databasePath, ...request });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  async close(): Promise<void> {
    if (this.closing) return;
    this.closing = true;
    const worker = this.worker;
    this.worker = null;
    this.rejectEveryRequest(new Error('The intent bars worker is shutting down.'));
    await worker?.terminate();
  }

  private rejectEveryRequest(error: Error): void {
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    this.pending.clear();
  }
}
