import { ArrowClockwise, TerminalWindow } from '@phosphor-icons/react';
import { useQuery } from '@tanstack/react-query';
import { NavLink } from 'react-router-dom';
import { useEffect, useMemo, useState, type ReactNode } from 'react';

import { bistApi } from '../bistApi/client';
import { holidayCalendar } from '../domain/calendar';
import { formatRelativeAge, formatTime } from '../domain/format';
import { useInterruptingErrors } from '../app/dataHooks';
import { pricesFreshness } from '../app/priceFeed';
import { bistKeys } from '../app/queryKeys';
import { useViewerRuntime } from '../app/ViewerRuntime';

/** The price age is counted in seconds, so the header cannot read it off a minute clock. */
const CLOCK_MS = 5_000;

export function AppShell({ children }: { children: ReactNode }) {
  const runtime = useViewerRuntime();
  const [now, setNow] = useState(Date.now());
  const holidays = useQuery({ queryKey: bistKeys.holidays, queryFn: bistApi.getHolidays });

  useEffect(() => {
    const interval = window.setInterval(() => setNow(Date.now()), CLOCK_MS);
    return () => window.clearInterval(interval);
  }, []);

  const priceFreshness = useMemo(
    () =>
      pricesFreshness({
        now,
        holidays: holidayCalendar(holidays.data ?? []),
        required: runtime.requiredSymbols,
        prices: runtime.prices,
        streamState: runtime.priceStreamState,
        status: runtime.priceStatus,
        connectedSince: runtime.priceConnectedSince,
      }),
    [
      holidays.data,
      now,
      runtime.priceConnectedSince,
      runtime.priceStatus,
      runtime.priceStreamState,
      runtime.prices,
      runtime.requiredSymbols,
    ],
  );

  const freshness = useMemo(() => {
    if (runtime.streamState === 'down') {
      return { className: 'status-dead', copy: 'stream down · reconnecting' };
    }
    if (runtime.refreshing) return { className: 'status-wait', copy: 'Loading…' };
    if (runtime.refreshFailed) {
      return { className: 'status-warn', copy: 'refresh failed · snapshot unchanged' };
    }
    // This line is the order snapshot's age and nothing else. The prices carry their own line
    // beside it, because a stale price and a stale snapshot are different failures and the reader
    // has to be able to tell which one they are looking at.
    return {
      className: runtime.streamState === 'live' ? 'muted' : 'status-wait',
      copy:
        runtime.streamState === 'connecting'
          ? 'stream connecting'
          : runtime.lastUpdateTime === null
            ? 'waiting for first snapshot'
            : `updated ${formatRelativeAge(runtime.lastUpdateTime, now).toLowerCase()}`,
    };
  }, [now, runtime.lastUpdateTime, runtime.refreshFailed, runtime.refreshing, runtime.streamState]);

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
          {priceFreshness.copy === null ? null : (
            <div className={`freshness ${priceFreshness.className}`} aria-live="polite">
              <span className="freshness-dot" aria-hidden="true" />
              {priceFreshness.copy}
            </div>
          )}
          <div
            className={`freshness ${freshness.className}${runtime.refreshing ? ' is-refreshing' : ''}`}
            aria-live="polite"
          >
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
      <FeedInterrupt />
      <main>{children}</main>
      <ToastRegion />
    </div>
  );
}

function FeedInterrupt() {
  const rows = useInterruptingErrors();
  if (rows.length === 0) return null;
  const latest = [...rows].sort((left, right) => right.time - left.time)[0]!;
  return (
    <aside className="feed-interrupt" role="alert">
      <strong>{latest.type}</strong>
      <span>{latest.information}</span>
      <span className="muted">
        The account lists may look healthy while fills or cancels are happening unseen. Check the
        terminal before acting.
      </span>
    </aside>
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
