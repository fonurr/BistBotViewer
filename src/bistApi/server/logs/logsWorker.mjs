import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { parentPort, workerData } from 'node:worker_threads';

const ERROR_TYPES = [
  'MatriksConnectionError',
  'MatriksFieldNotFound',
  'Unspecified',
  'BarsDataError',
  'AccountNotFound',
  'AccountInformationUnavailable',
  'AccountFeedSilent',
  'OrderAccountMismatch',
];
const TRAFFIC_TYPES = ['routine', 'action', 'unexpected', 'error'];
const WIRE_DIRECTIONS = ['out', 'in'];
// Mirrors LOG_VALUE_COUNT_LIMIT and LOG_VALUE_FILTER_LIMIT in bistApi/logTypes.ts.
const VALUE_COUNT_LIMIT = 200;
const VALUE_FILTER_LIMIT = 500;

const SOURCE_CONFIG = {
  errors: {
    table: 'Errors',
    timeColumn: 'time',
    types: ERROR_TYPES,
    directionValues: null,
    valueFilters: [],
    columns: [
      ['id', 'INTEGER', 0, 1],
      ['time', 'INTEGER', 1, 0],
      ['type', 'TEXT', 1, 0],
      ['information', 'TEXT', 1, 0],
      ['accountId', 'TEXT', 0, 0],
      ['brokerageId', 'TEXT', 0, 0],
      ['context', 'TEXT', 0, 0],
    ],
  },
  wire: {
    table: 'WireLog',
    timeColumn: 'at',
    types: TRAFFIC_TYPES,
    directionValues: WIRE_DIRECTIONS,
    valueFilters: [
      {
        column: 'operation',
        queryKey: 'operations',
        resultKey: 'operationCounts',
        group: true,
        nullable: false,
      },
      {
        column: 'accountId',
        queryKey: 'accountIds',
        resultKey: 'accountIdCounts',
        group: false,
        nullable: true,
      },
    ],
    columns: [
      ['id', 'INTEGER', 0, 1],
      ['at', 'INTEGER', 1, 0],
      ['atText', 'TEXT', 1, 0],
      ['target', 'TEXT', 1, 0],
      ['direction', 'TEXT', 1, 0],
      ['type', 'TEXT', 1, 0],
      ['operation', 'TEXT', 1, 0],
      ['apiCommand', 'INTEGER', 0, 0],
      ['ref', 'INTEGER', 0, 0],
      ['latencyMs', 'INTEGER', 0, 0],
      ['accountId', 'TEXT', 0, 0],
      ['brokerageId', 'TEXT', 0, 0],
      ['symbol', 'TEXT', 0, 0],
      ['clientOrderId', 'TEXT', 0, 0],
      ['orderId', 'TEXT', 0, 0],
      ['ordStatus', 'TEXT', 0, 0],
      ['note', 'TEXT', 0, 0],
      ['body', 'TEXT', 0, 0],
      ['truncated', 'INTEGER', 1, 0],
    ],
  },
  api: {
    table: 'ApiLog',
    timeColumn: 'at',
    types: TRAFFIC_TYPES,
    directionValues: null,
    valueFilters: [
      { column: 'path', queryKey: 'paths', resultKey: 'pathCounts', group: true, nullable: false },
    ],
    columns: [
      ['id', 'INTEGER', 0, 1],
      ['at', 'INTEGER', 1, 0],
      ['atText', 'TEXT', 1, 0],
      ['type', 'TEXT', 1, 0],
      ['method', 'TEXT', 1, 0],
      ['path', 'TEXT', 1, 0],
      ['botId', 'TEXT', 0, 0],
      ['status', 'INTEGER', 0, 0],
      ['durationMs', 'INTEGER', 0, 0],
      ['requestBody', 'TEXT', 0, 0],
      ['responseBody', 'TEXT', 0, 0],
      ['errorType', 'TEXT', 0, 0],
      ['note', 'TEXT', 0, 0],
      ['truncated', 'INTEGER', 1, 0],
    ],
  },
};

