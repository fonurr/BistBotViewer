import { z } from 'zod';

export const botIdSchema = z.string().min(1);
export const directionSchema = z.enum(['buy', 'sell']);
export const orderTypeSchema = z.enum(['limit', 'market']);
export const scheduleTypeSchema = z.enum([
  'OpeningAuction',
  'AtOpen',
  'AfterOpen',
  'BeforeClose',
  'ClosingAuction',
]);
export const whenTypeSchema = z.enum([
  'OpeningAuction',
  'AtOpen',
  'AfterOpen',
  'BeforeClose',
  'ClosingAuction',
  'Retry',
  'AfterHours',
]);
// Matriks' readable OrdStatus values are intentionally open-ended at the upstream
// boundary. Known transient values are normalized for display in domain/status.ts;
// a future wire value must degrade one row, never reject the entire table response.
export const orderStatusSchema = z.string().trim().min(1);

export type Direction = z.infer<typeof directionSchema>;
export type OrderType = z.infer<typeof orderTypeSchema>;
export type OrderStatus = z.infer<typeof orderStatusSchema>;
export type ScheduleType = z.infer<typeof scheduleTypeSchema>;
export type WhenType = z.infer<typeof whenTypeSchema>;
export type BotSelector = string | readonly string[] | '*';

export const scheduleSpecSchema = z
  .object({
    day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    type: scheduleTypeSchema,
    diff: z.number().nonnegative().optional(),
  })
  .strict();

export type ScheduleSpec = z.infer<typeof scheduleSpecSchema>;

export const priceBaseSchema = z.enum(['previousClose', 'orderPrice', 'actualPrice']);
export type PriceBase = z.infer<typeof priceBaseSchema>;

/**
 * What a scheduled buy does at its fire time when no price can be trusted:
 * send it unguarded, drop it, or keep waiting that many minutes for one.
 */
export const whenPriceFeedDownSchema = z.union([
  z.enum(['buy', 'cancel']),
  z.number().int().min(1).max(600),
]);
export type WhenPriceFeedDown = z.infer<typeof whenPriceFeedDownSchema>;

/**
 * A price rule is a signed percentage against a base, never a lira figure. A
 * percentage read off the previous close is bounded by the exchange's own
 * ±10% daily cap, because outside it the rule could never fire; one read off
 * the order or the fill only has to be a sane number. Zero is never a limit.
 */
export const BAND_LIMIT_PERCENT = 10;
export const SANITY_LIMIT_PERCENT = 100;

function limitPercent(bound: number) {
  return z
    .number()
    .min(-bound)
    .max(bound)
    .refine((value) => value !== 0, { message: 'A limit of 0 is not a limit.' });
}

/** Where a buy may be filled. Buy-only, and refused on an Opening auction. */
export const openPriceRuleSchema = z
  .object({
    upperLimit: limitPercent(BAND_LIMIT_PERCENT).optional(),
    lowerLimit: limitPercent(BAND_LIMIT_PERCENT).optional(),
    whenPriceFeedDown: whenPriceFeedDownSchema.optional(),
  })
  .strict()
  .refine((rule) => Object.values(rule).some((value) => value !== undefined), {
    message: 'An entry band must name a limit, or what to do without a price.',
  })
  .refine(
    (rule) =>
      rule.upperLimit === undefined ||
      rule.lowerLimit === undefined ||
      rule.lowerLimit < rule.upperLimit,
    { message: "The entry band's lower limit must be below its upper limit." },
  );

export type OpenPriceRule = z.infer<typeof openPriceRuleSchema>;

export const priceTargetSchema = z
  .object({ limit: z.number(), base: priceBaseSchema })
  .strict()
  .refine((target) => target.limit !== 0, { message: 'A limit of 0 is not a limit.' })
  .refine(
    (target) =>
      Math.abs(target.limit) <=
      (target.base === 'previousClose' ? BAND_LIMIT_PERCENT : SANITY_LIMIT_PERCENT),
    { message: 'The percentage is outside what its base allows.' },
  );

export type PriceTarget = z.infer<typeof priceTargetSchema>;

