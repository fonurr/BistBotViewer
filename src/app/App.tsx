import {
  Component,
  lazy,
  Suspense,
  useEffect,
  useState,
  type ErrorInfo,
  type ReactNode,
} from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';

import { AppShell } from '../components/AppShell';
import { useViewerRuntime } from './ViewerRuntime';

const BookPage = lazy(() =>
  import('../pages/book/BookPage').then((module) => ({ default: module.BookPage })),
);
const BotsPage = lazy(() =>
  import('../pages/bots/BotsPage').then((module) => ({ default: module.BotsPage })),
);
const PerformancePage = lazy(() =>
  import('../pages/performance/PerformancePage').then((module) => ({
    default: module.PerformancePage,
  })),
);
const LogsDrawer = lazy(() =>
  import('../pages/logs').then((module) => ({ default: module.LogsDrawer })),
);

export function App() {
  const runtime = useViewerRuntime();
  const [logsLoaded, setLogsLoaded] = useState(runtime.logsOpen);
  useEffect(() => {
    if (runtime.logsOpen) setLogsLoaded(true);
  }, [runtime.logsOpen]);
  return (
    <AppErrorBoundary>
      <AppShell>
        <Suspense fallback={<PageLoading />}>
          <Routes>
            <Route path="/" element={<Navigate to="/book" replace />} />
            <Route path="/book" element={<BookPage />} />
            <Route path="/performance" element={<PerformancePage />} />
            <Route path="/bots" element={<BotsPage />} />
            <Route path="*" element={<Navigate to="/book" replace />} />
          </Routes>
        </Suspense>
      </AppShell>
      {logsLoaded ? (
        <Suspense fallback={null}>
          <LogsDrawer open={runtime.logsOpen} onClose={runtime.closeLogs} />
        </Suspense>
      ) : null}
    </AppErrorBoundary>
  );
}

function PageLoading() {
  return (
    <div className="page-loading" role="status">
      <span className="spinner" aria-hidden="true" />
      Loading the view…
    </div>
  );
}

interface ErrorBoundaryState {
  error: Error | null;
}

class AppErrorBoundary extends Component<{ children: ReactNode }, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('The viewer surface failed safely.', error, info.componentStack);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <main className="fatal-boundary" role="alert">
        <h1>The viewer could not render this snapshot.</h1>
        <p>{this.state.error.message}</p>
        <button
          type="button"
          className="btn btn-secondary"
          onClick={() => window.location.reload()}
        >
          Reload the viewer
        </button>
      </main>
    );
  }
}