class WorkerRequestError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'WorkerRequestError';
    this.code = code;
  }
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasOnlyKeys(value, allowed) {
  return Object.keys(value).every((key) => allowed.has(key));
}

function isSafeUnsignedInteger(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function isPositiveSafeInteger(value) {
  return isSafeUnsignedInteger(value) && value > 0;
}

function validateDatabasePaths(value) {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, new Set(['errors', 'wire', 'api'])) ||
    !Object.keys(SOURCE_CONFIG).every(
      (source) => typeof value[source] === 'string' && path.isAbsolute(value[source]),
    )
  ) {
    throw new Error('The logs worker requires three absolute server-owned database paths.');
  }
  return Object.freeze({
    errors: value.errors,
    wire: value.wire,
    api: value.api,
  });
}

const databasePaths = validateDatabasePaths(workerData?.databasePaths);

function validateQuery(value) {
  const keys = new Set([
    'source',
    'fromMs',
    'untilMs',
    'types',
    'directions',
    'operations',
    'paths',
    'accountIds',
    'limit',
    'beforeId',
  ]);
  if (!isRecord(value) || !hasOnlyKeys(value, keys)) {
    throw new WorkerRequestError(
      'INVALID_INPUT',
      'The log query must be a plain allowlisted object.',
    );
  }
  const config = SOURCE_CONFIG[value.source];
  if (!config) throw new WorkerRequestError('INVALID_INPUT', 'The log source is invalid.');
  if (!isSafeUnsignedInteger(value.fromMs) || !isSafeUnsignedInteger(value.untilMs)) {
    throw new WorkerRequestError(
      'INVALID_INPUT',
      'The log range must use safe epoch-millisecond integers.',
    );
  }
  if (value.fromMs >= value.untilMs) {
    throw new WorkerRequestError('INVALID_INPUT', 'The log range must have a positive width.');
  }
  if (!isPositiveSafeInteger(value.limit) || value.limit > 200) {
    throw new WorkerRequestError('INVALID_INPUT', 'The log page limit must be between 1 and 200.');
  }
  if (value.beforeId !== undefined && !isPositiveSafeInteger(value.beforeId)) {
    throw new WorkerRequestError(
      'INVALID_INPUT',
      'The log cursor must be a positive safe integer.',
    );
  }
  if (value.types !== undefined) {
    if (
      !Array.isArray(value.types) ||
      value.types.length === 0 ||
      value.types.length > config.types.length ||
      new Set(value.types).size !== value.types.length ||
      value.types.some((type) => !config.types.includes(type))
    ) {
      throw new WorkerRequestError('INVALID_INPUT', 'The selected log types are invalid.');
    }
  }
  const allowedValueFilterKeys = new Set(config.valueFilters.map((filter) => filter.queryKey));
  for (const key of ['operations', 'paths', 'accountIds']) {
    const values = value[key];
    if (values === undefined) continue;
    if (!allowedValueFilterKeys.has(key)) {
      throw new WorkerRequestError('INVALID_INPUT', `This log cannot be filtered by ${key}.`);
    }
    if (
      !Array.isArray(values) ||
      values.length > VALUE_FILTER_LIMIT ||
      values.some((item) => typeof item !== 'string') ||
      new Set(values).size !== values.length
    ) {
      throw new WorkerRequestError('INVALID_INPUT', `The selected log ${key} are invalid.`);
    }
  }
  if (value.directions !== undefined) {
    if (
      !config.directionValues ||
      !Array.isArray(value.directions) ||
      value.directions.length === 0 ||
      value.directions.length > config.directionValues.length ||
      new Set(value.directions).size !== value.directions.length ||
      value.directions.some((direction) => !config.directionValues.includes(direction))
    ) {
      throw new WorkerRequestError('INVALID_INPUT', 'The selected directions are invalid.');
    }
  }
  return value;
}