/** Where the position a buy opens is closed again. Buy-only. */
export const closePriceRuleSchema = z
  .object({ takeProfit: priceTargetSchema.optional(), stopLoss: priceTargetSchema.optional() })
  .strict()
  .refine((rule) => rule.takeProfit !== undefined || rule.stopLoss !== undefined, {
    message: 'Exit targets must name at least one of a take profit and a stop loss.',
  })
  .refine(
    (rule) =>
      rule.takeProfit === undefined ||
      rule.stopLoss === undefined ||
      rule.takeProfit.base !== rule.stopLoss.base ||
      rule.stopLoss.limit < rule.takeProfit.limit,
    {
      message:
        'The stop loss must be below the take profit when both are measured against the same price.',
    },
  );

export type ClosePriceRule = z.infer<typeof closePriceRuleSchema>;

/**
 * How a stored rule comes back: the JSON the request supplied, echoed
 * verbatim. It is read as text today, so this stays deliberately lenient —
 * like `orderStatusSchema`, a shape we do not recognize must cost one rule,
 * never the whole table read. `domain/priceRules.ts` decides what it means.
 */
export const storedPriceRuleSchema = z
  .union([z.string(), z.object({}).passthrough()])
  .nullable()
  .optional();

export type StoredPriceRule = z.infer<typeof storedPriceRuleSchema>;

/** An explicit `null` clears a stored rule; that is the only way to disarm one. */
const writtenOpenPriceSchema = openPriceRuleSchema.nullable().optional();
const writtenClosePriceSchema = closePriceRuleSchema.nullable().optional();

/** Whether a rule would guard a price, as opposed to only naming a fallback. */
export function hasBandLimits(rule: OpenPriceRule | null | undefined): boolean {
  return (
    rule !== null &&
    rule !== undefined &&
    (rule.upperLimit !== undefined || rule.lowerLimit !== undefined)
  );
}

export const botSchema = z
  .object({
    id: botIdSchema,
    algoritmId: z.string().nullable(),
    accountId: z.string().nullable(),
    brokerageId: z.string().nullable(),
    limitPercentage: z.number(),
    limit: z.number(),
    limitPerPosition: z.number(),
    limitPercentagePerPosition: z.number(),
    emails: z.array(z.string()).nullable(),
    forbiddenStocks: z.array(z.string()),
    active: z.boolean(),
    description: z.string().nullable(),
    complete: z.boolean(),
  })
  .passthrough();

export type Bot = z.infer<typeof botSchema>;

export const accountSchema = z
  .object({
    accountId: z.string(),
    owner: z.string(),
    brokerageId: z.string(),
    brokerageName: z.string(),
  })
  .passthrough();

export type Account = z.infer<typeof accountSchema>;

const chainLinksSchema = z.object({
  chainId: z.string().nullable(),
  parentClientOrderId: z.string().nullable().optional(),
  retryOfClientOrderId: z.string().nullable(),
});

export const activeOrderSchema = z
  .object({
    id: z.number(),
    botId: botIdSchema,
    clientOrderId: z.string(),
    matriksOrderId: z.string().nullable(),
    matriksOrderId2: z.string().nullable(),
    symbol: z.string(),
    orderTime: z.number().nullable(),
    sentTime: z.number().nullable(),
    orderQuantity: z.number().int().nullable(),
    filledQuantity: z.number().int(),
    direction: directionSchema,
    type: orderTypeSchema,
    orderPrice: z.number().nullable(),
    averagePrice: z.number(),
    timeInForce: z.string(),
    status: orderStatusSchema,
    cancelSource: z.enum(['bot', 'server', 'user']).nullable(),
    retryCount: z.number().int(),
    intentType: orderTypeSchema,
    cancelAtFloor: z.boolean(),
    scheduledTime: z.number().nullable().optional(),
    whenType: whenTypeSchema.nullable().optional(),
    openPrice: storedPriceRuleSchema,
    closePrice: storedPriceRuleSchema,
  })
  .merge(chainLinksSchema)
  .passthrough();

export type ActiveOrder = z.infer<typeof activeOrderSchema>;

