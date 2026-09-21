import { mkdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { BarsWorkerClient } from './barsWorkerClient';

let fixtureDirectory: string;
let databasePath: string;
let availabilityDatabasePath: string;

beforeAll(async () => {
  fixtureDirectory = path.join(os.tmpdir(), `bist-bot-viewer-bars-${process.pid}-${Date.now()}`);
  await mkdir(fixtureDirectory, { recursive: true });
  databasePath = path.join(fixtureDirectory, 'bars.db');
  availabilityDatabasePath = path.join(fixtureDirectory, 'availability.db');
  const database = new DatabaseSync(databasePath);
  try {
    database.exec(`
      CREATE TABLE bars (
        symbol TEXT NOT NULL,
        session_date TEXT NOT NULL,
        close REAL NOT NULL,
        volume REAL NOT NULL,
        bar_ts INTEGER NOT NULL,
        bar_type TEXT NOT NULL
      );
      INSERT INTO bars VALUES ('THYAO', '2026-08-25', 305.5, 1000, 1777100000000, 'CLOSING_AUCTION');
      INSERT INTO bars VALUES ('THYAO', '2026-08-26', 309.0, 400, 1777180000000, 'NORMAL');
      -- Written at 09:44 with yesterday's close, and stamped later than every real bar here, so a
      -- query that forgets to exclude it silently reports a synthetic price as the latest one.
      INSERT INTO bars VALUES ('THYAO', '2026-08-26', 310.0, 0, 1777190000000, 'PREV_CLOSE');
      INSERT INTO bars VALUES ('GARAN', '2026-08-25', 88.4, 900, 1777100000000, 'CLOSING_AUCTION');
      INSERT INTO bars VALUES ('AKBNK', '2026-08-25', 42.0, 300, 950, 'NORMAL');
      INSERT INTO bars VALUES ('ISCTR', '2026-08-25', 12.0, 200, 800, 'NORMAL');
      CREATE TABLE session_meta (
        session_date TEXT NOT NULL,
        is_trading_day INTEGER NOT NULL,
        normal_end_ts INTEGER
      );
      INSERT INTO session_meta VALUES ('2026-08-25', 1, 1000);
    `);
  } finally {
    database.close();
  }
  const availability = new DatabaseSync(availabilityDatabasePath);
  try {
    availability.exec(`
      CREATE TABLE outages (
        session_date TEXT NOT NULL,
        start_ts REAL NOT NULL,
        end_ts REAL,
        last_observed_ts REAL NOT NULL
      );
      INSERT INTO outages VALUES ('2026-08-25', 850, 900, 900);
    `);
  } finally {
    availability.close();
  }
});

afterAll(async () => {
  await rm(fixtureDirectory, { recursive: true, force: true });
});

describe('BarsWorkerClient', () => {
  it('recovers on the next bounded read after an unexpected worker exit', async () => {
    const client = new BarsWorkerClient(databasePath);
    const key = [{ symbol: 'THYAO', sessionDate: '2026-08-25' }];
    try {
      await expect(client.query(key)).resolves.toHaveLength(1);
      const worker = Reflect.get(client, 'worker') as { terminate: () => Promise<number> } | null;
      if (!worker) throw new Error('The bars worker did not start.');
      await worker.terminate();
      await expect(client.query(key)).resolves.toEqual([
        {
          symbol: 'THYAO',
          sessionDate: '2026-08-25',
          close: 305.5,
          volume: 1000,
          barTs: 1777100000000,
        },
      ]);
    } finally {
      await client.close();
    }
  });

  it('reads the newest real bar per symbol and never the PREV_CLOSE sentinel', async () => {
    const client = new BarsWorkerClient(databasePath);
    try {
      await expect(client.queryLatest(['THYAO', 'GARAN'])).resolves.toEqual([
        {
          symbol: 'THYAO',
          sessionDate: '2026-08-26',
          close: 309.0,
          barTs: 1777180000000,
          barType: 'NORMAL',
        },
        {
          symbol: 'GARAN',
          sessionDate: '2026-08-25',
          close: 88.4,
          barTs: 1777100000000,
          barType: 'CLOSING_AUCTION',
        },
      ]);
    } finally {
      await client.close();
    }
  });

  it('leaves a symbol out rather than inventing a price for it', async () => {
    const client = new BarsWorkerClient(databasePath);
    try {
      await expect(client.queryLatest(['NOSUCH'])).resolves.toEqual([]);
    } finally {
      await client.close();
    }
  });

  it('uses the adjusted PREV_CLOSE, then the auction, then a verified final bar', async () => {
    const client = new BarsWorkerClient(databasePath, availabilityDatabasePath);
    try {
      await expect(
        client.queryDailyBases([
          {
            symbol: 'THYAO',
            prevCloseSessionDate: '2026-08-26',
            fallbackSessionDate: '2026-08-25',
          },
          {
            symbol: 'GARAN',
            prevCloseSessionDate: '2026-08-26',
            fallbackSessionDate: '2026-08-25',
          },
          {
            symbol: 'AKBNK',
            prevCloseSessionDate: '2026-08-26',
            fallbackSessionDate: '2026-08-25',
          },
          {
            symbol: 'ISCTR',
            prevCloseSessionDate: '2026-08-26',
            fallbackSessionDate: '2026-08-25',
          },
        ]),
      ).resolves.toEqual([
        { symbol: 'THYAO', close: 310, source: 'prev-close' },
        { symbol: 'GARAN', close: 88.4, source: 'closing-auction' },
        { symbol: 'AKBNK', close: 42, source: 'last-bar' },
      ]);
    } finally {
      await client.close();
    }
  });
});
