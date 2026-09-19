import type { DiaryDateGroup, DiaryEvent } from './diary';
import { closeMinuteOn, isTradingDay, istanbulMinuteAt, type HolidayCalendar } from './calendar';
import { OPENING_MATCH_MINUTE, SESSION_GRACE_MINUTES } from './sessionHours';

export type DiaryTimelineBlock =
  | { kind: 'events'; events: DiaryEvent[] }
  | { kind: 'session'; time: number; edge: 'start' | 'end' };

export function diaryTimeRange(
  groups: readonly DiaryDateGroup[],
): { from: number; to: number } | null {
  let from = Infinity;
  let to = -Infinity;
  for (const group of groups) {
    for (const event of group.events) {
      if (event.time === null) continue;
      from = Math.min(from, event.time);
      to = Math.max(to, event.time);
    }
  }
  return from === Infinity ? null : { from, to };
}

/** Five-second spans anchored at the earliest event, stable in either reading order. */
export function diaryTimeline(
  group: DiaryDateGroup,
  calendar: HolidayCalendar | null,
  range: ReturnType<typeof diaryTimeRange>,
  newestFirst: boolean,
): DiaryTimelineBlock[] {
  if (group.date === null) {
    return group.events.map((event) => ({ kind: 'events', events: [event] }));
  }
  const entries: Array<
    | { kind: 'event'; time: number; event: DiaryEvent }
    | Extract<DiaryTimelineBlock, { kind: 'session' }>
  > = group.events.flatMap((event) =>
    event.time === null ? [] : [{ kind: 'event' as const, time: event.time, event }],
  );
  if (calendar !== null && range !== null && isTradingDay(group.date, calendar)) {
    for (const [edge, minute] of [
      ['start', OPENING_MATCH_MINUTE],
      ['end', closeMinuteOn(group.date, calendar) + SESSION_GRACE_MINUTES],
    ] as const) {
      const time = istanbulMinuteAt(group.date, minute);
      if (time >= range.from && time <= range.to) entries.push({ kind: 'session', time, edge });
    }
  }
  entries.sort(
    (left, right) =>
      left.time - right.time || (left.kind === right.kind ? 0 : left.kind === 'session' ? -1 : 1),
  );
  const blocks: DiaryTimelineBlock[] = [];
  for (const entry of entries) {
    if (entry.kind === 'session') {
      blocks.push(entry);
      continue;
    }
    const last = blocks.at(-1);
    if (last?.kind === 'events' && entry.time - last.events[0]!.time! <= 5_000) {
      last.events.push(entry.event);
    } else {
      blocks.push({ kind: 'events', events: [entry.event] });
    }
  }
  if (newestFirst) {
    blocks.reverse();
    for (const block of blocks) if (block.kind === 'events') block.events.reverse();
  }
  return blocks;
}
