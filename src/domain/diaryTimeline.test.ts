import { describe, expect, it } from 'vitest';
import { holidayCalendar } from './calendar';
import type { DiaryDateGroup, DiaryEvent } from './diary';
import { diaryDisplayRows, diaryTimeline, diaryTimeRange } from './diaryTimeline';
import { diaryOrderEvents } from './diaryOrders';
import { makeActiveOrder } from '../test/fixtures';

const date = '2026-08-25';
const at = (clock: string, day = date) => Date.parse(`${day}T${clock}+03:00`);
function group(clocks: string[], day: string | null = date): DiaryDateGroup {
  return {
    date: day,
    events: clocks.map((clock, index): DiaryEvent => ({
      id: `${day}:${index}`,
      kind: 'orders',
      time: day === null ? null : at(clock, day),
      date: day,
      botId: 'bot',
      accountKey: null,
      subject: 'bot',
      description: [],
    })),
  };
}

describe('simultaneous order rows', () => {
  const orders = (overrides: Parameters<typeof makeActiveOrder>[0][]) =>
    diaryOrderEvents(
      {
        activeOrders: overrides.map((override, index) =>
          makeActiveOrder({ id: index, clientOrderId: `order-${index}`, ...override }),
        ),
        canceledOrders: [],
        positions: [],
        closedTrades: [],
      },
      () => 'account',
    );
  const say = (row: ReturnType<typeof diaryDisplayRows>[number]) =>
    row.description.map((part) => part.text).join('');

  it('puts identical buy and sell events in one row and shares their details', () => {
    const events = orders([{ direction: 'sell' }, { direction: 'buy' }]);
    const rows = diaryDisplayRows(events);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.events).toHaveLength(2);
    expect(say(rows[0]!)).toBe('AKBNK buy / sell sent, market price 68,10.');
    expect(
      rows[0]!.description
        .filter((part) => part.ink === 'buy' || part.ink === 'sell')
        .map((part) => part.ink),
    ).toEqual(['buy', 'sell']);
    expect(diaryDisplayRows(events.slice(0, 1))[0]!.description).toEqual(events[0]!.description);
  });

  it('keeps different scheduled times and prices in the combined row', () => {
    const events = orders([
      { sentTime: null, scheduledTime: at('10:00:00'), orderPrice: 100 },
      { sentTime: null, direction: 'sell', scheduledTime: at('18:00:00'), orderPrice: 110 },
    ]);
    const rows = diaryDisplayRows(events);
    expect(rows).toHaveLength(1);
    expect(say(rows[0]!)).toBe(
      'AKBNK buy scheduled for 10:00:00, order price 100,00; sell scheduled for 18:00:00, order price 110,00.',
    );
  });

  it('does not combine different symbols, bots, timestamps, accounts or untimed fills', () => {
    const events = orders([
      {},
      { symbol: 'THYAO' },
      { botId: 'other' },
      { sentTime: at('11:00:00') },
    ]);
    events.push({ ...events[0]!, id: 'account', accountKey: 'other' });
    events.push({ ...events[0]!, id: 'untimed1', time: null, date: null });
    events.push({ ...events[0]!, id: 'untimed2', time: null, date: null });
    expect(diaryDisplayRows(events)).toHaveLength(7);
  });
});

describe('Diary time separators', () => {
  it('groups spans of at most five seconds, independent of sort, and keeps singletons', () => {
    const day = group(['10:00:00', '10:00:04', '10:00:05', '10:00:08', '10:01:00']);
    for (const newest of [true, false]) {
      const blocks = diaryTimeline(day, new Map(), diaryTimeRange([day]), newest);
      const sizes = blocks.map((block) => (block.kind === 'events' ? block.events.length : 0));
      expect(sizes).toEqual(newest ? [1, 1, 3] : [3, 1, 1]);
    }
  });

  it.each([
    [date, [], ['09:55:00', '18:10:00']],
    [date, [{ date, type: 'half' as const }], ['09:55:00', '12:40:00']],
    [date, [{ date, type: 'full' as const }], []],
    ['2026-08-23', [], []],
  ])('places only trading-session boundaries on %s', (day, holidays, expected) => {
    const events = group(['09:00:00', '19:00:00'], day);
    const blocks = diaryTimeline(
      events,
      holidayCalendar(holidays),
      diaryTimeRange([events]),
      false,
    );
    expect(blocks.flatMap((block) => (block.kind === 'session' ? [block.time] : []))).toEqual(
      expected.map((clock) => at(clock, day)),
    );
    const descending = diaryTimeline(
      events,
      holidayCalendar(holidays),
      diaryTimeRange([events]),
      true,
    );
    expect(descending.map((block) => block.kind)).toEqual(
      blocks.map((block) => block.kind).reverse(),
    );
  });

  it('clips boundaries to the actual visible time range and includes an exact endpoint', () => {
    const day = group(['09:55:00', '11:00:00']);
    expect(
      diaryTimeline(day, new Map(), diaryTimeRange([day]), false).filter(
        (block) => block.kind === 'session',
      ),
    ).toEqual([{ kind: 'session', edge: 'start', time: at('09:55:00') }]);
    const middle = group(['10:00:00', '11:00:00']);
    expect(
      diaryTimeline(middle, new Map(), diaryTimeRange([middle]), false).every(
        (block) => block.kind === 'events',
      ),
    ).toBe(true);
  });

  it('splits a five-second cluster at a session boundary', () => {
    const day = group(['09:54:59', '09:55:01']);
    expect(
      diaryTimeline(day, new Map(), diaryTimeRange([day]), false).map((block) => block.kind),
    ).toEqual(['events', 'session', 'events']);
  });

  it('uses the whole filtered list range across days, not each day in isolation', () => {
    const earlier = group(['19:00:00'], '2026-08-24');
    const later = group(['11:00:00']);
    const range = diaryTimeRange([earlier, later]);
    expect(
      diaryTimeline(later, new Map(), range, false).filter((block) => block.kind === 'session'),
    ).toEqual([{ kind: 'session', edge: 'start', time: at('09:55:00') }]);
  });

  it('does not invent sessions without the calendar or time groups for untimed fills', () => {
    const day = group(['09:00:00', '19:00:00']);
    expect(
      diaryTimeline(day, null, diaryTimeRange([day]), false).every(
        (block) => block.kind === 'events',
      ),
    ).toBe(true);
    const untimed = group(['', ''], null);
    expect(diaryTimeRange([untimed])).toBeNull();
    expect(
      diaryTimeline(untimed, new Map(), null, true).map(
        (block) => block.kind === 'events' && block.events.length,
      ),
    ).toEqual([1, 1]);
  });
});
