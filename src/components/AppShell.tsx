import { ArrowClockwise, TerminalWindow } from '@phosphor-icons/react';
import { NavLink } from 'react-router-dom';
import { useEffect, useMemo, useState, type ReactNode } from 'react';

import { formatRelativeAge, formatTime } from '../domain/format';
import { useViewerRuntime } from '../app/ViewerRuntime';

export function AppShell({ children }: { children: ReactNode }) {
  const runtime = useViewerRuntime();
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    const interval = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(interval);
  }, []);

  const freshness = useMemo(() => {
    if (runtime.streamState === 'down') {
      return { className: 'status-dead', copy: 'stream down · reconnecting' };
    }
    if (runtime.refreshing) return { className: 'status-wait', copy: 'Loading…' };
    if (runtime.refreshFailed) {
      return { className: 'status-warn', copy: 'refresh failed · snapshot unchanged' };
    }
    if (runtime.priceHealth === 'unavailable') {
      return { className: 'status-warn', copy: 'prices unavailable · order stream live' };
    }
    if (runtime.priceHealth === 'loading') {
      return { className: 'status-wait', copy: 'prices connecting · order stream live' };
    }
    const priceCopy = runtime.priceHealth === 'live' ? 'prices live · ' : '';
    return {
      className: runtime.streamState === 'live' ? 'muted' : 'status-wait',
      copy:
        runtime.streamState === 'connecting'
          ? 'stream connecting'
          : runtime.lastUpdateTime === null
            ? `${priceCopy}waiting for first snapshot`
            : `${priceCopy}orders updated ${formatRelativeAge(runtime.lastUpdateTime, now).toLowerCase()}`,
    };
  }, [
    now,
    runtime.lastUpdateTime,
    runtime.priceHealth,
    runtime.refreshFailed,
    runtime.refreshing,
    runtime.streamState,
  ]);

  return (
    <div className="viewer-app">
      <header className="nav viewer-nav">
        <div className="nav-brand">
          MatriksOrder<span className="viewer-brand-accent"> Viewer</span>
        </div>
        <nav className="viewer-nav-links" aria-label="Primary navigation">
          <NavLink to="/bots">Bots</NavLink>
          <NavLink to="/book">The Book</NavLink>
          <NavLink to="/performance">Performance</NavLink>
        </nav>
        <div className="viewer-nav-status">
          <div className={`freshness ${freshness.className}`} aria-live="polite">
            <span className="freshness-dot" aria-hidden="true" />
            {freshness.copy}
          </div>
          <button
            type="button"
            className="btn btn-ghost header-icon"
            onClick={() => void runtime.requestRefresh()}
            disabled={runtime.refreshing || runtime.streamState !== 'live'}
            aria-label="Refresh the order snapshot"
            title="Refresh the order snapshot"
          >
            <ArrowClockwise className={runtime.refreshing ? 'refresh-spinning' : ''} size={15} />
          </button>
          <button
            type="button"
            className="btn btn-secondary header-logs"
            onClick={runtime.openLogs}
          >
            <TerminalWindow size={14} aria-hidden="true" />
            Logs
          </button>
        </div>
      </header>
      {runtime.streamState === 'down' ? (
        <aside className="stream-banner" role="alert">
          <div className="stream-banner-title">
            The order stream dropped
            {runtime.lastUpdateTime === null ? '' : ` after ${formatTime(runtime.lastUpdateTime)}`}
          </div>
          <p>
            Everything below is the last snapshot, timestamped and frozen. Actions are held until
            the stream reconnects and the snapshot can reconcile them.
          </p>
        </aside>
      ) : null}
      <main>{children}</main>
      <ToastRegion />
    </div>
  );
}

function ToastRegion() {
  const runtime = useViewerRuntime();
  return (
    <div className="toast-region" aria-label="Notifications" aria-live="polite">
      {runtime.toasts.map((toast) => (
        <div className={`toast toast-${toast.tone}`} key={toast.id} role="status">
          <div>
            <div className="toast-title">{toast.title}</div>
            <div className="toast-message">{toast.message}</div>
          </div>
          <button
            type="button"
            className="btn btn-ghost toast-close"
            onClick={() => runtime.dismissToast(toast.id)}
            aria-label={`Dismiss ${toast.title}`}
          >
            ×
          </button>
        </div>
      ))}
    </div>
  );
}
