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

/**
 * A carried position's session-start basis, in descending order of authority:
 *
 * 1. Today's PREV_CLOSE, DDA's adjusted OGUNK reference.
 * 2. The prior session's actual closing auction.
 * 3. That session's final real bar, but only when DDA recorded no feed-wide outage from the
 *    bar onward to the availability monitor's session-close boundary (+10 minutes).
 *
 * The last route is intentionally conservative. If availability.db is unavailable or cannot
 * prove the interval, the bar is not returned; a caller must withhold the derived P&L instead.
 */
function queryDailyBases(databasePath, availabilityDatabasePath, keys) {
  const database = openDatabase(databasePath);
  let availabilityDatabase = null;
  try {
    const previousClose = database.prepare(`
      SELECT symbol, close
      FROM bars
      WHERE symbol = ?
        AND session_date = ?
        AND bar_type = 'PREV_CLOSE'
        AND close > 0
      LIMIT 1
    `);
    const closingAuction = database.prepare(`
      SELECT symbol, close
      FROM bars
      WHERE symbol = ?
        AND session_date = ?
        AND bar_type = 'CLOSING_AUCTION'
        AND close > 0
      ORDER BY bar_ts DESC
      LIMIT 1
    `);
    const latestRealBar = database.prepare(`
      SELECT symbol, close, bar_ts AS barTs
      FROM bars
      WHERE symbol = ?
        AND session_date = ?
        AND bar_type != 'PREV_CLOSE'
        AND close > 0
      ORDER BY bar_ts DESC
      LIMIT 1
    `);
    const session = database.prepare(`
      SELECT normal_end_ts AS normalEndTs
      FROM session_meta
      WHERE session_date = ?
        AND is_trading_day = 1
      LIMIT 1
    `);

    const results = [];
    for (const key of keys) {
      const prevClose = previousClose.get(key.symbol, key.prevCloseSessionDate);
      if (prevClose) {
        results.push({ symbol: prevClose.symbol, close: prevClose.close, source: 'prev-close' });
        continue;
      }

      const auction = closingAuction.get(key.symbol, key.fallbackSessionDate);
      if (auction) {
        results.push({ symbol: auction.symbol, close: auction.close, source: 'closing-auction' });
        continue;
      }

      const lastBar = latestRealBar.get(key.symbol, key.fallbackSessionDate);
      const sessionRow = session.get(key.fallbackSessionDate);
      if (!lastBar || !sessionRow || !Number.isFinite(sessionRow.normalEndTs)) continue;

      // DDA's availability observer defines its session close at normal_end + ten minutes. The
      // remaining five minutes of closing-price trades are outside the observer's documented
      // coverage, so they cannot establish or refute the final-bar fallback.
      const availabilityEndTs = sessionRow.normalEndTs + 10 * 60;
      if (lastBar.barTs >= availabilityEndTs) continue;

      try {
        if (!availabilityDatabase) {
          availabilityDatabase = new DatabaseSync(availabilityDatabasePath, {
            readOnly: true,
            timeout: 5_000,
          });
          availabilityDatabase.exec('PRAGMA query_only = ON');
        }
        const outage = availabilityDatabase
          .prepare(
            `
            SELECT 1
            FROM outages
            WHERE session_date = ?
              AND start_ts < ?
              AND (end_ts IS NULL OR end_ts > ?)
            LIMIT 1
          `,
          )
          .get(key.fallbackSessionDate, availabilityEndTs, lastBar.barTs);
        if (outage) continue;
      } catch {
        // The final bar is not a safe substitute without availability evidence.
        continue;
      }

      results.push({ symbol: lastBar.symbol, close: lastBar.close, source: 'last-bar' });
    }
    return results;
  } finally {
    availabilityDatabase?.close();
    database.close();
  }
}

// PREV_CLOSE is a synthetic sentinel carrying yesterday's close at 09:44, not a trade, so it can
// never stand in for a market price. Everything else can: an in-progress NORMAL bar while the feed is
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
        : message.kind === 'daily-bases'
          ? queryDailyBases(message.databasePath, message.availabilityDatabasePath, message.keys)
          : queryClosingBars(message.databasePath, message.keys);
    parentPort.postMessage({ id: message.id, result });
  } catch (error) {
    parentPort.postMessage({
      id: message.id,
      error: error instanceof Error ? error.message : String(error),
    });
  }
});
