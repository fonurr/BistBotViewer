import type { z } from 'zod';

import {
  producerStatusSchema,
  quoteSchema,
  streamStoppedSchema,
  streamSubscribedSchema,
  type ProducerStatus,
  type Quote,
  type StreamSubscribed,
} from './types';

export interface PriceLiveHandlers {
  open: () => void;
  error: () => void;
  protocolError: (error: Error) => void;
  subscribed: (event: StreamSubscribed) => void;
  quote: (quote: Quote) => void;
  status: (status: ProducerStatus) => void;
  /** The producer is closing for the session. Nothing more arrives on this stream. */
  stopped: (reason: string | null) => void;
}

/**
 * The price stream. Upstream sends the same payloads its pull endpoints do, plus a `status` every
 * five seconds whether or not anything ticked — so silence here means the connection died, not that
 * the market went quiet, and a producer blocked on a reconnect still says so.
 */
export function subscribeToPriceEvents(url: string, handlers: PriceLiveHandlers): () => void {
  const source = new EventSource(url, { withCredentials: true });
  source.onopen = handlers.open;
  source.onerror = handlers.error;
  source.addEventListener('subscribed', (event) => {
    const parsed = parseEvent(event, streamSubscribedSchema);
    if (parsed === null) {
      handlers.protocolError(new Error('The price stream sent an invalid subscription event.'));
      return;
    }
    handlers.subscribed(parsed);
  });
  source.addEventListener('quote', (event) => {
    const parsed = parseEvent(event, quoteSchema);
    if (parsed === null) {
      handlers.protocolError(new Error('The price stream sent an invalid quote.'));
      return;
    }
    handlers.quote(parsed);
  });
  source.addEventListener('status', (event) => {
    const parsed = parseEvent(event, producerStatusSchema);
    if (parsed === null) {
      handlers.protocolError(new Error('The price stream sent an invalid status event.'));
      return;
    }
    handlers.status(parsed);
  });
  source.addEventListener('stopped', (event) => {
    const parsed = parseEvent(event, streamStoppedSchema);
    handlers.stopped(parsed?.reason ?? null);
  });
  return () => source.close();
}

function parseEvent<T>(event: Event, schema: z.ZodType<T>): T | null {
  let raw: unknown;
  try {
    raw = JSON.parse((event as MessageEvent).data as string) as unknown;
  } catch {
    return null;
  }
  const parsed = schema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}