export const canceledOrderSchema = z
  .object({
    id: z.number(),
    botId: botIdSchema,
    clientOrderId: z.string().nullable(),
    matriksOrderId: z.string().nullable(),
    matriksOrderId2: z.string().nullable(),
    symbol: z.string(),
    orderTime: z.number().nullable(),
    sentTime: z.number().nullable(),
    cancelTime: z.number().nullable(),
    orderQuantity: z.number().int(),
    canceledQuantity: z.number().int(),
    direction: directionSchema,
    type: orderTypeSchema,
    orderPrice: z.number().nullable(),
    timeInForce: z.string(),
    status: orderStatusSchema,
    explanation: z.string().nullable(),
    reason: z.string().nullable(),
    retryCount: z.number().int(),
    intentType: orderTypeSchema,
    cancelAtFloor: z.boolean(),
    openPrice: storedPriceRuleSchema,
    closePrice: storedPriceRuleSchema,
  })
  .merge(chainLinksSchema)
  .passthrough();

export type CanceledOrder = z.infer<typeof canceledOrderSchema>;

export const positionSchema = z
  .object({
    id: z.number(),
    botId: botIdSchema,
    clientOrderId: z.string().nullable(),
    matriksOrderId: z.string().nullable(),
    matriksOrderId2: z.string().nullable(),
    positionId: z.string().nullable(),
    symbol: z.string(),
    orderTime: z.number().nullable(),
    executeTime: z.number().nullable(),
    orderQuantity: z.number().int(),
    quantity: z.number().int(),
    averagePrice: z.number(),
    orderPrice: z.number(),
    closePrice: storedPriceRuleSchema,
    chainId: z.string().nullable(),
    retryOfClientOrderId: z.string().nullable(),
  })
  .passthrough();

export type Position = z.infer<typeof positionSchema>;

export const closedTradeSchema = z
  .object({
    id: z.number(),
    botId: botIdSchema,
    accountId: z.string(),
    brokerageId: z.string(),
    clientOpenOrderId: z.string().nullable(),
    matriksOpenOrderId: z.string().nullable(),
    matriksOpenOrderId2: z.string().nullable(),
    clientCloseOrderId: z.string().nullable(),
    matriksCloseOrderId: z.string().nullable(),
    matriksCloseOrderId2: z.string().nullable(),
    positionId: z.string().nullable(),
    symbol: z.string(),
    openOrderTime: z.number().nullable(),
    openExecuteTime: z.number().nullable(),
    closeOrderTime: z.number().nullable(),
    closeExecuteTime: z.number().nullable(),
    quantity: z.number().int(),
    averageOpenPrice: z.number(),
    averageClosePrice: z.number(),
    openOrderPrice: z.number(),
    closeOrderPrice: z.number().nullable(),
    chainId: z.string().nullable(),
    openRetryOfClientOrderId: z.string().nullable(),
    closeRetryOfClientOrderId: z.string().nullable(),
  })
  .passthrough();

export type ClosedTrade = z.infer<typeof closedTradeSchema>;

export const sendStockSchema = z
  .object({
    symbol: z.string().min(1),
    price: z.number().positive().optional(),
    quantity: z.number().int().positive().optional(),
    openTime: scheduleSpecSchema.optional(),
    closeTime: scheduleSpecSchema.optional(),
    cancelAtFloor: z.boolean().optional(),
    openPrice: writtenOpenPriceSchema,
    closePrice: writtenClosePriceSchema,
  })
  .strict();

