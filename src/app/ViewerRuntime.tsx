import { useQueryClient } from '@tanstack/react-query';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';

import { bistApi, installBistWriteGuard } from '../bistApi/client';
import { recordBistWriteEvent } from '../bistApi/eventJournal';
import { subscribeToBistEvents } from '../bistApi/live';
import { applyWriteEvent } from './liveUpdates';
import { bistKeys } from './queryKeys';

export type StreamState = 'connecting' | 'live' | 'down';
export type PriceHealth = 'unused' | 'loading' | 'live' | 'unavailable';
export type ToastTone = 'live' | 'wait' | 'dead' | 'warn';

export interface ViewerToast {
  id: number;
  tone: ToastTone;
  title: string;
  message: string;
  persistent?: boolean;
}

interface RuntimeValue {
  streamState: StreamState;
  priceHealth: PriceHealth;
  lastUpdateTime: number | null;
  refreshing: boolean;
  refreshFailed: boolean;
  logsOpen: boolean;
  writesHeldReason: string | null;
  toasts: ViewerToast[];
  requestRefresh: () => Promise<void>;
  requestReconcile: () => Promise<void>;
  openLogs: () => void;
  closeLogs: () => void;
  pushToast: (toast: Omit<ViewerToast, 'id'>) => void;
  dismissToast: (id: number) => void;
  reportPriceHealth: (sourceId: string, health: Exclude<PriceHealth, 'unused'> | null) => void;
}

const RuntimeContext = createContext<RuntimeValue | null>(null);

