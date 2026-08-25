import { useEffect, useState } from 'react';

const MINUTE_MS = 60_000;

/**
 * A shared wall clock that advances on the minute boundary.
 *
 * Relative copy ("Scheduled · in 2h 14m") is derived from `Date.now()` at
 * render, and the Book only renders when its data changes — a quiet snapshot
 * would otherwise keep printing the distance it had when the page loaded.
 * Ticking on the boundary rather than every 60s from mount keeps every row on
 * the same minute.
 */
export function useMinuteClock(): number {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    let timer = 0;
    const schedule = () => {
      const untilNextMinute = MINUTE_MS - (Date.now() % MINUTE_MS);
      timer = window.setTimeout(() => {
        setNow(Date.now());
        schedule();
      }, untilNextMinute);
    };
    schedule();
    return () => window.clearTimeout(timer);
  }, []);

  return now;
}