export const sendOrdersRequestSchema = z
  .object({
    botId: botIdSchema,
    direction: directionSchema,
    type: orderTypeSchema,
    budget: z.number().positive().optional(),
    budgetPercentage: z.number().positive().optional(),
    budgetPerStock: z.number().positive().optional(),
    budgetPercentagePerStock: z.number().positive().optional(),
    openTime: scheduleSpecSchema.optional(),
    closeTime: scheduleSpecSchema.optional(),
    openPrice: writtenOpenPriceSchema,
    closePrice: writtenClosePriceSchema,
    stocks: z.array(sendStockSchema).min(1),
  })
  .strict()
  .superRefine((request, context) => {
    if (request.direction === 'sell') {
      if (
        request.budget !== undefined ||
        request.budgetPercentage !== undefined ||
        request.budgetPerStock !== undefined ||
        request.budgetPercentagePerStock !== undefined ||
        request.openTime !== undefined
      ) {
        context.addIssue({
          code: 'custom',
          message: 'Sell requests cannot carry buy budgets or openTime.',
        });
      }
      if (request.openPrice !== undefined || request.closePrice !== undefined) {
        context.addIssue({
          code: 'custom',
          message:
            'Sell requests cannot carry price rules: both describe a position and the buy that opens it.',
        });
      }
    }
    request.stocks.forEach((stock, index) => {
      if ((request.direction === 'buy' || request.type === 'limit') && stock.price === undefined) {
        context.addIssue({
          code: 'custom',
          path: ['stocks', index, 'price'],
          message: 'This order requires a positive price.',
        });
      }
      if (request.direction === 'sell' && stock.openTime !== undefined) {
        context.addIssue({
          code: 'custom',
          path: ['stocks', index, 'openTime'],
          message: 'A sell stock cannot carry openTime.',
        });
      }
      for (const field of ['openPrice', 'closePrice'] as const) {
        if (request.direction === 'sell' && stock[field] !== undefined) {
          context.addIssue({
            code: 'custom',
            path: ['stocks', index, field],
            message: `A sell stock cannot carry ${field}.`,
          });
        }
      }
      // A rule inherits from the request unless the stock names its own, and
      // an Opening auction buy is matched at 09:55 with no price in between,
      // so a band could never act on it.
      const openTime = stock.openTime ?? request.openTime;
      const openPrice = stock.openPrice === undefined ? request.openPrice : stock.openPrice;
      if (openTime?.type === 'OpeningAuction' && hasBandLimits(openPrice)) {
        context.addIssue({
          code: 'custom',
          path: ['stocks', index, 'openPrice'],
          message:
            'An entry band cannot guard an Opening auction buy: it is sent at 09:00 and matched at 09:55, so no price exists while the band could still act.',
        });
      }
    });
  });

export type SendOrdersRequest = z.infer<typeof sendOrdersRequestSchema>;

export const editStockSchema = z
  .object({
    symbol: z.string().min(1),
    price: z.number().positive().optional(),
    quantity: z.number().int().positive().optional(),
    orderId: z.string().min(1),
    time: scheduleSpecSchema.optional(),
    cancelAtFloor: z.boolean().optional(),
    openPrice: writtenOpenPriceSchema,
    closePrice: writtenClosePriceSchema,
  })
  .strict();

export const editOrdersRequestSchema = z
  .object({
    botId: botIdSchema,
    direction: directionSchema,
    type: orderTypeSchema,
    orderIds: z.array(z.string().min(1)).min(1),
    stocks: z.array(editStockSchema).min(1),
  })
  .strict()
  .superRefine((request, context) => {
    const orderIds = new Set(request.orderIds);
    request.stocks.forEach((stock, index) => {
      if (!orderIds.has(stock.orderId)) {
        context.addIssue({
          code: 'custom',
          path: ['stocks', index, 'orderId'],
          message: 'Every stock orderId must be present in orderIds.',
        });
      }
      if ((request.direction === 'buy' || request.type === 'limit') && stock.price === undefined) {
        context.addIssue({
          code: 'custom',
          path: ['stocks', index, 'price'],
          message: 'This edit requires a positive price.',
        });
      }
      for (const field of ['openPrice', 'closePrice'] as const) {
        if (request.direction === 'sell' && stock[field] !== undefined) {
          context.addIssue({
            code: 'custom',
            path: ['stocks', index, field],
            message: `A sell stock cannot carry ${field}.`,
          });
        }
      }
      if (stock.time?.type === 'OpeningAuction' && hasBandLimits(stock.openPrice)) {
        context.addIssue({
          code: 'custom',
          path: ['stocks', index, 'openPrice'],
          message:
            'Moving this buy to an Opening auction would strand its entry band; clear the band in the same edit.',
        });
      }
    });
  });

export type EditOrdersRequest = z.infer<typeof editOrdersRequestSchema>;

const pendingSendOrdersSchema = z
  .object({
    botId: botIdSchema,
    direction: directionSchema,
    type: orderTypeSchema,
    timeInForce: z.string().optional(),
    budget: z.number().positive().optional(),
    budgetPercentage: z.number().positive().optional(),
    budgetPerStock: z.number().positive().optional(),
    budgetPercentagePerStock: z.number().positive().optional(),
    openTime: scheduleSpecSchema.optional(),
    closeTime: scheduleSpecSchema.optional(),
    stocks: z.array(
      z
        .object({
          symbol: z.string().min(1),
          price: z.number().positive().optional(),
          quantity: z.number().int().positive().optional(),
          openTime: scheduleSpecSchema.optional(),
          closeTime: scheduleSpecSchema.optional(),
          cancelAtFloor: z.boolean().optional(),
        })
        .passthrough(),
    ),
  })
  .passthrough();

