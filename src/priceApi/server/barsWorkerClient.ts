import path from 'node:path';
import { Worker } from 'node:worker_threads';

import type { AuctionBar, AuctionBarKey, LatestBar } from '../types.ts';

type BarsRow = AuctionBar | LatestBar;

interface WorkerReply {
  id: number;
  result?: BarsRow[];
  error?: string;
}

interface PendingBarsRequest {
  resolve: (rows: BarsRow[]) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

type BarsQuery = { kind: 'closing'; keys: AuctionBarKey[] } | { kind: 'latest'; symbols: string[] };

const REQUEST_TIMEOUT_MS = 12_000;
const MAX_PENDING_REQUESTS = 16;

export class BarsWorkerClient {
  private worker: Worker | null = null;
  private nextId = 0;
  private closing = false;
  private readonly pending = new Map<number, PendingBarsRequest>();

  constructor(private readonly databasePath: string) {
    this.spawnWorker();
  }

  private spawnWorker(): Worker {
    const worker = new Worker(path.resolve(process.cwd(), 'src/priceApi/server/barsWorker.mjs'));
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
        this.rejectEveryRequest(new Error(`Bars worker exited with code ${code}.`));
      }
    });
    return worker;
  }

  query(keys: AuctionBarKey[]): Promise<AuctionBar[]> {
    return this.run({ kind: 'closing', keys }) as Promise<AuctionBar[]>;
  }

  queryLatest(symbols: string[]): Promise<LatestBar[]> {
    return this.run({ kind: 'latest', symbols }) as Promise<LatestBar[]>;
  }

  private run(request: BarsQuery): Promise<BarsRow[]> {
    if (this.closing) return Promise.reject(new Error('The bars worker is not running.'));
    if (this.pending.size >= MAX_PENDING_REQUESTS) {
      return Promise.reject(new Error('The bars worker has too many pending reads.'));
    }
    if (this.nextId >= Number.MAX_SAFE_INTEGER) {
      return Promise.reject(new Error('The bars worker request counter is exhausted.'));
    }
    const id = ++this.nextId;
    const worker = this.worker ?? this.spawnWorker();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('The bounded bars read timed out.'));
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
    this.rejectEveryRequest(new Error('The bars worker is shutting down.'));
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
