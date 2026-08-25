import {
  refreshFinishedEventSchema,
  refreshStatusEventSchema,
  writeEventSchema,
  type WriteEvent,
} from './types';

export interface RefreshStatusEvent {
  status: '' | 'loading';
  lastUpdateTime: number | null;
}

export interface RefreshFinishedEvent {
  lastUpdateTime: number | null;
}

export interface BistLiveHandlers {
  open: () => void;
  error: () => void;
  protocolError: (error: Error) => void;
  status: (event: RefreshStatusEvent) => void;
  refreshStarted: () => void;
  refreshFinished: (event: RefreshFinishedEvent) => void;
  write: (event: WriteEvent) => void;
}

export function subscribeToBistEvents(url: string, handlers: BistLiveHandlers): () => void {
  const source = new EventSource(url, { withCredentials: true });
  source.onopen = handlers.open;
  source.onerror = handlers.error;
  source.addEventListener('status', (event) => {
    const raw = parseMessage(event);
    if (raw === null) {
      handlers.protocolError(new Error('The order stream sent unreadable status JSON.'));
      return;
    }
    const parsed = refreshStatusEventSchema.safeParse(raw);
    if (parsed.success) handlers.status(parsed.data);
    else handlers.protocolError(new Error('The order stream sent an invalid status event.'));
  });
  source.addEventListener('refreshStarted', handlers.refreshStarted);
  source.addEventListener('refreshFinished', (event) => {
    const raw = parseMessage(event);
    if (raw === null) {
      handlers.protocolError(new Error('The order stream sent unreadable refresh JSON.'));
      return;
    }
    const parsed = refreshFinishedEventSchema.safeParse(raw);
    if (parsed.success) handlers.refreshFinished(parsed.data);
    else handlers.protocolError(new Error('The order stream sent an invalid refresh event.'));
  });
  source.addEventListener('write', (event) => {
    const raw = parseMessage(event);
    if (raw === null) {
      handlers.protocolError(new Error('The order stream sent unreadable write JSON.'));
      return;
    }
    const parsed = writeEventSchema.safeParse(raw);
    if (parsed.success) handlers.write(parsed.data);
    else handlers.protocolError(new Error('The order stream sent an invalid write event.'));
  });
  return () => source.close();
}

function parseMessage(event: Event): unknown | null {
  try {
    return JSON.parse((event as MessageEvent).data) as unknown;
  } catch {
    return null;
  }
}
