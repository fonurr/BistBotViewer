import type { DiaryDateGroup, DiaryEvent, DiaryFragment } from './diary';
import { closeMinuteOn, isTradingDay, istanbulMinuteAt, type HolidayCalendar } from './calendar';
import { OPENING_MATCH_MINUTE, SESSION_GRACE_MINUTES } from './sessionHours';

export type DiaryTimelineBlock =
  | { kind: 'events'; events: DiaryEvent[] }
  | { kind: 'session'; time: number; edge: 'start' | 'end' };

/** Presentation only: filtering and counts still refer to the individual events. */
export function diaryDisplayRows(events: readonly DiaryEvent[]): Array<{
  events: DiaryEvent[];
  description: DiaryFragment[];
}> {
  const grouped = new Map<string, DiaryEvent[]>();
  for (const event of events) {
    const key =
      event.kind === 'orders' && event.time !== null && event.symbol
        ? JSON.stringify([event.time, event.symbol, event.botId, event.accountKey])
        : `event:${event.id}`;
    const group = grouped.get(key) ?? [];
    group.push(event);
    grouped.set(key, group);
  }
  return [...grouped.values()].map((group) => ({
    events: group,
    description: combinedDescription(group),
  }));
}

function combinedDescription(events: readonly DiaryEvent[]): DiaryFragment[] {
  const first = events[0]!;
  if (events.length === 1) return first.description;
  // Order sentences start with symbol, space, side, space. Retain every distinct
  // action and its prices; share the tail only for an otherwise identical buy/sell pair.
  const tail = JSON.stringify(first.description.slice(4));
  if (
    events.length === 2 &&
    first.description[2]?.ink !== events[1]!.description[2]?.ink &&
    events.every((event) => JSON.stringify(event.description.slice(4)) === tail)
  ) {
    const [buy, sell] = [...events].sort((left, right) =>
      (left.description[2]?.text ?? '').localeCompare(right.description[2]?.text ?? ''),
    );
    return [
      ...buy!.description.slice(0, 3),
      { ink: 'text', text: ' / ' },
      ...sell!.description.slice(2),
    ];
  }
  return [
    ...first.description.slice(0, 2),
    ...events.flatMap((event, index) => {
      const phrase = event.description.slice(2);
      if (phrase.at(-1)?.text === '.') phrase.pop();
      return index === 0 ? phrase : [{ ink: 'text' as const, text: '; ' }, ...phrase];
    }),
    { ink: 'text', text: '.' },
  ];
}

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