function validateMessage(value) {
  if (!isRecord(value) || !isPositiveSafeInteger(value.id)) {
    throw new WorkerRequestError('INVALID_INPUT', 'The logs worker request id is invalid.');
  }
  if (value.operation === 'extents') {
    if (!hasOnlyKeys(value, new Set(['id', 'operation']))) {
      throw new WorkerRequestError('INVALID_INPUT', 'The extents request has unknown fields.');
    }
    return value;
  }
  if (value.operation === 'query') {
    if (!hasOnlyKeys(value, new Set(['id', 'operation', 'query']))) {
      throw new WorkerRequestError('INVALID_INPUT', 'The query request has unknown fields.');
    }
    validateQuery(value.query);
    return value;
  }
  throw new WorkerRequestError('INVALID_INPUT', 'The logs worker operation is invalid.');
}

function quoteIdentifier(identifier) {
  return `"${identifier.replaceAll('"', '""')}"`;
}

function validateSchema(database, config) {
  const relation = database
    .prepare('SELECT type FROM sqlite_schema WHERE name = ? COLLATE BINARY')
    .get(config.table);
  if (relation?.type !== 'table') {
    throw new WorkerRequestError('SCHEMA_MISMATCH', `${config.table} is not the expected table.`);
  }
  const actualColumns = database
    .prepare(`PRAGMA table_info(${quoteIdentifier(config.table)})`)
    .all();
  if (actualColumns.length !== config.columns.length) {
    throw new WorkerRequestError(
      'SCHEMA_MISMATCH',
      `${config.table} does not have the expected number of columns.`,
    );
  }

  const byName = new Map(actualColumns.map((column) => [String(column.name), column]));
  for (const [name, type, notNull, primaryKey] of config.columns) {
    const actual = byName.get(name);
    if (
      !actual ||
      String(actual.type).toUpperCase() !== type ||
      Number(actual.notnull) !== notNull ||
      Number(actual.pk) !== primaryKey
    ) {
      throw new WorkerRequestError(
        'SCHEMA_MISMATCH',
        `${config.table}.${name} does not match the expected schema.`,
      );
    }
  }
}

function openDatabase(source) {
  let database;
  try {
    database = new DatabaseSync(databasePaths[source], {
      readOnly: true,
      timeout: 5_000,
    });
    database.exec('PRAGMA query_only = ON');
    const queryOnly = database.prepare('PRAGMA query_only').get();
    if (Number(queryOnly?.query_only) !== 1) {
      throw new Error('SQLite did not enable query_only mode.');
    }
    validateSchema(database, SOURCE_CONFIG[source]);
    return database;
  } catch (error) {
    try {
      database?.close();
    } catch {
      // Preserve the failure that made the database unusable.
    }
    if (error instanceof WorkerRequestError) throw error;
    throw new WorkerRequestError(
      'UNAVAILABLE',
      error instanceof Error ? error.message : String(error),
    );
  }
}

function closeDatabase(database) {
  try {
    database.close();
  } catch (error) {
    throw new WorkerRequestError(
      'UNAVAILABLE',
      error instanceof Error ? error.message : String(error),
    );
  }
}

function readCount(value, label) {
  if (!isSafeUnsignedInteger(value)) {
    throw new WorkerRequestError(
      'SCHEMA_MISMATCH',
      `${label} was not a safe non-negative integer.`,
    );
  }
  return value;
}

function readExtent(database, config) {
  const table = quoteIdentifier(config.table);
  const time = quoteIdentifier(config.timeColumn);
  const row = database
    .prepare(`SELECT MIN(${time}) AS minMs, MAX(${time}) AS maxMs FROM ${table}`)
    .get();
  const minMs = row?.minMs ?? null;
  const maxMs = row?.maxMs ?? null;
  if (
    (minMs !== null && !isSafeUnsignedInteger(minMs)) ||
    (maxMs !== null && !isSafeUnsignedInteger(maxMs)) ||
    (minMs === null) !== (maxMs === null) ||
    (minMs !== null && maxMs !== null && minMs > maxMs)
  ) {
    throw new WorkerRequestError('SCHEMA_MISMATCH', `${config.table} has an invalid time extent.`);
  }
  return { minMs, maxMs };
}

