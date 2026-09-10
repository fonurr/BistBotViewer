import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { LogsWorkerClient, LogsWorkerError } from './logsWorkerClient';

let fixtureDirectory: string;
let databasePaths: { errors: string; wire: string; api: string };

const WIRE_TABLE = `
  CREATE TABLE WireLog (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    at INTEGER NOT NULL,
    atText TEXT NOT NULL,
    target TEXT NOT NULL,
    direction TEXT NOT NULL,
    type TEXT NOT NULL,
    operation TEXT NOT NULL,
    apiCommand INTEGER,
    ref INTEGER,
    latencyMs INTEGER,
    accountId TEXT,
    brokerageId TEXT,
    symbol TEXT,
    clientOrderId TEXT,
    orderId TEXT,
    ordStatus TEXT,
    note TEXT,
    body TEXT,
    truncated INTEGER NOT NULL DEFAULT 0
  );
`;

function createDatabase(databasePath: string, sql: string): void {
  const database = new DatabaseSync(databasePath);
  try {
    database.exec(sql);
  } finally {
    database.close();
  }
}

beforeAll(async () => {
  fixtureDirectory = await mkdtemp(path.join(os.tmpdir(), 'bot-viewer-logs-'));
  databasePaths = {
    errors: path.join(fixtureDirectory, 'matriksorder.db'),
    wire: path.join(fixtureDirectory, 'wire-log.db'),
    api: path.join(fixtureDirectory, 'api-log.db'),
  };

  createDatabase(
    databasePaths.errors,
    `
      CREATE TABLE Errors (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        time INTEGER NOT NULL,
        type TEXT NOT NULL,
        information TEXT NOT NULL,
        accountId TEXT,
        brokerageId TEXT,
        context TEXT
      );
      INSERT INTO Errors (time, type, information) VALUES
        (100, 'AccountNotFound', 'oldest'),
        (200, 'BarsDataError', 'middle'),
        (250, 'AccountNotFound', 'newer'),
        (300, 'AccountFeedSilent', 'exclusive boundary');
    `,
  );
  createDatabase(
    databasePaths.wire,
    `
      ${WIRE_TABLE}
      INSERT INTO WireLog
        (at, atText, target, direction, type, operation, apiCommand, body, truncated)
      VALUES
        (150, '1970-01-01 03:00:00.150', 'matriks', 'out', 'routine', 'GetOrders', 1, '{}', 0),
        (275, '1970-01-01 03:00:00.275', 'quotes', 'in', 'error', '/api/quotes', NULL, '{}', 0),
        (200, '1970-01-01 03:00:00.200', 'matriks', 'in', 'routine', 'GetOrders', 1, '[]', 0);
    `,
  );
  createDatabase(
    databasePaths.api,
    `
      CREATE TABLE ApiLog (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        at INTEGER NOT NULL,
        atText TEXT NOT NULL,
        type TEXT NOT NULL,
        method TEXT NOT NULL,
        path TEXT NOT NULL,
        botId TEXT,
        status INTEGER,
        durationMs INTEGER,
        requestBody TEXT,
        responseBody TEXT,
        errorType TEXT,
        note TEXT,
        truncated INTEGER NOT NULL DEFAULT 0
      );
      INSERT INTO ApiLog
        (at, atText, type, method, path, status, durationMs, requestBody, responseBody)
      VALUES
        (175, '1970-01-01 03:00:00.175', 'routine', 'POST', '/api/GetBots', 200, 4, '{}', '[]');
    `,
  );
});

afterAll(async () => {
  await rm(fixtureDirectory, { recursive: true, force: true });
});

