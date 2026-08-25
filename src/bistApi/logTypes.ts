import { z } from 'zod';

export const logSourceSchema = z.enum(['errors', 'wire', 'api']);
export const trafficLogTypeSchema = z.enum(['routine', 'action', 'unexpected', 'error']);
export const storedErrorTypeSchema = z.enum([
  'MatriksConnectionError',
  'MatriksFieldNotFound',
  'Unspecified',
  'BarsDataError',
  'AccountNotFound',
  'AccountInformationUnavailable',
  'AccountFeedSilent',
  'OrderAccountMismatch',
]);

export const trafficLogTypes = trafficLogTypeSchema.options;
export const storedErrorTypes = storedErrorTypeSchema.options;

export type LogSource = z.infer<typeof logSourceSchema>;
export type TrafficLogType = z.infer<typeof trafficLogTypeSchema>;
export type StoredErrorType = z.infer<typeof storedErrorTypeSchema>;

const safeUnsignedIntegerSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const positiveSafeIntegerSchema = safeUnsignedIntegerSchema.min(1);
const pageLimitSchema = positiveSafeIntegerSchema.max(200).default(100);

const queryWindowShape = {
  fromMs: safeUnsignedIntegerSchema,
  untilMs: safeUnsignedIntegerSchema,
  limit: pageLimitSchema,
  beforeId: positiveSafeIntegerSchema.optional(),
};

const errorsLogQuerySchema = z
  .object({
    source: z.literal('errors'),
    ...queryWindowShape,
    types: z.array(storedErrorTypeSchema).min(1).max(storedErrorTypes.length).optional(),
  })
  .strict();

const wireLogQuerySchema = z
  .object({
    source: z.literal('wire'),
    ...queryWindowShape,
    types: z.array(trafficLogTypeSchema).min(1).max(trafficLogTypes.length).optional(),
  })
  .strict();

const apiLogQuerySchema = z
  .object({
    source: z.literal('api'),
    ...queryWindowShape,
    types: z.array(trafficLogTypeSchema).min(1).max(trafficLogTypes.length).optional(),
  })
  .strict();

export const logQuerySchema = z
  .discriminatedUnion('source', [errorsLogQuerySchema, wireLogQuerySchema, apiLogQuerySchema])
  .superRefine((query, context) => {
    if (query.fromMs >= query.untilMs) {
      context.addIssue({
        code: 'custom',
        path: ['untilMs'],
        message: 'untilMs must be later than fromMs.',
      });
    }
    if (query.types && new Set(query.types).size !== query.types.length) {
      context.addIssue({
        code: 'custom',
        path: ['types'],
        message: 'Log types must not be repeated.',
      });
    }
  });

export type LogQueryInput = z.input<typeof logQuerySchema>;
export type LogQuery = z.output<typeof logQuerySchema>;
export type ErrorLogQueryInput = z.input<typeof errorsLogQuerySchema>;
export type WireLogQueryInput = z.input<typeof wireLogQuerySchema>;
export type ApiLogQueryInput = z.input<typeof apiLogQuerySchema>;
export type ErrorLogQuery = z.output<typeof errorsLogQuerySchema>;
export type WireLogQuery = z.output<typeof wireLogQuerySchema>;
export type ApiLogQuery = z.output<typeof apiLogQuerySchema>;

export const logExtentSchema = z
  .object({
    minMs: safeUnsignedIntegerSchema.nullable(),
    maxMs: safeUnsignedIntegerSchema.nullable(),
  })
  .strict()
  .superRefine((extent, context) => {
    if ((extent.minMs === null) !== (extent.maxMs === null)) {
      context.addIssue({
        code: 'custom',
        message: 'A log extent must have both bounds or neither bound.',
      });
    }
    if (extent.minMs !== null && extent.maxMs !== null && extent.minMs > extent.maxMs) {
      context.addIssue({
        code: 'custom',
        message: 'A log extent cannot run backwards.',
      });
    }
  });

export const logExtentsSchema = z
  .object({
    errors: logExtentSchema,
    wire: logExtentSchema,
    api: logExtentSchema,
  })
  .strict();

export type LogExtent = z.infer<typeof logExtentSchema>;
export type LogExtents = z.infer<typeof logExtentsSchema>;

