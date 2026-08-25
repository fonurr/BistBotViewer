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

function queryClosingBars(databasePath, keys) {
  const database = new DatabaseSync(databasePath, { readOnly: true, timeout: 5_000 });
  try {
    database.exec('PRAGMA query_only = ON');
    const columns = database.prepare('PRAGMA table_info(bars)').all();
    const names = new Set(columns.map((column) => String(column.name)));
    for (const required of REQUIRED_COLUMNS) {
      if (!names.has(required)) throw new Error(`bars.db is missing column ${required}.`);
    }

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

parentPort.on('message', (message) => {
  try {
    const result = queryClosingBars(message.databasePath, message.keys);
    parentPort.postMessage({ id: message.id, result });
  } catch (error) {
    parentPort.postMessage({
      id: message.id,
      error: error instanceof Error ? error.message : String(error),
    });
  }
});
