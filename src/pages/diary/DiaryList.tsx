import { CaretDown, CaretRight } from '@phosphor-icons/react';
import { useLayoutEffect, useRef, useState } from 'react';

import type { DiaryDateGroup, DiaryEvent, DiaryFragment } from '../../domain/diary';
import type { HolidayCalendar } from '../../domain/calendar';
import { diaryDisplayRows, diaryTimeRange, diaryTimeline } from '../../domain/diaryTimeline';
import {
  formatClockTimeParts,
  formatDateKey,
  formatTime,
  plural,
  weekdayName,
} from '../../domain/format';

interface DiaryListProps {
  groups: readonly DiaryDateGroup[];
  calendar: HolidayCalendar | null;
  newestFirst: boolean;
}

/**
 * The entries under collapsible days, the Book's arrangement: the first day
 * opens itself and the rest wait behind their chevron, which is what keeps the
 * page quick across a year of them. `opened` is what a reader asked for and
 * `closed` is the first day they shut, so the default follows the first day
 * whatever the filters and the sort make it.
 */
export function DiaryList({ groups, calendar, newestFirst }: DiaryListProps) {
  const [opened, setOpened] = useState<ReadonlySet<string>>(new Set());
  const [closed, setClosed] = useState<ReadonlySet<string>>(new Set());
  const collapseAnchor = useRef<{ heading: HTMLButtonElement; top: number } | null>(null);
  const range = diaryTimeRange(groups);

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
        const groupKey = group.date ?? 'untimed';
        const openByDefault = index === 0 || group.date === null;
        const open = openByDefault ? !closed.has(groupKey) : opened.has(groupKey);
        const toggle = (heading: HTMLButtonElement) => {
          if (open) {
            collapseAnchor.current = { heading, top: heading.getBoundingClientRect().top };
            setOpened((current) => without(current, groupKey));
            setClosed((current) => with_(current, groupKey));
          } else {
            setOpened((current) => with_(current, groupKey));
            setClosed((current) => without(current, groupKey));
          }
        };
        return (
          <section className="diary-date-group" role="rowgroup" key={groupKey}>
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
                <span className="diary-date">
                  {group.date === null ? 'Fill time unavailable' : formatDateKey(group.date)}
                </span>
                <span className="kicker">
                  {group.date === null ? 'outside the date range' : weekdayName(group.date)}
                </span>
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
            {open
              ? diaryTimeline(group, calendar, range, newestFirst).map((block, index, blocks) =>
                  block.kind === 'events' ? (
                    <div
                      className={`diary-event-cluster${
                        blocks[index - 1]?.kind === 'session'
                          ? ' diary-event-cluster-after-session'
                          : ''
                      }${
                        blocks[index + 1]?.kind === 'session'
                          ? ' diary-event-cluster-before-session'
                          : ''
                      }`}
                      key={block.events[0]!.id}
                    >
                      {diaryDisplayRows(block.events).map((row) => (
                        <DiaryRow
                          event={row.events[0]!}
                          description={row.description}
                          key={row.events[0]!.id}
                        />
                      ))}
                    </div>
                  ) : (
                    <div
                      role="row"
                      className="diary-session-boundary"
                      key={`session:${block.edge}`}
                    >
                      <div role="cell" aria-colspan={3}>
                        <hr aria-label={`Session ${block.edge} ${formatTime(block.time)}`} />
                      </div>
                    </div>
                  ),
                )
              : null}
          </section>
        );
      })}
    </div>
  );
}

function DiaryRow({ event, description }: { event: DiaryEvent; description: DiaryFragment[] }) {
  const clock = event.time === null ? null : formatClockTimeParts(event.time);
  return (
    <div className={`diary-row diary-row-${event.kind}`} role="row">
      <span className="diary-time" role="cell">
        {clock?.time}
        {clock ? <span className="diary-time-ms">.{clock.ms}</span> : null}
      </span>
      {/* Empty stays empty: an error the server could not attribute names nobody. */}
      <span className="diary-subject" role="cell">
        {event.subject}
      </span>
      {event.descriptionColumns ? (
        <span className="diary-description diary-account-description" role="cell">
          {event.descriptionColumns.map((column, columnIndex) => (
            <span className="diary-account-column" key={columnIndex}>
              {column.map((metric, metricIndex) => (
                <span className="diary-account-metric" key={metricIndex}>
                  <DiaryFragments fragments={metric} />
                </span>
              ))}
            </span>
          ))}
        </span>
      ) : (
        <span className="diary-description" role="cell">
          <DiaryFragments fragments={description} />
        </span>
      )}
    </div>
  );
}

function DiaryFragments({ fragments }: { fragments: readonly DiaryFragment[] }) {
  return fragments.map((fragment, index) =>
    fragment.superscript ? (
      <sup className={`diary-ink-${fragment.ink} diary-day-offset`} key={index}>
        {fragment.text}
      </sup>
    ) : (
      <span className={`diary-ink-${fragment.ink}`} key={index}>
        {fragment.text}
      </span>
    ),
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