export const errorLogRowSchema = z
  .object({
    id: positiveSafeIntegerSchema,
    time: safeUnsignedIntegerSchema,
    type: storedErrorTypeSchema,
    information: z.string(),
    accountId: z.string().nullable(),
    brokerageId: z.string().nullable(),
    context: z.string().nullable(),
  })
  .strict();

export const wireLogRowSchema = z
  .object({
    id: positiveSafeIntegerSchema,
    at: safeUnsignedIntegerSchema,
    atText: z.string(),
    target: z.enum(['matriks', 'quotes']),
    direction: z.enum(['out', 'in']),
    type: trafficLogTypeSchema,
    operation: z.string(),
    apiCommand: z.number().int().nullable(),
    ref: positiveSafeIntegerSchema.nullable(),
    latencyMs: safeUnsignedIntegerSchema.nullable(),
    accountId: z.string().nullable(),
    brokerageId: z.string().nullable(),
    symbol: z.string().nullable(),
    clientOrderId: z.string().nullable(),
    orderId: z.string().nullable(),
    ordStatus: z.string().nullable(),
    note: z.string().nullable(),
    body: z.string().nullable(),
    truncated: z.union([z.literal(0), z.literal(1)]),
  })
  .strict();

export const apiLogRowSchema = z
  .object({
    id: positiveSafeIntegerSchema,
    at: safeUnsignedIntegerSchema,
    atText: z.string(),
    type: trafficLogTypeSchema,
    method: z.string(),
    path: z.string(),
    botId: z.string().nullable(),
    status: z.number().int().min(100).max(599).nullable(),
    durationMs: safeUnsignedIntegerSchema.nullable(),
    requestBody: z.string().nullable(),
    responseBody: z.string().nullable(),
    errorType: z.string().nullable(),
    note: z.string().nullable(),
    truncated: z.union([z.literal(0), z.literal(1)]),
  })
  .strict();

export type ErrorLogRow = z.infer<typeof errorLogRowSchema>;
export type WireLogRow = z.infer<typeof wireLogRowSchema>;
export type ApiLogRow = z.infer<typeof apiLogRowSchema>;

const storedErrorCountsSchema = z
  .object({
    MatriksConnectionError: safeUnsignedIntegerSchema,
    MatriksFieldNotFound: safeUnsignedIntegerSchema,
    Unspecified: safeUnsignedIntegerSchema,
    BarsDataError: safeUnsignedIntegerSchema,
    AccountNotFound: safeUnsignedIntegerSchema,
    AccountInformationUnavailable: safeUnsignedIntegerSchema,
    AccountFeedSilent: safeUnsignedIntegerSchema,
    OrderAccountMismatch: safeUnsignedIntegerSchema,
  })
  .strict();

const trafficLogCountsSchema = z
  .object({
    routine: safeUnsignedIntegerSchema,
    action: safeUnsignedIntegerSchema,
    unexpected: safeUnsignedIntegerSchema,
    error: safeUnsignedIntegerSchema,
  })
  .strict();

const resultMetadataShape = {
  total: safeUnsignedIntegerSchema,
  extent: logExtentSchema,
};

const errorLogQueryResultSchema = z
  .object({
    source: z.literal('errors'),
    rows: z.array(errorLogRowSchema).max(200),
    countsByType: storedErrorCountsSchema,
    ...resultMetadataShape,
  })
  .strict();

const wireLogQueryResultSchema = z
  .object({
    source: z.literal('wire'),
    rows: z.array(wireLogRowSchema).max(200),
    countsByType: trafficLogCountsSchema,
    ...resultMetadataShape,
  })
  .strict();

const apiLogQueryResultSchema = z
  .object({
    source: z.literal('api'),
    rows: z.array(apiLogRowSchema).max(200),
    countsByType: trafficLogCountsSchema,
    ...resultMetadataShape,
  })
  .strict();

export const logQueryResultSchema = z.discriminatedUnion('source', [
  errorLogQueryResultSchema,
  wireLogQueryResultSchema,
  apiLogQueryResultSchema,
]);

export type ErrorLogQueryResult = z.infer<typeof errorLogQueryResultSchema>;
export type WireLogQueryResult = z.infer<typeof wireLogQueryResultSchema>;
export type ApiLogQueryResult = z.infer<typeof apiLogQueryResultSchema>;
export type LogQueryResult = z.infer<typeof logQueryResultSchema>;
