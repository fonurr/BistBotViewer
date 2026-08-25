import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';

import type { BistLiveHandlers } from '../bistApi/live';
import type { ActiveOrder } from '../bistApi/types';
import { makeActiveOrder } from '../test/fixtures/bist';
import { subscribeToBistEvents } from '../bistApi/live';
import { ViewerRuntimeProvider, useViewerRuntime } from './ViewerRuntime';
import { bistKeys } from './queryKeys';

vi.mock('../bistApi/live', () => ({
  subscribeToBistEvents: vi.fn(),
}));

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

function RuntimeProbe() {
  const runtime = useViewerRuntime();
  return (
    <>
      <output aria-label="stream state">{runtime.streamState}</output>
      <output aria-label="write state">{runtime.writesHeldReason ? 'held' : 'enabled'}</output>
      <button type="button" onClick={() => void runtime.requestReconcile()}>
        Reconcile
      </button>
    </>
  );
}

function RuntimeHarness({ client, children }: { client: QueryClient; children?: ReactNode }) {
  return (
    <QueryClientProvider client={client}>
      <ViewerRuntimeProvider>
        <RuntimeProbe />
        {children}
      </ViewerRuntimeProvider>
    </QueryClientProvider>
  );
}

async function loadedClient(initialRows: ActiveOrder[]) {
  const client = new QueryClient({
    defaultOptions: {
      queries: { gcTime: Number.POSITIVE_INFINITY, retry: false },
    },
  });
  let read = async () => initialRows;
  const query = vi.fn(() => read());
  await client.fetchQuery({ queryKey: bistKeys.activeOrders('*'), queryFn: query });
  query.mockClear();
  return {
    client,
    query,
    readWith(next: () => Promise<ActiveOrder[]>) {
      read = next;
    },
  };
}

const subscription = vi.mocked(subscribeToBistEvents);
let handlers: BistLiveHandlers;
let unsubscribe: ReturnType<typeof vi.fn<() => void>>;

beforeEach(() => {
  unsubscribe = vi.fn<() => void>();
  subscription.mockImplementation((_url, nextHandlers) => {
    handlers = nextHandlers;
    return unsubscribe;
  });
});

afterEach(() => {
  subscription.mockReset();
});

async function renderRuntime(client: QueryClient) {
  const view = render(<RuntimeHarness client={client} />);
  await waitFor(() => expect(subscription).toHaveBeenCalledOnce());
  return view;
}

