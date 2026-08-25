import type {
  ApiLogQueryResult,
  ErrorLogQueryResult,
  LogExtents,
  LogQueryResult,
  LogSource,
  WireLogQueryResult,
} from '../../bistApi/logTypes';

export const FIXTURE_LOG_DAY_START_MS = Date.parse('2026-08-24T21:00:00.000Z');

const errorCounts = {
  MatriksConnectionError: 0,
  MatriksFieldNotFound: 0,
  Unspecified: 1,
  BarsDataError: 0,
  AccountNotFound: 0,
  AccountInformationUnavailable: 0,
  AccountFeedSilent: 0,
  OrderAccountMismatch: 0,
};

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
    extent: extents.api,
  };

  return { extents, results: { errors, wire, api } };
}