export function ViewerRuntimeProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const [streamState, setStreamState] = useState<StreamState>('connecting');
  const [priceHealth, setPriceHealth] = useState<PriceHealth>('unused');
  const priceReports = useRef(new Map<string, Exclude<PriceHealth, 'unused'>>());
  const [lastUpdateTime, setLastUpdateTime] = useState<number | null>(null);
  const lastUpdateRef = useRef<number | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshFailed, setRefreshFailed] = useState(false);
  const [logsOpen, setLogsOpen] = useState(false);
  const [toasts, setToasts] = useState<ViewerToast[]>([]);
  const nextToastId = useRef(0);
  const scrollPosition = useRef<{ x: number; y: number } | null>(null);
  const streamVersion = useRef(0);
  const streamTransportOpen = useRef(false);
  const reconcileRef = useRef<() => Promise<void>>(async () => undefined);
  const streamStateRef = useRef(streamState);
  const refreshingRef = useRef(refreshing);
  streamStateRef.current = streamState;
  refreshingRef.current = refreshing;

  useEffect(
    () =>
      installBistWriteGuard(() =>
        streamStateRef.current === 'live' && !refreshingRef.current
          ? null
          : 'Actions are held until the order stream is live and the snapshot can reconcile them.',
      ),
    [],
  );

  const pushToast = useCallback((toast: Omit<ViewerToast, 'id'>) => {
    const id = ++nextToastId.current;
    setToasts((current) => [...current, { ...toast, id }]);
    if (!toast.persistent && (toast.tone === 'live' || toast.tone === 'wait')) {
      window.setTimeout(
        () => setToasts((current) => current.filter((item) => item.id !== id)),
        5_000,
      );
    }
  }, []);

  const dismissToast = useCallback((id: number) => {
    setToasts((current) => current.filter((toast) => toast.id !== id));
  }, []);

  const reportPriceHealth = useCallback(
    (sourceId: string, health: Exclude<PriceHealth, 'unused'> | null) => {
      const reports = priceReports.current;
      if (health === null) reports.delete(sourceId);
      else reports.set(sourceId, health);
      const values = [...reports.values()];
      const aggregate: PriceHealth = values.includes('unavailable')
        ? 'unavailable'
        : values.includes('loading')
          ? 'loading'
          : values.includes('live')
            ? 'live'
            : 'unused';
      setPriceHealth((current) => (current === aggregate ? current : aggregate));
    },
    [],
  );

  useEffect(() => {
    let snapshotInFlight = true;
    let statusSeen = false;
    let statusLoading = true;
    let bufferedWrites: Parameters<typeof applyWriteEvent>[1][] = [];
    const transitionStream = (next: StreamState) => {
      streamStateRef.current = next;
      setStreamState(next);
    };
    const setRefreshState = (next: boolean) => {
      refreshingRef.current = next;
      setRefreshing(next);
    };
    const reconcileStream = async (): Promise<void> => {
      const version = ++streamVersion.current;
      snapshotInFlight = true;
      // A new full snapshot supersedes every prior generation. Events arriving from
      // this point onward are replayed over only this snapshot.
      bufferedWrites = [];
      transitionStream('connecting');
      try {
        await queryClient.cancelQueries({ queryKey: bistKeys.root, type: 'all' });
        await queryClient.refetchQueries(
          { queryKey: bistKeys.root, type: 'all' },
          { throwOnError: true },
        );
        if (streamVersion.current !== version) return;
        const replay = bufferedWrites;
        bufferedWrites = [];
        replay.forEach((event) => applyWriteEvent(queryClient, event));
        snapshotInFlight = false;
        transitionStream(
          streamTransportOpen.current && statusSeen && !statusLoading ? 'live' : 'connecting',
        );
      } catch {
        if (streamVersion.current !== version) return;
        snapshotInFlight = true;
        bufferedWrites = [];
        transitionStream('down');
      }
    };
    reconcileRef.current = reconcileStream;
    const unsubscribe = subscribeToBistEvents(bistApi.eventUrl, {
      open: () => {
        streamTransportOpen.current = true;
        statusSeen = false;
        statusLoading = true;
        void reconcileStream();
      },
      error: () => {
        streamTransportOpen.current = false;
        statusSeen = false;
        statusLoading = true;
        snapshotInFlight = true;
        bufferedWrites = [];
        streamVersion.current += 1;
        transitionStream('down');
      },
      protocolError: () => void reconcileStream(),
      status: (event) => {
        statusSeen = true;
        statusLoading = event.status === 'loading';
        lastUpdateRef.current = event.lastUpdateTime;
        setLastUpdateTime(event.lastUpdateTime);
        setRefreshState(statusLoading);
        if (statusLoading) {
          snapshotInFlight = true;
          transitionStream('connecting');
        } else if (!snapshotInFlight && streamTransportOpen.current) {
          transitionStream('live');
        }
      },
      refreshStarted: () => {
        statusSeen = true;
        statusLoading = true;
        snapshotInFlight = true;
        transitionStream('connecting');
        setRefreshState(true);
        setRefreshFailed(false);
      },
      refreshFinished: (event) => {
        statusSeen = true;
        statusLoading = false;
        const unchanged = event.lastUpdateTime === lastUpdateRef.current;
        setRefreshFailed(unchanged);
        lastUpdateRef.current = event.lastUpdateTime;
        setLastUpdateTime(event.lastUpdateTime);
        void reconcileStream().finally(() => {
          setRefreshState(false);
          if (scrollPosition.current) {
            const position = scrollPosition.current;
            scrollPosition.current = null;
            requestAnimationFrame(() => window.scrollTo(position.x, position.y));
          }
        });
      },
      write: (event) => {
        recordBistWriteEvent(event);
        if (snapshotInFlight) {
          bufferedWrites.push(event);
          return;
        }
        try {
          applyWriteEvent(queryClient, event);
        } catch {
          void reconcileStream();
        }
      },
    });
    return () => {
      reconcileRef.current = async () => undefined;
      unsubscribe();
    };
  }, [queryClient]);

  const requestReconcile = useCallback(() => reconcileRef.current(), []);

  const requestRefresh = useCallback(async () => {
    if (refreshing) return;
    scrollPosition.current = { x: window.scrollX, y: window.scrollY };
    refreshingRef.current = true;
    setRefreshing(true);
    setRefreshFailed(false);
    try {
      await bistApi.refreshData();
    } catch (error) {
      refreshingRef.current = false;
      setRefreshing(false);
      scrollPosition.current = null;
      pushToast({
        tone: 'warn',
        title: 'Refresh not confirmed',
        message:
          error instanceof Error ? error.message : 'The refresh request had no readable reply.',
        persistent: true,
      });
    }
  }, [pushToast, refreshing]);

  const value = useMemo<RuntimeValue>(
    () => ({
      streamState,
      priceHealth,
      lastUpdateTime,
      refreshing,
      refreshFailed,
      logsOpen,
      writesHeldReason:
        streamState === 'live' && !refreshing
          ? null
          : 'Actions are held until the order stream is live and the snapshot can reconcile them.',
      toasts,
      requestRefresh,
      requestReconcile,
      openLogs: () => setLogsOpen(true),
      closeLogs: () => setLogsOpen(false),
      pushToast,
      dismissToast,
      reportPriceHealth,
    }),
    [
      dismissToast,
      lastUpdateTime,
      logsOpen,
      priceHealth,
      pushToast,
      reportPriceHealth,
      refreshing,
      refreshFailed,
      requestRefresh,
      requestReconcile,
      streamState,
      toasts,
    ],
  );

  return <RuntimeContext.Provider value={value}>{children}</RuntimeContext.Provider>;
}

export function useViewerRuntime(): RuntimeValue {
  const value = useContext(RuntimeContext);
  if (!value) throw new Error('useViewerRuntime must be used inside ViewerRuntimeProvider.');
  return value;
}
