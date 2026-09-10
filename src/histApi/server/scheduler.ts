import path from 'node:path';
import { Worker } from 'node:worker_threads';

/** Turkey has been on permanent UTC+3 since 2016, so a fixed offset is exact here. */
const ISTANBUL_OFFSET_MS = 3 * 60 * 60 * 1000;
/** The nightly pull is aimed at 23:00 Istanbul. */
const SNAPSHOT_HOUR = 23;
/** A failed night keeps retrying until 18:00 the next evening, then waits for 23:00. */
const RETRY_UNTIL_HOUR = 18;
const TICK_MS = 10 * 60 * 1000;
const RETRY_COOLDOWN_MS = 60 * 60 * 1000;
/** A pull of a few hundred thousand rows takes seconds; well past that is a stuck lock. */
const RUN_TIMEOUT_MS = 10 * 60 * 1000;

export interface SnapshotSchedulerOptions {
  orderDbPath: string;
  minuteDbPath: string;
  scaleDbPath: string;
  cachePath: string;
  /** What the cache says it already holds, so a fresh snapshot day is not rebuilt. */
  readSnapshotFor: () => Promise<string | null>;
}

function istanbulParts(now: number): { day: string; hour: number } {
  const shifted = new Date(now + ISTANBUL_OFFSET_MS);
  return { day: shifted.toISOString().slice(0, 10), hour: shifted.getUTCHours() };
}

function previousDay(day: string): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
}

/**
 * The snapshot day a moment belongs to, named by the date of the 23:00 boundary
 * that opened it. Before 23:00 the current window is still yesterday's.
 */
export function snapshotDayFor(now: number): string {
  const { day, hour } = istanbulParts(now);
  return hour >= SNAPSHOT_HOUR ? day : previousDay(day);
}

/**
 * The window in which a snapshot day may still be built: from its 23:00 boundary
 * until 18:00 the following evening. Outside it the viewer waits rather than
 * reaching for DuckDB, which is the whole point of the once-a-night contract.
 */
export function isInsideWindow(now: number): boolean {
  const { hour } = istanbulParts(now);
  return hour >= SNAPSHOT_HOUR || hour < RETRY_UNTIL_HOUR;
}

/**
 * Opens DuckDB at most once per snapshot day, in a worker thread that is
 * terminated as soon as it answers — the native addon is unloaded with the
 * thread, so the viewer cannot hold `../BistData`'s cross-process lock and stall
 * its pipeline. A failed attempt keeps yesterday's cache and retries next hour.
 */
export class SnapshotScheduler {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private stopped = false;
  private lastFailureAt = 0;

  constructor(private readonly options: SnapshotSchedulerOptions) {}

  start(): void {
    if (this.timer || this.stopped) return;
    // A machine that was asleep at 23:00 still catches up on the next start.
    void this.tick();
    this.timer = setInterval(() => void this.tick(), TICK_MS);
    this.timer.unref?.();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private async tick(now = Date.now()): Promise<void> {
    if (this.running || this.stopped) return;
    if (!isInsideWindow(now)) return;
    if (this.lastFailureAt > 0 && now - this.lastFailureAt < RETRY_COOLDOWN_MS) return;

    const wanted = snapshotDayFor(now);
    let held: string | null = null;
    try {
      held = await this.options.readSnapshotFor();
    } catch {
      // No readable cache at all is exactly the case a first run is for.
      held = null;
    }
    if (held === wanted) return;

    this.running = true;
    try {
      const result = await this.runOnce(wanted);
      this.lastFailureAt = 0;
      console.info(
        `[hist] intent-bar snapshot for ${wanted}: ${result.barRows} bars over ${result.symbols} symbols.`,
      );
    } catch (error) {
      this.lastFailureAt = now;
      // A locked DuckDB is the expected failure — BistData's own sync was running.
      // The previous cache stays in place and the next hourly tick tries again.
      console.warn(
        `[hist] intent-bar snapshot for ${wanted} failed, keeping the previous cache: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    } finally {
      this.running = false;
    }
  }

  private runOnce(snapshotFor: string): Promise<{ barRows: number; symbols: number }> {
    return new Promise((resolve, reject) => {
      const worker = new Worker(
        path.resolve(process.cwd(), 'src/histApi/server/snapshotWorker.mjs'),
        {
          workerData: {
            orderDbPath: this.options.orderDbPath,
            minuteDbPath: this.options.minuteDbPath,
            scaleDbPath: this.options.scaleDbPath,
            cachePath: this.options.cachePath,
            snapshotFor,
          },
        },
      );
      let settled = false;
      const finish = (run: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        void worker.terminate();
        run();
      };
      const timer = setTimeout(
        () => finish(() => reject(new Error('The snapshot run timed out.'))),
        RUN_TIMEOUT_MS,
      );
      timer.unref?.();
      worker.on('message', (message: { ok: boolean; result?: unknown; error?: string }) => {
        if (message.ok) {
          finish(() => resolve(message.result as { barRows: number; symbols: number }));
        } else {
          finish(() => reject(new Error(message.error ?? 'The snapshot run failed.')));
        }
      });
      worker.on('error', (error) => finish(() => reject(error)));
      worker.on('exit', (code) =>
        finish(() => reject(new Error(`The snapshot worker exited with code ${code}.`))),
      );
    });
  }
}
