import { CaretDown, CaretRight } from '@phosphor-icons/react';
import { useLayoutEffect, useRef, useState } from 'react';

import type { DiaryDateGroup, DiaryEvent } from '../../domain/diary';
import { formatClockTimeParts, formatDateKey, plural, weekdayName } from '../../domain/format';

interface DiaryListProps {
  groups: readonly DiaryDateGroup[];
}

/**
 * The entries under collapsible days, the Book's arrangement: the first day
 * opens itself and the rest wait behind their chevron, which is what keeps the
 * page quick across a year of them. `opened` is what a reader asked for and
 * `closed` is the first day they shut, so the default follows the first day
 * whatever the filters and the sort make it.
 */
export function DiaryList({ groups }: DiaryListProps) {
  const [opened, setOpened] = useState<ReadonlySet<string>>(new Set());
  const [closed, setClosed] = useState<ReadonlySet<string>>(new Set());
  const collapseAnchor = useRef<{ heading: HTMLButtonElement; top: number } | null>(null);

  useLayoutEffect(() => {
    const anchor = collapseAnchor.current;
    if (!anchor) return;
    collapseAnchor.current = null;
    // Collapsing releases the sticky heading back into normal flow. Keep its
    // viewport position before paint; the browser clamps at the page edges.
    const shift = anchor.heading.getBoundingClientRect().top - anchor.top;
    if (shift !== 0) window.scrollBy({ top: shift, behavior: 'instant' });
  }, [opened, closed]);

  return (
    <div
      className="diary-list"
      role="table"
      aria-label="Diary entries"
      ref={measureDiaryNavigation}
    >
      {groups.map((group, index) => {
        const openByDefault = index === 0;
        const open = openByDefault ? !closed.has(group.date) : opened.has(group.date);
        const toggle = (heading: HTMLButtonElement) => {
          if (open) {
            collapseAnchor.current = { heading, top: heading.getBoundingClientRect().top };
            setOpened((current) => without(current, group.date));
            setClosed((current) => with_(current, group.date));
          } else {
            setOpened((current) => with_(current, group.date));
            setClosed((current) => without(current, group.date));
          }
        };
        return (
          <section className="diary-date-group" role="rowgroup" key={group.date}>
            <div className="diary-date-header">
              <button
                type="button"
                className="diary-date-heading"
                aria-expanded={open}
                onClick={(event) => toggle(event.currentTarget)}
              >
                {open ? (
                  <CaretDown size={14} weight="bold" aria-hidden="true" />
                ) : (
                  <CaretRight size={14} weight="bold" aria-hidden="true" />
                )}
                <span className="diary-date">{formatDateKey(group.date)}</span>
                <span className="kicker">{weekdayName(group.date)}</span>
                <span className="muted">{plural(group.events.length, 'entry', 'entries')}</span>
              </button>
              {open ? (
                <div className="diary-columns" role="row">
                  <div role="columnheader">time</div>
                  <div role="columnheader">bot / account</div>
                  <div role="columnheader">what happened</div>
                </div>
              ) : null}
            </div>
            {open ? group.events.map((event) => <DiaryRow event={event} key={event.id} />) : null}
          </section>
        );
      })}
    </div>
  );
}

function DiaryRow({ event }: { event: DiaryEvent }) {
  const { time, ms } = formatClockTimeParts(event.time);
  return (
    <div className={`diary-row diary-row-${event.kind}`} role="row">
      <span className="diary-time" role="cell">
        {time}
        <span className="diary-time-ms">.{ms}</span>
      </span>
      {/* Empty stays empty: an error the server could not attribute names nobody. */}
      <span className="diary-subject" role="cell">
        {event.subject}
      </span>
      <span className="diary-description" role="cell">
        {event.description.map((fragment, index) => (
          <span className={`diary-ink-${fragment.ink}`} key={index}>
            {fragment.text}
          </span>
        ))}
      </span>
    </div>
  );
}

/*
 * The day heading sticks below the app navigation, so its offset is tied to
 * whatever that navigation is currently as tall as — the status lines beside
 * the brand grow and shrink with the feeds. Scrolling itself stays in CSS.
 */
function measureDiaryNavigation(list: HTMLDivElement | null) {
  const navigation = list?.closest('.viewer-app')?.querySelector('.viewer-nav');
  if (!list || !navigation) return;
  const update = () =>
    list.style.setProperty('--diary-nav-height', `${navigation.getBoundingClientRect().height}px`);
  update();
  if (typeof ResizeObserver === 'undefined') return;
  const observer = new ResizeObserver(update);
  observer.observe(navigation, { box: 'border-box' });
  return () => observer.disconnect();
}

function with_(values: ReadonlySet<string>, value: string): ReadonlySet<string> {
  const next = new Set(values);
  next.add(value);
  return next;
}

function without(values: ReadonlySet<string>, value: string): ReadonlySet<string> {
  const next = new Set(values);
  next.delete(value);
  return next;
}