/**
 * The quotes producer's path carries its query string in `operation`
 * (`/api/quotes?symbols=...`) — one call per distinct symbol set, which would
 * otherwise turn a handful of endpoints into hundreds of one-off filter
 * options. Grouping and filtering both key on the part before `?`, so
 * `/api/quotes` is one option however many symbol lists it was called with.
 */
function valueGroupExpression(column) {
  const quoted = quoteIdentifier(column);
  return `CASE WHEN instr(${quoted}, '?') > 0 THEN substr(${quoted}, 1, instr(${quoted}, '?') - 1) ELSE ${quoted} END`;
}

function readValueCounts(database, config, filter, clauses, params) {
  const table = quoteIdentifier(config.table);
  const group = filter.group ? valueGroupExpression(filter.column) : quoteIdentifier(filter.column);
  const label = `${config.table}.${filter.column}`;
  const allClauses = filter.nullable
    ? [...clauses, `${quoteIdentifier(filter.column)} IS NOT NULL`]
    : clauses;
  const rows = database
    .prepare(
      `SELECT ${group} AS value, COUNT(*) AS count
         FROM ${table}
        WHERE ${allClauses.join(' AND ')}
        GROUP BY ${group}
        ORDER BY COUNT(*) DESC, ${group}
        LIMIT ?`,
    )
    .all(...params, VALUE_COUNT_LIMIT + 1);
  const values = rows.slice(0, VALUE_COUNT_LIMIT).map((row) => {
    if (typeof row.value !== 'string') {
      throw new WorkerRequestError('SCHEMA_MISMATCH', `${label} holds a value that is not text.`);
    }
    return { value: row.value, count: readCount(row.count, `${label} count`) };
  });
  return { values, complete: rows.length <= VALUE_COUNT_LIMIT };
}

