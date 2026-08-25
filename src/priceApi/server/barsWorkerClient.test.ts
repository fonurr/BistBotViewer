import { mkdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { BarsWorkerClient } from './barsWorkerClient';

let fixtureDirectory: string;
let databasePath: string;

beforeAll(async () => {
  fixtureDirectory = path.join(os.tmpdir(), `bist-bot-viewer-bars-${process.pid}-${Date.now()}`);
  await mkdir(fixtureDirectory, { recursive: true });
  databasePath = path.join(fixtureDirectory, 'bars.db');
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
    `);
  } finally {
    database.close();
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
});
