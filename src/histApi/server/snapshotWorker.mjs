/**
 * The nightly BistData pull, in a worker thread of its own.
 *
 * `../BistData`'s consumer guide is explicit: any open DuckDB connection — read-only
 * included — takes a cross-process lock that makes the producing pipeline's next
 * `sync` abort before it fetches anything. Nothing is corrupted, but the databases
 * silently stop advancing. So this file is the only place in the viewer that opens
 * DuckDB at all, it runs once a night, and the scheduler terminates the thread the
 * moment it finishes — the native addon is unloaded with the thread, so no handle
 * can outlive the run.
 *
 * Everything the running app reads comes from the SQLite cache this writes.
 */
import { parentPort, workerData } from 'node:worker_threads';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, renameSync, rmSync } from 'node:fs';
import path from 'node:path';

const SCHEMA_VERSION = 1;
/** Ten tries a quarter-second apart: long enough for a bounded read to finish. */
const SWAP_ATTEMPTS = 10;
const SWAP_RETRY_MS = 250;
const SYMBOL_PATTERN = /^[A-Z0-9]{1,16}$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** Turkey has been on permanent UTC+3 since 2016, so a fixed offset is exact here. */
const ISTANBUL_OFFSET_MS = 3 * 60 * 60 * 1000;
const OPENING_AUCTION_MINUTE = 9 * 60 + 55;
const CLOSE_MINUTE = 18 * 60;
const HALF_DAY_CLOSE_MINUTE = 12 * 60 + 30;
/** `firstTradeInstant` folds a stamp just past the close onto close + 5. */
const CLOSING_AUCTION_OFFSET = 5;

function istanbulDay(epochMs) {
  return new Date(epochMs + ISTANBUL_OFFSET_MS).toISOString().slice(0, 10);
}

function istanbulMinuteAt(day, minute) {
  return Date.parse(`${day}T00:00:00+03:00`) + minute * 60_000;
}

