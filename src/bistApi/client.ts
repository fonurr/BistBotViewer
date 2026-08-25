import { z } from 'zod';

import { BistApiError } from './errors';
import {
  bistJournalChangedForBot,
  bistJournalCheckpoint,
  replayBistJournal,
  type JournalKind,
  type JournalRows,
} from './eventJournal';
import {
  accountSchema,
  activeOrderSchema,
  botBudgetSchema,
  botSchema,
  cancelPendingResponseSchema,
  canceledOrderSchema,
  closedTradeSchema,
  configureBotRequestSchema,
  editOrdersRequestSchema,
  errorRowSchema,
  holidaySchema,
  pendingOrderRequestSchema,
  positionSchema,
  sendOrdersRequestSchema,
  sendOrdersResponseSchema,
  type BotSelector,
  type ConfigureBotRequest,
  type EditOrdersRequest,
  type ErrorType,
  type SendOrdersRequest,
} from './types';

const bridgeBase = '/bridge/bist';
const emptyResponseSchema = z.object({}).passthrough();
const sessionSchema = z.object({ csrfToken: z.string().min(20) });
const errorEnvelopeSchema = z
  .object({
    type: z.string().optional(),
    information: z.string().optional(),
    mayHaveReachedExchange: z.boolean().optional(),
    queued: z.boolean().optional(),
    retryAt: z.number().optional(),
    attemptsLeft: z.number().int().nonnegative().optional(),
  })
  .passthrough();

let csrfTokenPromise: Promise<string> | null = null;
type WriteGuard = () => string | null;
let writeGuard: WriteGuard | null = null;

export function installBistWriteGuard(guard: WriteGuard): () => void {
  writeGuard = guard;
  return () => {
    if (writeGuard === guard) writeGuard = null;
  };
}

function selectorBody(botId: BotSelector): { botId: string | readonly string[] } {
  if (Array.isArray(botId) && botId.length === 0) {
    throw new BistApiError({
      message: 'No bots are selected, so the server was not called.',
      kind: 'refused',
      type: 'BadRequest',
    });
  }
  return { botId };
}

async function journaledRead<Kind extends JournalKind>(
  kind: Kind,
  selector: BotSelector,
  read: () => Promise<JournalRows[Kind][]>,
): Promise<JournalRows[Kind][]> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const checkpoint = bistJournalCheckpoint();
    const snapshot = await read();
    const reconciled = replayBistJournal(checkpoint, kind, selector, snapshot);
    if (reconciled) return reconciled;
  }
  throw new BistApiError({
    message: 'The event journal changed too quickly to reconcile this read safely.',
    kind: 'unavailable',
    type: 'SnapshotOverrun',
    mayHaveReachedExchange: false,
  });
}

async function journaledBudgetRead(botId: string): Promise<z.infer<typeof botBudgetSchema>> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const checkpoint = bistJournalCheckpoint();
    const budget = await rpc('GetBotBudget', { botId }, botBudgetSchema);
    if (bistJournalChangedForBot(checkpoint, botId) === false) return budget;
  }
  throw new BistApiError({
    message: 'The bot changed too quickly to confirm a current budget safely.',
    kind: 'unavailable',
    type: 'SnapshotOverrun',
    mayHaveReachedExchange: false,
  });
}

async function getCsrfToken(): Promise<string> {
  csrfTokenPromise ??= fetch(`${bridgeBase}/session`, {
    credentials: 'same-origin',
    headers: { Accept: 'application/json' },
  })
    .then(async (response) => {
      if (!response.ok) throw new Error(`Session bootstrap returned HTTP ${response.status}.`);
      return sessionSchema.parse(await response.json()).csrfToken;
    })
    .catch((error) => {
      csrfTokenPromise = null;
      throw error;
    });
  return csrfTokenPromise;
}

