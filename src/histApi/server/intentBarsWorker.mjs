import { parentPort } from 'node:worker_threads';
import { DatabaseSync } from 'node:sqlite';

const REQUIRED_COLUMNS = new Set(['symbol', 'session_date', 'ts', 'open', 'close', 'is_auction']);

/**
 * Read-only and query-only, opened per bounded request and closed in a `finally`
 * so no WAL checkpoint is ever held open — the same contract `priceApi`'s bars
 * worker keeps. This file reads only the cache this repo builds; the DuckDB
 * source it came from is opened once a night by `snapshot.mjs` and never here.
 */
function openDatabase(databasePath) {
  const database = new DatabaseSync(databasePath, { readOnly: true, timeout: 5_000 });
  database.exec('PRAGMA query_only = ON');
  const names = new Set(
    database
      .prepare('PRAGMA table_info(intent_bar)')
      .all()
      .map((column) => String(column.name)),
  );
  for (const required of REQUIRED_COLUMNS) {
    if (!names.has(required)) {
      database.close();
      throw new Error(`intent-bars.db is missing column ${required}.`);
    }
  }
  return database;
}

function queryIntentBars(databasePath, keys) {
  const database = openDatabase(databasePath);
  try {
    const statement = database.prepare(`
      SELECT symbol,
             session_date AS sessionDate,
             ts,
             open,
             close,
             is_auction AS isAuction
      FROM intent_bar
      WHERE symbol = ? AND ts = ?
    `);
    const rows = [];
    for (const key of keys) {
      const row = statement.get(key.symbol, key.ts);
      // A missing minute is not an error: it means nothing traded then. The
      // caller withholds the figure rather than reaching for a neighbour.
      if (row) rows.push({ ...row, isAuction: row.isAuction === 1 });
    }
    return rows;
  } finally {
    database.close();
  }
}

function queryStatus(databasePath) {
  const database = openDatabase(databasePath);
  try {
    const row = database.prepare('SELECT snapshot_for, built_at, bar_rows FROM meta').get();
    if (!row) return [];
    /*
     * How far the bars actually reach, which is not the same question as when
     * the snapshot ran. BistData backfills, so its minute history trails the
     * live sessions by a day or more — and it is the sessions past this date
     * that can never be priced, however recently the job succeeded.
     */
    const covers = database.prepare('SELECT MAX(session_date) AS d FROM intent_bar').get();
    return [
      {
        snapshotFor: row.snapshot_for === undefined ? null : String(row.snapshot_for),
        builtAt: row.built_at === null || row.built_at === undefined ? null : Number(row.built_at),
        barRows: row.bar_rows === null || row.bar_rows === undefined ? null : Number(row.bar_rows),
        coversThrough: covers?.d === null || covers?.d === undefined ? null : String(covers.d),
      },
    ];
  } finally {
    database.close();
  }
}

parentPort.on('message', (message) => {
  try {
    const result =
      message.kind === 'status'
        ? queryStatus(message.databasePath)
        : queryIntentBars(message.databasePath, message.keys);
    parentPort.postMessage({ id: message.id, result });
  } catch (error) {
    parentPort.postMessage({
      id: message.id,
      error: error instanceof Error ? error.message : String(error),
    });
  }
});