export const pendingOrderRequestSchema = z
  .object({
    id: z.number(),
    botId: botIdSchema,
    direction: directionSchema,
    request: pendingSendOrdersSchema.nullable(),
    createdTime: z.number(),
    retryCount: z.number().int(),
    nextAttemptTime: z.number(),
  })
  .passthrough();

export type PendingOrderRequest = z.infer<typeof pendingOrderRequestSchema>;

export const errorTypeSchema = z.enum([
  'MatriksConnectionError',
  'MatriksFieldNotFound',
  'Unspecified',
  'BarsDataError',
  'AccountNotFound',
  'AccountInformationUnavailable',
  'AccountFeedSilent',
  'OrderAccountMismatch',
]);

export const errorRowSchema = z
  .object({
    id: z.number(),
    time: z.number(),
    type: errorTypeSchema,
    information: z.string(),
    accountId: z.string().nullable(),
    brokerageId: z.string().nullable(),
    context: z.string().nullable(),
  })
  .passthrough();

export type ErrorType = z.infer<typeof errorTypeSchema>;
export type ErrorRow = z.infer<typeof errorRowSchema>;

export const holidaySchema = z
  .object({
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    type: z.enum(['full', 'half']),
  })
  .passthrough();

export type Holiday = z.infer<typeof holidaySchema>;

export const botBudgetSchema = z
  .object({
    portfolioValue: z.number(),
    accountBuyingPower: z.number(),
    remainingBotBudget: z.number(),
    limitPercentage: z.number(),
    limit: z.number(),
    limitPerPosition: z.number(),
    limitPercentagePerPosition: z.number(),
  })
  .passthrough();

export type BotBudget = z.infer<typeof botBudgetSchema>;

export const configureBotRequestSchema = z
  .object({
    id: botIdSchema,
    algoritmId: z.string().min(1).optional(),
    accountId: z.string().min(1).optional(),
    brokerageId: z.string().min(1).optional(),
    limitPercentage: z.number().positive().optional(),
    limit: z.number().positive().optional(),
    limitPerPosition: z.number().positive().optional(),
    limitPercentagePerPosition: z.number().positive().optional(),
    emails: z.array(z.string()).optional(),
    forbiddenStocks: z.array(z.string()).optional(),
    active: z.boolean().optional(),
    description: z.string().optional(),
  })
  .strict();

export type ConfigureBotRequest = z.infer<typeof configureBotRequestSchema>;

export const sendOrdersResponseSchema = z
  .object({
    toOrder: z.array(
      z
        .object({
          symbol: z.string(),
          quantity: z.number().int().nullable(),
          estimatedOpenTime: z.number().optional(),
          estimatedCloseTime: z.number().optional(),
        })
        .passthrough(),
    ),
    skippedList: z.array(z.object({ symbol: z.string(), reason: z.string() }).passthrough()),
    estimatedBudgetUsage: z.number().optional(),
    remainingBotBudget: z.number().optional(),
    estimatedOpenTime: z.number().optional(),
    estimatedCloseTime: z.number().optional(),
  })
  .passthrough();

export type SendOrdersResponse = z.infer<typeof sendOrdersResponseSchema>;

export const cancelPendingResponseSchema = z.object({
  results: z.array(
    z.object({
      id: z.number(),
      outcome: z.enum(['canceled', 'gone', 'wrongBot']),
    }),
  ),
});

export type CancelPendingResponse = z.infer<typeof cancelPendingResponseSchema>;

export const refreshStatusEventSchema = z.object({
  status: z.enum(['', 'loading']),
  lastUpdateTime: z.number().nullable(),
});

export const refreshFinishedEventSchema = z.object({
  lastUpdateTime: z.number().nullable(),
});

export const writeEventSchema = z.object({
  table: z.enum([
    'ActiveOrders',
    'ScheduledOrders',
    'CanceledOrders',
    'Positions',
    'ClosedTrades',
    'PendingOrderRequests',
  ]),
  action: z.enum(['insert', 'update', 'delete']),
  botId: z.string(),
  row: z.record(z.string(), z.unknown()),
});

export type WriteEvent = z.infer<typeof writeEventSchema>;
