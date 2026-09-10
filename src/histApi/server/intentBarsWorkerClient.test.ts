import { mkdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { IntentBarsWorkerClient } from './intentBarsWorkerClient';

let fixtureDirectory: string;
let databasePath: string;

const TEN_OCLOCK = Date.parse('2026-08-25T10:00:00+03:00');

beforeAll(async () => {
  fixtureDirectory = path.join(os.tmpdir(), `bist-bot-viewer-intent-${process.pid}-${Date.now()}`);
  await mkdir(fixtureDirectory, { recursive: true });
  databasePath = path.join(fixtureDirectory, 'intent-bars.db');
  const database = new DatabaseSync(databasePath);
  try {
    database.exec(`
      CREATE TABLE intent_bar (
        symbol TEXT NOT NULL, session_date TEXT NOT NULL, ts INTEGER NOT NULL,
        open REAL NOT NULL, close REAL NOT NULL, is_auction INTEGER NOT NULL,
        PRIMARY KEY (symbol, ts)
      );
      CREATE TABLE meta (
        schema_version INTEGER NOT NULL, snapshot_for TEXT NOT NULL,
        built_at INTEGER NOT NULL, bar_rows INTEGER NOT NULL
      );
      INSERT INTO intent_bar VALUES ('THYAO', '2026-08-25', ${TEN_OCLOCK}, 300.0, 300.5, 0);
      INSERT INTO intent_bar VALUES ('THYAO', '2026-08-25', ${TEN_OCLOCK - 60_000}, 299.0, 299.5, 1);
      INSERT INTO meta VALUES (1, '2026-08-24', 1777000000000, 2);
    `);
  } finally {
    database.close();
  }
});

afterAll(async () => {
  await rm(fixtureDirectory, { recursive: true, force: true });
});

describe('IntentBarsWorkerClient', () => {
  it('answers a bounded point read and marks an auction print as one', async () => {
    const client = new IntentBarsWorkerClient(databasePath);
    try {
      await expect(
        client.queryBars([
          { symbol: 'THYAO', ts: TEN_OCLOCK },
          { symbol: 'THYAO', ts: TEN_OCLOCK - 60_000 },
        ]),
      ).resolves.toEqual([
        {
          symbol: 'THYAO',
          sessionDate: '2026-08-25',
          ts: TEN_OCLOCK,
          open: 300.0,
          close: 300.5,
          isAuction: false,
        },
        {
          symbol: 'THYAO',
          sessionDate: '2026-08-25',
          ts: TEN_OCLOCK - 60_000,
          open: 299.0,
          close: 299.5,
          isAuction: true,
        },
      ]);
    } finally {
      await client.close();
    }
  });

  it('leaves a minute out rather than reaching for a neighbouring one', async () => {
    // A missing minute means nothing traded then; the caller withholds the figure.
    const client = new IntentBarsWorkerClient(databasePath);
    try {
      await expect(
        client.queryBars([{ symbol: 'THYAO', ts: TEN_OCLOCK + 60_000 }]),
      ).resolves.toEqual([]);
      await expect(client.queryBars([{ symbol: 'NOSUCH', ts: TEN_OCLOCK }])).resolves.toEqual([]);
    } finally {
      await client.close();
    }
  });

  it('reports both when it was built and how far its bars reach', async () => {
    const client = new IntentBarsWorkerClient(databasePath);
    try {
      await expect(client.queryStamp()).resolves.toEqual({
        snapshotFor: '2026-08-24',
        builtAt: 1777000000000,
        barRows: 2,
        // The two are different questions: the run day, and the newest session
        // the bars actually reach. Only the second says what can be priced.
        coversThrough: '2026-08-25',
      });
    } finally {
      await client.close();
    }
  });

  it('recovers on the next bounded read after an unexpected worker exit', async () => {
    const client = new IntentBarsWorkerClient(databasePath);
    try {
      await expect(client.queryBars([{ symbol: 'THYAO', ts: TEN_OCLOCK }])).resolves.toHaveLength(
        1,
      );
      const worker = Reflect.get(client, 'worker') as { terminate: () => Promise<number> } | null;
      if (!worker) throw new Error('The intent bars worker did not start.');
      await worker.terminate();
      await expect(client.queryBars([{ symbol: 'THYAO', ts: TEN_OCLOCK }])).resolves.toHaveLength(
        1,
      );
    } finally {
      await client.close();
    }
  });
});