describe('ViewerRuntime stream reconciliation', () => {
  it('holds the first open until a full BIST refetch and a non-loading status both complete', async () => {
    const snapshot = deferred<ActiveOrder[]>();
    const state = await loadedClient([makeActiveOrder({ orderQuantity: 10 })]);
    state.readWith(() => snapshot.promise);
    const refetch = vi.spyOn(state.client, 'refetchQueries');
    const view = await renderRuntime(state.client);

    await act(async () => {
      handlers.open();
      await Promise.resolve();
    });

    expect(screen.getByLabelText('stream state')).toHaveTextContent('connecting');
    expect(screen.getByLabelText('write state')).toHaveTextContent('held');
    expect(refetch).toHaveBeenCalledWith(
      { queryKey: bistKeys.root, type: 'all' },
      { throwOnError: true },
    );
    expect(state.query).toHaveBeenCalledOnce();

    await act(async () => {
      snapshot.resolve([makeActiveOrder({ orderQuantity: 20 })]);
      await snapshot.promise;
    });
    await waitFor(() =>
      expect(
        state.client.getQueryData<ActiveOrder[]>(bistKeys.activeOrders('*'))?.[0]?.orderQuantity,
      ).toBe(20),
    );

    expect(screen.getByLabelText('stream state')).toHaveTextContent('connecting');
    expect(screen.getByLabelText('write state')).toHaveTextContent('held');

    act(() => handlers.status({ status: '', lastUpdateTime: 1_000 }));

    expect(screen.getByLabelText('stream state')).toHaveTextContent('live');
    expect(screen.getByLabelText('write state')).toHaveTextContent('enabled');
    view.unmount();
    expect(unsubscribe).toHaveBeenCalledOnce();
    state.client.clear();
  });

  it('buffers write events during the opening refetch and replays them over its snapshot', async () => {
    const snapshot = deferred<ActiveOrder[]>();
    const original = makeActiveOrder({ orderQuantity: 10 });
    const refreshed = makeActiveOrder({ orderQuantity: 20 });
    const streamed = makeActiveOrder({ orderQuantity: 30 });
    const state = await loadedClient([original]);
    state.readWith(() => snapshot.promise);
    await renderRuntime(state.client);

    await act(async () => {
      handlers.open();
      handlers.status({ status: '', lastUpdateTime: 1_000 });
      await Promise.resolve();
    });
    act(() => {
      handlers.write({
        table: 'ActiveOrders',
        action: 'update',
        botId: streamed.botId,
        row: streamed,
      });
    });

    expect(
      state.client.getQueryData<ActiveOrder[]>(bistKeys.activeOrders('*'))?.[0]?.orderQuantity,
    ).toBe(10);
    expect(screen.getByLabelText('write state')).toHaveTextContent('held');

    await act(async () => {
      snapshot.resolve([refreshed]);
      await snapshot.promise;
    });

    await waitFor(() =>
      expect(
        state.client.getQueryData<ActiveOrder[]>(bistKeys.activeOrders('*'))?.[0]?.orderQuantity,
      ).toBe(30),
    );
    expect(screen.getByLabelText('stream state')).toHaveTextContent('live');
    expect(screen.getByLabelText('write state')).toHaveTextContent('enabled');
    state.client.clear();
  });

  it('keeps writes held after a transport error even if an obsolete refetch later finishes', async () => {
    const snapshot = deferred<ActiveOrder[]>();
    const state = await loadedClient([makeActiveOrder()]);
    state.readWith(() => snapshot.promise);
    await renderRuntime(state.client);

    await act(async () => {
      handlers.open();
      handlers.status({ status: '', lastUpdateTime: 1_000 });
      await Promise.resolve();
    });
    act(() => handlers.error());

    expect(screen.getByLabelText('stream state')).toHaveTextContent('down');
    expect(screen.getByLabelText('write state')).toHaveTextContent('held');

    await act(async () => {
      snapshot.resolve([makeActiveOrder({ orderQuantity: 99 })]);
      await snapshot.promise;
    });

    expect(screen.getByLabelText('stream state')).toHaveTextContent('down');
    expect(screen.getByLabelText('write state')).toHaveTextContent('held');
    state.client.clear();
  });

  it('routes requestReconcile through the same held, buffered full-refetch path', async () => {
    const initial = makeActiveOrder({ orderQuantity: 10 });
    const state = await loadedClient([initial]);
    state.readWith(async () => [makeActiveOrder({ orderQuantity: 20 })]);
    const refetch = vi.spyOn(state.client, 'refetchQueries');
    await renderRuntime(state.client);

    act(() => {
      handlers.open();
      handlers.status({ status: '', lastUpdateTime: 1_000 });
    });
    await waitFor(() => expect(screen.getByLabelText('stream state')).toHaveTextContent('live'));

    const snapshot = deferred<ActiveOrder[]>();
    state.query.mockClear();
    refetch.mockClear();
    state.readWith(() => snapshot.promise);
    fireEvent.click(screen.getByRole('button', { name: 'Reconcile' }));

    await waitFor(() => expect(state.query).toHaveBeenCalledOnce());
    expect(screen.getByLabelText('stream state')).toHaveTextContent('connecting');
    expect(screen.getByLabelText('write state')).toHaveTextContent('held');
    expect(refetch).toHaveBeenCalledWith(
      { queryKey: bistKeys.root, type: 'all' },
      { throwOnError: true },
    );

    const streamed = makeActiveOrder({ orderQuantity: 40 });
    act(() => {
      handlers.write({
        table: 'ActiveOrders',
        action: 'update',
        botId: streamed.botId,
        row: streamed,
      });
    });
    expect(
      state.client.getQueryData<ActiveOrder[]>(bistKeys.activeOrders('*'))?.[0]?.orderQuantity,
    ).toBe(20);

    await act(async () => {
      snapshot.resolve([makeActiveOrder({ orderQuantity: 30 })]);
      await snapshot.promise;
    });

    await waitFor(() =>
      expect(
        state.client.getQueryData<ActiveOrder[]>(bistKeys.activeOrders('*'))?.[0]?.orderQuantity,
      ).toBe(40),
    );
    expect(screen.getByLabelText('stream state')).toHaveTextContent('live');
    expect(screen.getByLabelText('write state')).toHaveTextContent('enabled');
    state.client.clear();
  });
});
