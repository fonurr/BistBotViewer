import { parentPort } from 'node:worker_threads';
import { DatabaseSync } from 'node:sqlite';

const REQUIRED_COLUMNS = new Set([
  'symbol',
  'session_date',
  'close',
  'volume',
  'bar_ts',
  'bar_type',
]);

function openDatabase(databasePath) {
  const database = new DatabaseSync(databasePath, { readOnly: true, timeout: 5_000 });
  database.exec('PRAGMA query_only = ON');
  const columns = database.prepare('PRAGMA table_info(bars)').all();
  const names = new Set(columns.map((column) => String(column.name)));
  for (const required of REQUIRED_COLUMNS) {
    if (!names.has(required)) {
      database.close();
      throw new Error(`bars.db is missing column ${required}.`);
    }
  }
  return database;
}

function queryClosingBars(databasePath, keys) {
  const database = openDatabase(databasePath);
  try {
    const statement = database.prepare(`
      SELECT symbol,
             session_date AS sessionDate,
             close,
             volume,
             bar_ts AS barTs
      FROM bars
      WHERE symbol = ?
        AND session_date = ?
        AND bar_type = 'CLOSING_AUCTION'
      ORDER BY bar_ts DESC
      LIMIT 1
    `);
    const rows = [];
    for (const key of keys) {
      const row = statement.get(key.symbol, key.sessionDate);
      if (row) rows.push(row);
    }
    return rows;
  } finally {
    database.close();
  }
}

// PREV_CLOSE is a synthetic sentinel carrying yesterday's close at 09:44, not a trade, so it can
// never stand in for a price. Everything else can: an in-progress NORMAL bar while the feed is
// stalled, the CLOSING_AUCTION bar once the session is over.
function queryLatestBars(databasePath, symbols) {
  const database = openDatabase(databasePath);
  try {
    const statement = database.prepare(`
      SELECT symbol,
             session_date AS sessionDate,
             close,
             bar_ts AS barTs,
             bar_type AS barType
      FROM bars
      WHERE symbol = ?
        AND bar_type != 'PREV_CLOSE'
      ORDER BY bar_ts DESC
      LIMIT 1
    `);
    const rows = [];
    for (const symbol of symbols) {
      const row = statement.get(symbol);
      if (row) rows.push(row);
    }
    return rows;
  } finally {
    database.close();
  }
}

parentPort.on('message', (message) => {
  try {
    const result =
      message.kind === 'latest'
        ? queryLatestBars(message.databasePath, message.symbols)
        : queryClosingBars(message.databasePath, message.keys);
    parentPort.postMessage({ id: message.id, result });
  } catch (error) {
    parentPort.postMessage({
      id: message.id,
      error: error instanceof Error ? error.message : String(error),
    });
  }
});