describe('LogsWorkerClient', () => {
  it('starts a fresh worker after an unexpected worker exit', async () => {
    const client = new LogsWorkerClient(databasePaths);
    try {
      await expect(client.extents()).resolves.toMatchObject({
        errors: { minMs: 100, maxMs: 300 },
      });
      const worker = Reflect.get(client, 'worker') as { terminate: () => Promise<number> } | null;
      if (!worker) throw new Error('The logs worker did not start.');
      await worker.terminate();
      await expect(client.extents()).resolves.toMatchObject({
        errors: { minMs: 100, maxMs: 300 },
      });
    } finally {
      await client.close();
    }
  });

  it('returns independent extents for every source', async () => {
    const client = new LogsWorkerClient(databasePaths);
    try {
      await expect(client.extents()).resolves.toEqual({
        errors: { minMs: 100, maxMs: 300 },
        wire: { minMs: 150, maxMs: 275 },
        api: { minMs: 175, maxMs: 175 },
      });
    } finally {
      await client.close();
    }
  });

  it('keeps totals and unfiltered type counts stable across id-cursor pages', async () => {
    const client = new LogsWorkerClient(databasePaths);
    try {
      const first = await client.query({
        source: 'errors',
        fromMs: 100,
        untilMs: 300,
        types: ['AccountNotFound'],
        limit: 1,
      });
      expect(first.rows.map((row) => row.id)).toEqual([3]);
      expect(first.total).toBe(2);
      expect(first.countsByType.AccountNotFound).toBe(2);
      expect(first.countsByType.BarsDataError).toBe(1);
      expect(first.countsByType.AccountFeedSilent).toBe(0);

      const second = await client.query({
        source: 'errors',
        fromMs: 100,
        untilMs: 300,
        types: ['AccountNotFound'],
        limit: 1,
        beforeId: first.rows[0]!.id,
      });
      expect(second.rows.map((row) => row.id)).toEqual([1]);
      expect(second.total).toBe(first.total);
      expect(second.countsByType).toEqual(first.countsByType);
    } finally {
      await client.close();
    }
  });

  it('filters the wire log by operation while counting every operation in the range', async () => {
    const client = new LogsWorkerClient(databasePaths);
    try {
      const everyOperation = {
        values: [
          { value: 'GetOrders', count: 2 },
          { value: '/api/quotes', count: 1 },
        ],
        complete: true,
      };
      const narrowed = await client.query({
        source: 'wire',
        fromMs: 100,
        untilMs: 300,
        operations: ['GetOrders'],
        limit: 10,
      });
      expect(narrowed.rows.map((row) => row.at)).toEqual([200, 150]);
      expect(narrowed.total).toBe(2);
      expect(narrowed.countsByType).toMatchObject({ routine: 2, error: 1 });
      expect(narrowed.operationCounts).toEqual(everyOperation);

      const combined = await client.query({
        source: 'wire',
        fromMs: 100,
        untilMs: 300,
        types: ['error'],
        operations: ['GetOrders'],
        limit: 10,
      });
      expect(combined.total).toBe(0);

      const none = await client.query({
        source: 'wire',
        fromMs: 100,
        untilMs: 300,
        operations: [],
        limit: 10,
      });
      expect(none.rows).toEqual([]);
      expect(none.total).toBe(0);
      expect(none.operationCounts).toEqual(everyOperation);
    } finally {
      await client.close();
    }
  });

  it('filters the API log by path', async () => {
    const client = new LogsWorkerClient(databasePaths);
    try {
      const matching = await client.query({
        source: 'api',
        fromMs: 100,
        untilMs: 300,
        paths: ['/api/GetBots', '/api/SendOrders'],
        limit: 10,
      });
      expect(matching.total).toBe(1);
      expect(matching.pathCounts).toEqual({
        values: [{ value: '/api/GetBots', count: 1 }],
        complete: true,
      });

      const other = await client.query({
        source: 'api',
        fromMs: 100,
        untilMs: 300,
        paths: ['/api/SendOrders'],
        limit: 10,
      });
      expect(other.rows).toEqual([]);
      expect(other.total).toBe(0);
    } finally {
      await client.close();
    }
  });

  it('refuses a value filter the source has no column for, or one that repeats', async () => {
    const client = new LogsWorkerClient(databasePaths);
    try {
      expect(() =>
        client.query({
          source: 'errors',
          fromMs: 100,
          untilMs: 300,
          operations: ['GetOrders'],
          limit: 10,
        } as never),
      ).toThrow();
      expect(() =>
        client.query({
          source: 'wire',
          fromMs: 100,
          untilMs: 300,
          paths: ['/api/GetBots'],
          limit: 10,
        } as never),
      ).toThrow();
      expect(() =>
        client.query({
          source: 'wire',
          fromMs: 100,
          untilMs: 300,
          operations: ['GetOrders', 'GetOrders'],
          limit: 10,
        }),
      ).toThrow();
    } finally {
      await client.close();
    }
  });

  it('groups and filters a quotes operation by the part before its query string', async () => {
    const quotesPath = path.join(fixtureDirectory, 'quotes-wire-log.db');
    createDatabase(
      quotesPath,
      `
        ${WIRE_TABLE}
        INSERT INTO WireLog (at, atText, target, direction, type, operation, truncated) VALUES
          (10, 'fixture', 'quotes', 'out', 'routine', '/api/quotes?symbols=ANELE', 0),
          (20, 'fixture', 'quotes', 'in',  'routine', '/api/quotes?symbols=TKNKA,MARTI', 0),
          (30, 'fixture', 'quotes', 'out', 'routine', '/api/stream?symbols=BIGEN', 0),
          (40, 'fixture', 'quotes', 'out', 'routine', '/api/stream', 0);
      `,
    );
    const client = new LogsWorkerClient({ ...databasePaths, wire: quotesPath });
    try {
      const counted = await client.query({
        source: 'wire',
        fromMs: 0,
        untilMs: 100,
        limit: 10,
      });
      expect(counted.operationCounts).toEqual({
        values: [
          { value: '/api/quotes', count: 2 },
          { value: '/api/stream', count: 2 },
        ],
        complete: true,
      });

      const filtered = await client.query({
        source: 'wire',
        fromMs: 0,
        untilMs: 100,
        operations: ['/api/quotes'],
        limit: 10,
      });
      expect(filtered.total).toBe(2);
      expect(filtered.rows.map((row) => row.operation).sort()).toEqual([
        '/api/quotes?symbols=ANELE',
        '/api/quotes?symbols=TKNKA,MARTI',
      ]);
    } finally {
      await client.close();
    }
  });

  it('says so when a range holds more operations than one read counts', async () => {
    const crowdedPath = path.join(fixtureDirectory, 'crowded-wire-log.db');
    createDatabase(
      crowdedPath,
      `
        ${WIRE_TABLE}
        INSERT INTO WireLog (at, atText, target, direction, type, operation, truncated)
        WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 201)
        SELECT 1000 + i, 'fixture', 'matriks', 'in', 'routine', 'Operation ' || i, 0 FROM n;
      `,
    );
    const client = new LogsWorkerClient({ ...databasePaths, wire: crowdedPath });
    try {
      const result = await client.query({
        source: 'wire',
        fromMs: 1_000,
        untilMs: 2_000,
        limit: 1,
      });
      expect(result.total).toBe(201);
      expect(result.operationCounts.values).toHaveLength(200);
      expect(result.operationCounts.complete).toBe(false);
    } finally {
      await client.close();
    }
  });

  it('returns a schema mismatch instead of an empty result', async () => {
    const mismatchedPath = path.join(fixtureDirectory, 'mismatched.db');
    createDatabase(mismatchedPath, 'CREATE TABLE Errors (id INTEGER PRIMARY KEY);');
    const client = new LogsWorkerClient({
      ...databasePaths,
      errors: mismatchedPath,
    });
    try {
      await expect(
        client.query({
          source: 'errors',
          fromMs: 0,
          untilMs: 1,
          limit: 10,
        }),
      ).rejects.toMatchObject({
        code: 'SCHEMA_MISMATCH',
      } satisfies Partial<LogsWorkerError>);
    } finally {
      await client.close();
    }
  });

  it('returns unavailable instead of creating a missing database', async () => {
    const missingPath = path.join(fixtureDirectory, 'missing.db');
    const client = new LogsWorkerClient({
      ...databasePaths,
      errors: missingPath,
    });
    try {
      await expect(client.extents()).rejects.toMatchObject({
        code: 'UNAVAILABLE',
      } satisfies Partial<LogsWorkerError>);
    } finally {
      await client.close();
    }
  });
});