function nextDay(day) {
  return new Date(Date.parse(`${day}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
}

function isTradingDay(day, holidays) {
  const weekday = new Date(`${day}T00:00:00Z`).getUTCDay();
  if (weekday === 0 || weekday === 6) return false;
  return holidays.get(day) !== 'full';
}

function nextTradingDay(day, holidays) {
  let cursor = nextDay(day);
  for (let step = 0; step < 400; step += 1) {
    if (isTradingDay(cursor, holidays)) return cursor;
    cursor = nextDay(cursor);
  }
  return null;
}

function closeMinuteOn(day, holidays) {
  return holidays.get(day) === 'half' ? HALF_DAY_CLOSE_MINUTE : CLOSE_MINUTE;
}

// ---------------------------------------------------------------------------
// 1. What we need, from MatriksOrder's own store.
// ---------------------------------------------------------------------------

/**
 * Every stamp an intent instant can be read off, per API.md: a scheduled order's
 * fire time, or the creation time when it was never a plan. `orderTime`/`sentTime`
 * are deliberately not here — `intent` is read off the plan, not off when the
 * order actually registered.
 */
const UNIVERSE_SQL = `
  SELECT DISTINCT symbol, t FROM (
    SELECT symbol, createdTime AS t FROM ActiveOrders WHERE createdTime IS NOT NULL
    UNION ALL SELECT symbol, scheduledTime FROM ActiveOrders WHERE scheduledTime IS NOT NULL
    UNION ALL SELECT symbol, createdTime FROM CanceledOrders WHERE createdTime IS NOT NULL
    UNION ALL SELECT symbol, scheduledTime FROM CanceledOrders WHERE scheduledTime IS NOT NULL
    UNION ALL SELECT symbol, createdTime FROM Positions WHERE createdTime IS NOT NULL
    UNION ALL SELECT symbol, scheduledTime FROM Positions WHERE scheduledTime IS NOT NULL
    UNION ALL SELECT symbol, openCreatedTime FROM ClosedTrades WHERE openCreatedTime IS NOT NULL
    UNION ALL SELECT symbol, openScheduledTime FROM ClosedTrades WHERE openScheduledTime IS NOT NULL
    UNION ALL SELECT symbol, closeCreatedTime FROM ClosedTrades WHERE closeCreatedTime IS NOT NULL
    UNION ALL SELECT symbol, closeScheduledTime FROM ClosedTrades WHERE closeScheduledTime IS NOT NULL
  )
`;

function readUniverse(orderDbPath) {
  const database = new DatabaseSync(orderDbPath, { readOnly: true, timeout: 5_000 });
  database.exec('PRAGMA query_only = ON');
  try {
    const holidays = new Map();
    for (const row of database.prepare('SELECT date, type FROM Holidays').all()) {
      if (DATE_PATTERN.test(String(row.date))) holidays.set(String(row.date), String(row.type));
    }

    /** symbol -> Set<session date> */
    const sessions = new Map();
    for (const row of database.prepare(UNIVERSE_SQL).all()) {
      const symbol = String(row.symbol ?? '').toUpperCase();
      const stamp = Number(row.t);
      if (!SYMBOL_PATTERN.test(symbol) || !Number.isFinite(stamp)) continue;
      const day = istanbulDay(stamp);
      if (!DATE_PATTERN.test(day)) continue;
      let days = sessions.get(symbol);
      if (!days) sessions.set(symbol, (days = new Set()));
      days.add(day);
      // A stamp written past the close belongs to the next session, and that is
      // where its intent instant lands, so that day's bars are needed too.
      const following = nextTradingDay(day, holidays);
      if (following) days.add(following);
    }
    return { holidays, sessions };
  } finally {
    database.close();
  }
}

// ---------------------------------------------------------------------------
// 2. The one DuckDB visit.
// ---------------------------------------------------------------------------

const quoted = (values) => values.map((value) => `'${value}'`).join(',');

async function pullFromDuckDb({ minuteDbPath, scaleDbPath, sessions }) {
  const { DuckDBInstance } = await import('@duckdb/node-api');
  const symbols = [...sessions.keys()].sort();

  const minuteInstance = await DuckDBInstance.create(minuteDbPath, { access_mode: 'READ_ONLY' });
  let minuteConnection = null;
  const bars = [];
  try {
    minuteConnection = await minuteInstance.connect();
    for (const symbol of symbols) {
      const days = [...sessions.get(symbol)].filter((day) => DATE_PATTERN.test(day)).sort();
      if (days.length === 0) continue;
      // Casting in SQL rather than decoding DECIMAL/TIMESTAMP objects here keeps
      // exact prices and unambiguous wall-clock strings.
      const reader = await minuteConnection.runAndReadAll(
        `SELECT CAST(ts AS VARCHAR) AS ts,
                CAST(open AS DOUBLE) AS open,
                CAST(close AS DOUBLE) AS close,
                CAST(is_auction AS INTEGER) AS is_auction
           FROM minute_bars
          WHERE symbol = ?
            AND CAST(ts AS DATE) IN (${quoted(days)})`,
        [symbol],
      );
      for (const row of reader.getRowObjectsJson()) bars.push({ symbol, ...row });
    }
  } finally {
    minuteConnection?.closeSync();
    minuteInstance.closeSync();
  }

  const scaleInstance = await DuckDBInstance.create(scaleDbPath, { access_mode: 'READ_ONLY' });
  let scaleConnection = null;
  let ranges = [];
  let exceptions = [];
  let findings = [];
  try {
    scaleConnection = await scaleInstance.connect();
    const symbolList = quoted(symbols);
    const read = async (sql) => (await scaleConnection.runAndReadAll(sql)).getRowObjectsJson();
    ranges = await read(
      `SELECT scope, symbol,
              CAST(start_date AS VARCHAR) AS start_date,
              CAST(end_date AS VARCHAR) AS end_date,
              CAST(factor AS DOUBLE) AS factor,
              confidence
         FROM scale_range WHERE symbol IN (${symbolList})`,
    );
    exceptions = await read(
      `SELECT scope, symbol, CAST(session_date AS VARCHAR) AS session_date
         FROM scale_exception WHERE symbol IN (${symbolList})`,
    );
    findings = await read(
      `SELECT scope, symbol, CAST(session_date AS VARCHAR) AS session_date
         FROM data_quality_finding WHERE symbol IN (${symbolList})`,
    );
  } finally {
    scaleConnection?.closeSync();
    scaleInstance.closeSync();
  }

  return { bars, ranges, exceptions, findings };
}

// ---------------------------------------------------------------------------
// 3. Normalize, filter, and write the cache.
// ---------------------------------------------------------------------------

/**
 * `normalized_price = stored_price * factor`, the multiplier that puts a stored
 * price onto the BIST daily bulletin's raw scale — which is the scale MatriksOrder's
 * fill prices are already on, so this is what makes the two comparable. Auction rows
 * are synthesized from the daily file and carry its vintage, hence the `daily` scope.
 */
function factorFor(ranges, symbol, scope, sessionDate) {
  const covering = ranges.find(
    (range) =>
      range.symbol === symbol &&
      range.scope === scope &&
      String(range.start_date) <= sessionDate &&
      sessionDate <= String(range.end_date),
  );
  return covering ? Number(covering.factor) : 1;
}

/*
 * `symbol_alias` is deliberately not read. BIST renames tickers, and collapsing a
 * retired local ticker onto its bulletin name is right for cross-sectional work —
 * but every lookup here is a point read keyed by MatriksOrder's own symbol, so
 * renaming a row would hide it from the only caller there is. We ask BistData only
 * for the tickers MatriksOrder names, so nothing is double-counted either.
 */
function buildRows({ bars, ranges, exceptions, findings, holidays }) {
  const untrusted = new Set(
    [...exceptions, ...findings].map(
      (row) => `${row.scope}|${row.symbol}|${String(row.session_date)}`,
    ),
  );

  const rows = new Map();
  for (const bar of bars) {
    const wall = String(bar.ts).replace(' ', 'T');
    const sessionDate = wall.slice(0, 10);
    if (!DATE_PATTERN.test(sessionDate)) continue;
    const isAuction = Number(bar.is_auction) === 1;
    const scope = isAuction ? 'daily' : 'minute';
    // An exception says the multiplier cannot be trusted; a finding says the bar
    // itself is wrong. Either way the session is left out rather than guessed at.
    if (untrusted.has(`${scope}|${bar.symbol}|${sessionDate}`)) continue;

    const open = Number(bar.open);
    const close = Number(bar.close);
    if (!Number.isFinite(open) || !Number.isFinite(close) || open <= 0 || close <= 0) continue;

    const factor = factorFor(ranges, bar.symbol, scope, sessionDate);
    if (!Number.isFinite(factor) || factor <= 0) continue;

    const minute = Number(wall.slice(11, 13)) * 60 + Number(wall.slice(14, 16));
    let ts;
    if (isAuction && minute > OPENING_AUCTION_MINUTE) {
      /*
       * BistData always writes its synthetic closing print at 18:05, including on
       * a BIST half day whose close is 12:30. The viewer's calendar puts the
       * closing-auction instant at close + 5, so the row is re-stamped to the
       * session's own close + 5 here. Matching by role rather than by clock is
       * what lets the domain do a plain point lookup on both kinds of day.
       */
      ts = istanbulMinuteAt(
        sessionDate,
        closeMinuteOn(sessionDate, holidays) + CLOSING_AUCTION_OFFSET,
      );
    } else {
      ts = istanbulMinuteAt(sessionDate, minute);
    }

    rows.set(`${bar.symbol}|${ts}`, {
      symbol: bar.symbol,
      sessionDate,
      ts,
      open: open * factor,
      close: close * factor,
      isAuction: isAuction ? 1 : 0,
    });
  }
  return [...rows.values()];
}

function writeCache({ cachePath, rows, ranges, snapshotFor }) {
  mkdirSync(path.dirname(cachePath), { recursive: true });
  const temporaryPath = `${cachePath}.building`;
  rmSync(temporaryPath, { force: true });

  const database = new DatabaseSync(temporaryPath);
  try {
    database.exec(`
      PRAGMA journal_mode = DELETE;
      CREATE TABLE intent_bar (
        symbol TEXT NOT NULL,
        session_date TEXT NOT NULL,
        ts INTEGER NOT NULL,
        open REAL NOT NULL,
        close REAL NOT NULL,
        is_auction INTEGER NOT NULL,
        PRIMARY KEY (symbol, ts)
      );
      CREATE TABLE scale_used (
        symbol TEXT NOT NULL, scope TEXT NOT NULL,
        start_date TEXT NOT NULL, end_date TEXT NOT NULL,
        factor REAL NOT NULL, confidence TEXT NOT NULL
      );
      CREATE TABLE meta (
        schema_version INTEGER NOT NULL,
        snapshot_for TEXT NOT NULL,
        built_at INTEGER NOT NULL,
        bar_rows INTEGER NOT NULL
      );
    `);
    const insertBar = database.prepare(
      'INSERT INTO intent_bar (symbol, session_date, ts, open, close, is_auction) VALUES (?, ?, ?, ?, ?, ?)',
    );
    database.exec('BEGIN');
    for (const row of rows) {
      insertBar.run(row.symbol, row.sessionDate, row.ts, row.open, row.close, row.isAuction);
    }
    // Audit only: never read on a request path, but it is what makes a surprising
    // figure explainable without opening DuckDB again.
    const insertScale = database.prepare(
      'INSERT INTO scale_used (symbol, scope, start_date, end_date, factor, confidence) VALUES (?, ?, ?, ?, ?, ?)',
    );
    for (const range of ranges) {
      insertScale.run(
        String(range.symbol),
        String(range.scope),
        String(range.start_date),
        String(range.end_date),
        Number(range.factor),
        String(range.confidence),
      );
    }
    database
      .prepare(
        'INSERT INTO meta (schema_version, snapshot_for, built_at, bar_rows) VALUES (?, ?, ?, ?)',
      )
      .run(SCHEMA_VERSION, snapshotFor, Date.now(), rows.length);
    database.exec('COMMIT');
  } finally {
    database.close();
  }

  /*
   * Atomic swap, so a crashed run never leaves a half-built cache in place.
   * Windows refuses a rename while any process holds the target open, and the
   * viewer that runs this scheduler is also the one serving reads from it — a
   * bounded read lasts milliseconds, but 23:00 is not a quiet hour by contract.
   * A short retry covers the overlap; anything longer is a real lock, and the
   * scheduler's own hourly retry is the right place to wait it out.
   */
  for (let attempt = 0; ; attempt += 1) {
    try {
      renameSync(temporaryPath, cachePath);
      return;
    } catch (error) {
      if (attempt >= SWAP_ATTEMPTS - 1) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, SWAP_RETRY_MS);
    }
  }
}

async function run(options) {
  const { holidays, sessions } = readUniverse(options.orderDbPath);
  if (sessions.size === 0) {
    return { barRows: 0, symbols: 0, skipped: 'no symbols in the order store' };
  }
  const pulled = await pullFromDuckDb({
    minuteDbPath: options.minuteDbPath,
    scaleDbPath: options.scaleDbPath,
    sessions,
  });
  const rows = buildRows({ ...pulled, holidays });
  writeCache({
    cachePath: options.cachePath,
    rows,
    ranges: pulled.ranges,
    snapshotFor: options.snapshotFor,
  });
  return { barRows: rows.length, symbols: sessions.size };
}

run(workerData).then(
  (result) => parentPort?.postMessage({ ok: true, result }),
  (error) =>
    parentPort?.postMessage({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    }),
);