function querySource(query) {
  const config = SOURCE_CONFIG[query.source];
  const database = openDatabase(query.source);
  try {
    database.exec('BEGIN');
    try {
      const table = quoteIdentifier(config.table);
      const time = quoteIdentifier(config.timeColumn);
      const rangeClauses = [`${time} >= ?`, `${time} < ?`];
      const rangeParams = [query.fromMs, query.untilMs];
      const matchingClauses = [...rangeClauses];
      const matchingParams = [...rangeParams];

      if (query.types !== undefined) {
        matchingClauses.push(
          `${quoteIdentifier('type')} IN (${query.types.map(() => '?').join(', ')})`,
        );
        matchingParams.push(...query.types);
      }

      if (query.directions !== undefined) {
        matchingClauses.push(
          `${quoteIdentifier('direction')} IN (${query.directions.map(() => '?').join(', ')})`,
        );
        matchingParams.push(...query.directions);
      }

      for (const filter of config.valueFilters) {
        const selectedValues = query[filter.queryKey];
        if (selectedValues === undefined) continue;
        // An empty selection is the deliberate none: no row matches it.
        matchingClauses.push(
          selectedValues.length === 0
            ? '0'
            : `${filter.group ? valueGroupExpression(filter.column) : quoteIdentifier(filter.column)} IN (${selectedValues.map(() => '?').join(', ')})`,
        );
        matchingParams.push(...selectedValues);
      }

      const pageClauses = [...matchingClauses];
      const pageParams = [...matchingParams];
      if (query.beforeId !== undefined) {
        pageClauses.push(`${quoteIdentifier('id')} < ?`);
        pageParams.push(query.beforeId);
      }

      const selectedColumns = config.columns.map(([name]) => quoteIdentifier(name)).join(', ');
      const rows = database
        .prepare(
          `SELECT ${selectedColumns}
             FROM ${table}
            WHERE ${pageClauses.join(' AND ')}
            ORDER BY ${time} DESC, ${quoteIdentifier('id')} DESC
            LIMIT ?`,
        )
        .all(...pageParams, query.limit);

      const totalRow = database
        .prepare(
          `SELECT COUNT(*) AS total
             FROM ${table}
            WHERE ${matchingClauses.join(' AND ')}`,
        )
        .get(...matchingParams);
      const total = readCount(totalRow?.total, `${config.table} total`);

      const countsByType = Object.fromEntries(config.types.map((type) => [type, 0]));
      const countRows = database
        .prepare(
          `SELECT ${quoteIdentifier('type')} AS type, COUNT(*) AS count
             FROM ${table}
            WHERE ${rangeClauses.join(' AND ')}
            GROUP BY ${quoteIdentifier('type')}`,
        )
        .all(...rangeParams);
      for (const row of countRows) {
        if (typeof row.type !== 'string' || !config.types.includes(row.type)) {
          throw new WorkerRequestError(
            'SCHEMA_MISMATCH',
            `${config.table} contains an unsupported type in the selected range.`,
          );
        }
        countsByType[row.type] = readCount(row.count, `${config.table} type count`);
      }

      const result = { source: query.source, rows, total, countsByType };

      if (config.directionValues) {
        const countsByDirection = Object.fromEntries(
          config.directionValues.map((direction) => [direction, 0]),
        );
        const directionCountRows = database
          .prepare(
            `SELECT ${quoteIdentifier('direction')} AS direction, COUNT(*) AS count
               FROM ${table}
              WHERE ${rangeClauses.join(' AND ')}
              GROUP BY ${quoteIdentifier('direction')}`,
          )
          .all(...rangeParams);
        for (const row of directionCountRows) {
          if (
            typeof row.direction !== 'string' ||
            !config.directionValues.includes(row.direction)
          ) {
            throw new WorkerRequestError(
              'SCHEMA_MISMATCH',
              `${config.table} contains an unsupported direction in the selected range.`,
            );
          }
          countsByDirection[row.direction] = readCount(
            row.count,
            `${config.table} direction count`,
          );
        }
        result.countsByDirection = countsByDirection;
      }

      for (const filter of config.valueFilters) {
        result[filter.resultKey] = readValueCounts(
          database,
          config,
          filter,
          rangeClauses,
          rangeParams,
        );
      }

      result.extent = readExtent(database, config);
      database.exec('COMMIT');
      return result;
    } catch (error) {
      try {
        database.exec('ROLLBACK');
      } catch {
        // Preserve the query or schema failure.
      }
      throw error;
    }
  } catch (error) {
    if (error instanceof WorkerRequestError) throw error;
    throw new WorkerRequestError(
      'UNAVAILABLE',
      error instanceof Error ? error.message : String(error),
    );
  } finally {
    closeDatabase(database);
  }
}

function queryExtents() {
  const result = {};
  for (const source of Object.keys(SOURCE_CONFIG)) {
    const database = openDatabase(source);
    try {
      result[source] = readExtent(database, SOURCE_CONFIG[source]);
    } finally {
      closeDatabase(database);
    }
  }
  return result;
}

parentPort.on('message', (rawMessage) => {
  let id = isRecord(rawMessage) && isPositiveSafeInteger(rawMessage.id) ? rawMessage.id : 0;
  try {
    const message = validateMessage(rawMessage);
    id = message.id;
    const result = message.operation === 'query' ? querySource(message.query) : queryExtents();
    parentPort.postMessage({ id, result });
  } catch (error) {
    parentPort.postMessage({
      id,
      error: {
        code: error instanceof WorkerRequestError ? error.code : 'UNAVAILABLE',
        message: error instanceof Error ? error.message : String(error),
      },
    });
  }
});
