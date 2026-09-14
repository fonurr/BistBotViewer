import { storedErrorTypes } from '../../bistApi/logTypes';
import type {
  ApiLogQueryResult,
  ErrorLogQueryResult,
  LogExtents,
  LogQueryResult,
  LogSource,
  WireLogQueryResult,
} from '../../bistApi/logTypes';

export const FIXTURE_LOG_DAY_START_MS = Date.parse('2026-08-24T21:00:00.000Z');

/** Every known type counted, as the worker answers: zero where the range is empty. */
export function zeroErrorCounts(): ErrorLogQueryResult['countsByType'] {
  return Object.fromEntries(
    storedErrorTypes.map((type) => [type, 0]),
  ) as ErrorLogQueryResult['countsByType'];
}

const errorCounts = { ...zeroErrorCounts(), Unspecified: 1 };

const trafficCounts = {
  routine: 1,
  action: 0,
  unexpected: 0,
  error: 0,
};

export interface LogReadFixture {
  extents: LogExtents;
  results: Record<LogSource, LogQueryResult>;
}

export function makeLogReadFixture(): LogReadFixture {
  const extents: LogExtents = {
    errors: {
      minMs: FIXTURE_LOG_DAY_START_MS + 3_000,
      maxMs: FIXTURE_LOG_DAY_START_MS + 3_000,
    },
    wire: {
      minMs: FIXTURE_LOG_DAY_START_MS + 2_000,
      maxMs: FIXTURE_LOG_DAY_START_MS + 2_000,
    },
    api: {
      minMs: FIXTURE_LOG_DAY_START_MS + 1_000,
      maxMs: FIXTURE_LOG_DAY_START_MS + 1_000,
    },
  };

  const errors: ErrorLogQueryResult = {
    source: 'errors',
    rows: [
      {
        id: 3,
        time: FIXTURE_LOG_DAY_START_MS + 3_000,
        type: 'Unspecified',
        information: 'Deterministic read-only log fixture',
        accountId: null,
        brokerageId: null,
        context: null,
      },
    ],
    total: 1,
    countsByType: errorCounts,
    extent: extents.errors,
  };

  const wire: WireLogQueryResult = {
    source: 'wire',
    rows: [
      {
        id: 2,
        at: FIXTURE_LOG_DAY_START_MS + 2_000,
        atText: '2026-08-25 00:00:02.000',
        target: 'matriks',
        direction: 'in',
        type: 'routine',
        operation: 'GetBots',
        apiCommand: 1,
        ref: null,
        latencyMs: 4,
        accountId: null,
        brokerageId: null,
        symbol: null,
        clientOrderId: null,
        orderId: null,
        ordStatus: null,
        note: 'fixture reply',
        body: '[]',
        truncated: 0,
      },
    ],
    total: 1,
    countsByType: trafficCounts,
    countsByDirection: { out: 0, in: 1 },
    operationCounts: { values: [{ value: 'GetBots', count: 1 }], complete: true },
    accountIdCounts: { values: [], complete: true },
    extent: extents.wire,
  };

  const api: ApiLogQueryResult = {
    source: 'api',
    rows: [
      {
        id: 1,
        at: FIXTURE_LOG_DAY_START_MS + 1_000,
        atText: '2026-08-25 00:00:01.000',
        type: 'routine',
        method: 'POST',
        path: '/api/GetBots',
        botId: null,
        status: 200,
        durationMs: 3,
        requestBody: '{}',
        responseBody: '[]',
        errorType: null,
        note: 'fixture reply',
        truncated: 0,
      },
    ],
    total: 1,
    countsByType: trafficCounts,
    pathCounts: { values: [{ value: '/api/GetBots', count: 1 }], complete: true },
    extent: extents.api,
  };

  return { extents, results: { errors, wire, api } };
}
