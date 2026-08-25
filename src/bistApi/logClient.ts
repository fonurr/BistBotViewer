import { z } from 'zod';

import { BistApiError } from './errors';
import {
  logExtentsSchema,
  logQueryResultSchema,
  logQuerySchema,
  type ApiLogQueryInput,
  type ApiLogQueryResult,
  type ErrorLogQueryInput,
  type ErrorLogQueryResult,
  type LogExtents,
  type LogQuery,
  type LogQueryInput,
  type LogQueryResult,
  type WireLogQueryInput,
  type WireLogQueryResult,
} from './logTypes';

const logsBase = '/bridge/bist/logs';
const errorEnvelopeSchema = z
  .object({
    type: z.string().optional(),
    information: z.string().optional(),
  })
  .passthrough();

async function request<T>(path: string, schema: z.ZodType<T>, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${logsBase}/${path}`, {
      credentials: 'same-origin',
      headers: {
        Accept: 'application/json',
        ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
        ...init?.headers,
      },
      signal: AbortSignal.timeout(15_000),
      ...init,
    });
  } catch (error) {
    throw new BistApiError({
      message: 'The local log databases did not answer this read.',
      kind: 'unavailable',
      type: 'LogDatabaseUnavailable',
      cause: error,
    });
  }

  const raw = await response.text();
  let payload: unknown;
  try {
    payload = raw.length === 0 ? {} : (JSON.parse(raw) as unknown);
  } catch (error) {
    throw new BistApiError({
      message: 'The log bridge returned unreadable JSON.',
      kind: 'protocol',
      type: 'UnreadableReply',
      status: response.status,
      cause: error,
    });
  }

  if (!response.ok) {
    const parsed = errorEnvelopeSchema.safeParse(payload);
    const envelope = parsed.success ? parsed.data : {};
    throw new BistApiError({
      message: envelope.information ?? `The log bridge returned HTTP ${response.status}.`,
      kind: response.status === 503 ? 'unavailable' : 'refused',
      type: envelope.type ?? 'LogQueryFailed',
      status: response.status,
    });
  }

  const parsed = schema.safeParse(payload);
  if (!parsed.success) {
    throw new BistApiError({
      message: 'The log bridge returned data this viewer cannot safely interpret.',
      kind: 'protocol',
      type: 'UnreadableReply',
      status: response.status,
      cause: parsed.error,
    });
  }
  return parsed.data;
}

function validatedQuery(input: LogQueryInput): LogQuery {
  const parsed = logQuerySchema.safeParse(input);
  if (!parsed.success) {
    throw new BistApiError({
      message: 'The log query is invalid.',
      kind: 'refused',
      type: 'BadRequest',
      cause: parsed.error,
    });
  }
  return parsed.data;
}

function queryLogs(input: ErrorLogQueryInput): Promise<ErrorLogQueryResult>;
function queryLogs(input: WireLogQueryInput): Promise<WireLogQueryResult>;
function queryLogs(input: ApiLogQueryInput): Promise<ApiLogQueryResult>;
function queryLogs(input: LogQueryInput): Promise<LogQueryResult>;
async function queryLogs(input: LogQueryInput): Promise<LogQueryResult> {
  const query = validatedQuery(input);
  const result = await request('query', logQueryResultSchema, {
    method: 'POST',
    body: JSON.stringify(query),
  });
  if (result.source !== query.source) {
    throw new BistApiError({
      message: 'The log bridge returned data for the wrong log source.',
      kind: 'protocol',
      type: 'UnreadableReply',
    });
  }
  return result;
}

export const logClient = {
  extents: (): Promise<LogExtents> => request('extents', logExtentsSchema),
  query: queryLogs,
};