async function rpc<T>(
  name: string,
  body: unknown,
  schema: z.ZodType<T>,
  options: { write?: boolean; enforceWriteGuard?: boolean; timeoutMs?: number } = {},
): Promise<T> {
  const write = options.write ?? false;
  const headers: Record<string, string> = {
    Accept: 'application/json',
    'Content-Type': 'application/json',
  };
  if (write) {
    try {
      headers['X-BotViewer-CSRF'] = await getCsrfToken();
    } catch (error) {
      throw new BistApiError({
        message: 'The write did not leave the viewer because its local session could not start.',
        kind: 'unavailable',
        type: 'BridgeSessionUnavailable',
        mayHaveReachedExchange: false,
        cause: error,
      });
    }
    if ((options.enforceWriteGuard ?? true) && writeGuard) {
      const heldReason = writeGuard();
      if (heldReason) {
        throw new BistApiError({
          message: `${heldReason} The write did not leave this viewer.`,
          kind: 'refused',
          type: 'WriteHeld',
          mayHaveReachedExchange: false,
        });
      }
    }
  }

  let response: Response;
  try {
    response = await fetch(`${bridgeBase}/rpc/${encodeURIComponent(name)}`, {
      method: 'POST',
      credentials: 'same-origin',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(options.timeoutMs ?? (write ? 65_000 : 15_000)),
    });
  } catch (error) {
    throw new BistApiError({
      message: write
        ? 'The request went out, but no readable reply came back.'
        : 'MatriksOrder did not answer this read.',
      kind: write ? 'unknown' : 'unavailable',
      type: write ? 'NoAnswer' : 'BridgeUnavailable',
      mayHaveReachedExchange: write,
      cause: error,
    });
  }

  const rawText = await response.text();
  let payload: unknown = {};
  if (rawText.length > 0) {
    try {
      payload = JSON.parse(rawText) as unknown;
    } catch (error) {
      throw new BistApiError({
        message: 'The server answered, but the reply was not a readable JSON envelope.',
        kind: write ? 'unknown' : 'protocol',
        type: 'UnreadableReply',
        status: response.status,
        mayHaveReachedExchange: write,
        cause: error,
      });
    }
  }

  if (!response.ok) {
    const envelope = errorEnvelopeSchema.safeParse(payload);
    const details = envelope.success ? envelope.data : {};
    const bridgeUnavailable = details.type === 'BridgeUnavailable';
    throw new BistApiError({
      message: details.information ?? `MatriksOrder returned HTTP ${response.status}.`,
      kind: bridgeUnavailable ? 'unavailable' : 'refused',
      type: details.type ?? 'Unspecified',
      status: response.status,
      mayHaveReachedExchange: details.mayHaveReachedExchange ?? false,
      queued: details.queued ?? false,
      retryAt: details.retryAt ?? null,
      attemptsLeft: details.attemptsLeft ?? null,
    });
  }

  const parsed = schema.safeParse(payload);
  if (!parsed.success) {
    throw new BistApiError({
      message: 'The server replied with a shape this viewer cannot safely interpret.',
      kind: write ? 'unknown' : 'protocol',
      type: 'UnreadableReply',
      status: response.status,
      mayHaveReachedExchange: write,
      cause: parsed.error,
    });
  }
  return parsed.data;
}

export const bistApi = {
  eventUrl: `${bridgeBase}/events`,

  getBots: () => rpc('GetBots', {}, z.array(botSchema)),
  getAccounts: () => rpc('GetAccounts', {}, z.array(accountSchema)),
  getActiveOrders: (botId: BotSelector) =>
    journaledRead('activeOrders', botId, () =>
      rpc('GetActiveOrders', selectorBody(botId), z.array(activeOrderSchema)),
    ),
  getCanceledOrders: (botId: BotSelector) =>
    journaledRead('canceledOrders', botId, () =>
      rpc('GetCanceledOrders', selectorBody(botId), z.array(canceledOrderSchema)),
    ),
  getPositions: (botId: BotSelector) =>
    journaledRead('positions', botId, () =>
      rpc('GetPositions', selectorBody(botId), z.array(positionSchema)),
    ),
  getClosedTrades: (botId: BotSelector) =>
    journaledRead('closedTrades', botId, () =>
      rpc('GetClosedTrades', selectorBody(botId), z.array(closedTradeSchema)),
    ),
  getPendingOrderRequests: (botId: BotSelector) =>
    journaledRead('pendingRequests', botId, () =>
      rpc('GetPendingOrderRequests', selectorBody(botId), z.array(pendingOrderRequestSchema)),
    ),
  getBotBudget: (botId: string) => journaledBudgetRead(botId),
  getHolidays: () => rpc('GetHolidays', {}, z.array(holidaySchema)),
  getErrors: (request: {
    type?: ErrorType;
    since?: number;
    until?: number;
    limit?: number;
    beforeId?: number;
  }) => rpc('GetErrors', request, z.array(errorRowSchema)),

  refreshData: () =>
    rpc('RefreshData', {}, emptyResponseSchema, { write: true, enforceWriteGuard: false }),
  configureBot: (request: ConfigureBotRequest) =>
    rpc('ConfigureBot', configureBotRequestSchema.parse(request), emptyResponseSchema, {
      write: true,
    }),
  sendOrders: (request: SendOrdersRequest) =>
    rpc('SendOrders', sendOrdersRequestSchema.parse(request), sendOrdersResponseSchema, {
      write: true,
    }),
  editOrders: (request: EditOrdersRequest) =>
    rpc(
      'EditOrders',
      editOrdersRequestSchema.parse(request),
      z
        .object({
          estimatedBudgetUsage: z.number().optional(),
          remainingBotBudget: z.number().optional(),
        })
        .passthrough(),
      { write: true },
    ),
  cancelOrders: (botId: string, orderIds: string[]) =>
    rpc('CancelOrders', { botId, orderIds }, emptyResponseSchema, { write: true }),
  cancelPendingOrderRequests: (botId: string, ids: number[]) =>
    rpc('CancelPendingOrderRequests', { botId, ids }, cancelPendingResponseSchema, { write: true }),
};
