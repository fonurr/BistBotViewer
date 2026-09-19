import { describe, expect, it } from 'vitest';

import {
  makeAccount,
  makeAccountSnapshot,
  makeAccountTransaction,
  makeBot,
  makeBotHistoryEntry,
  makeBotSnapshot,
} from '../test/fixtures';
import type { ErrorRow } from '../bistApi/types';
import { accountIdentityKey } from './accounts';
import {
  buildDiary,
  diaryDates,
  diaryKindCounts,
  filterDiary,
  groupDiaryByDate,
  sortDiary,
  type DiaryEvent,
  type DiarySources,
} from './diary';

const DAY = '2026-08-25';
const noon = Date.parse('2026-08-25T09:00:00.000Z');

function sources(overrides: Partial<DiarySources> = {}): DiarySources {
  return {
    bots: [],
    accounts: [makeAccount()],
    botHistory: [],
    botSnapshots: [],
    accountSnapshots: [],
    accountTransactions: [],
    errors: [],
    ...overrides,
  };
}

/** The description as plain text, for assertions that are about the words. */
function say(event: DiaryEvent): string {
  return event.description.map((fragment) => fragment.text).join('');
}

describe('buildDiary', () => {
  it('drops an entry that cannot name its own instant', () => {
    const events = buildDiary(sources({ bots: [makeBot({ startTime: null })] }));
    expect(events).toEqual([]);
  });

  it('reads a bot with no superseded configuration as its own creation', () => {
    const events = buildDiary(sources({ bots: [makeBot({ id: 'solo', startTime: noon })] }));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: 'botHistory', botId: 'solo', time: noon, date: DAY });
    expect(say(events[0]!)).toBe('Bot created on ACC-1 · BRK-1');
  });

  it('says so rather than print an empty pair for an incomplete bot', () => {
    const events = buildDiary(
      sources({
        bots: [makeBot({ accountId: null, brokerageId: null, complete: false, startTime: noon })],
      }),
    );
    expect(say(events[0]!)).toBe('Bot created, account unset');
  });

  it('names only what a later configuration changed', () => {
    const created = Date.parse('2026-08-24T06:00:00.000Z');
    const events = buildDiary(
      sources({
        bots: [makeBot({ limit: 750_000, startTime: noon })],
        botHistory: [makeBotHistoryEntry({ startTime: created, endTime: noon })],
      }),
    );
    const change = events.find((event) => event.time === noon)!;
    expect(say(change)).toBe('limit: 500.000 → 750.000');
    // The creation is still its own entry, at its own instant.
    expect(say(events.find((event) => event.time === created)!)).toContain('Bot created');
  });

  it('reports an array change with colored plus and minus signs, never the whole list', () => {
    const created = Date.parse('2026-08-24T06:00:00.000Z');
    const events = buildDiary(
      sources({
        bots: [makeBot({ forbiddenStocks: ['THYAO', 'ASELS', 'BIMAS'], startTime: noon })],
        botHistory: [
          makeBotHistoryEntry({
            forbiddenStocks: ['THYAO', 'GARAN'],
            startTime: created,
            endTime: noon,
          }),
        ],
      }),
    );
    const change = events.find((event) => event.time === noon)!;
    expect(say(change)).toBe('forbidden: +ASELS, BIMAS, -GARAN');
    expect(change.description).toContainEqual({ ink: 'added', text: '+' });
    expect(change.description).toContainEqual({ ink: 'removed', text: '-' });
    expect(change.description).toContainEqual({ ink: 'value', text: 'ASELS, BIMAS' });
    expect(change.description).toContainEqual({ ink: 'value', text: 'GARAN' });
  });

  it('calls a lifted TL cap lifted rather than printing nothing', () => {
    const created = Date.parse('2026-08-24T06:00:00.000Z');
    const events = buildDiary(
      sources({
        bots: [makeBot({ limit: null, startTime: noon })],
        botHistory: [makeBotHistoryEntry({ startTime: created, endTime: noon })],
      }),
    );
    expect(say(events.find((event) => event.time === noon)!)).toBe('limit: 500.000 → lifted');
  });

  it('reads the active switch as a word, not as a boolean pair', () => {
    const created = Date.parse('2026-08-24T06:00:00.000Z');
    const events = buildDiary(
      sources({
        bots: [makeBot({ active: false, startTime: noon })],
        botHistory: [makeBotHistoryEntry({ startTime: created, endTime: noon })],
      }),
    );
    expect(say(events.find((event) => event.time === noon)!)).toBe('Deactivated');
  });

  it('drops a configuration entry whose only difference is its stamp', () => {
    const created = Date.parse('2026-08-24T06:00:00.000Z');
    const events = buildDiary(
      sources({
        bots: [makeBot({ startTime: noon })],
        botHistory: [makeBotHistoryEntry({ startTime: created, endTime: noon })],
      }),
    );
    expect(events.map((event) => event.time)).toEqual([created]);
  });

  it('leaves a zero out of a bot snapshot and keeps a negative remaining', () => {
    const events = buildDiary(
      sources({
        botSnapshots: [
          makeBotSnapshot({
            time: noon,
            scheduledBuysSize: 0,
            openBuysSize: 0,
            remainingBotBudget: -6_513.43,
          }),
        ],
      }),
    );
    expect(say(events[0]!)).toBe('budget: 500.000,00, held: 124.219,02, remaining: −6.513,43');
  });

  it('leaves a null out of an account snapshot, which is not a zero', () => {
    const events = buildDiary(
      sources({
        accountSnapshots: [
          makeAccountSnapshot({
            time: noon,
            cashBalance: null,
            stockTotal: null,
            dailyPnl: null,
            dailyPnlPercent: null,
            marginTrading: 'Kapalı',
          }),
        ],
      }),
    );
    expect(say(events[0]!)).toBe(
      'portfolio: 9.944.789,76, buying power: 75.433,64, margin: Kapalı',
    );
    expect(events[0]!.subject).toBe('ACC-1 · BRK-1');
  });

  it('says a cash movement in words and prints the figure unsigned', () => {
    const events = buildDiary(
      sources({
        accountTransactions: [
          makeAccountTransaction({ time: noon, amount: -1_250.75 }),
          makeAccountTransaction({ time: noon + 1, amount: 4_000 }),
        ],
      }),
    );
    expect(say(events.find((event) => event.time === noon)!)).toBe('1.250,75 TL withdrawn');
    expect(say(events.find((event) => event.time === noon + 1)!)).toBe('4.000,00 TL deposited');
  });

  it('carries an error by its type, and leaves an unattributed one with no subject', () => {
    const errors: ErrorRow[] = [
      {
        id: 7,
        time: noon,
        type: 'BarsDataError',
        information: 'the price source could not be read',
        accountId: null,
        brokerageId: null,
        context: null,
      },
    ];
    const events = buildDiary(sources({ errors }));
    expect(say(events[0]!)).toBe('BarsDataError');
    expect(events[0]!.subject).toBe('');
    expect(events[0]!.accountKey).toBeNull();
  });

  it('files a bot snapshot under the account the bot was on at that instant', () => {
    const moved = Date.parse('2026-08-25T08:00:00.000Z');
    const events = buildDiary(
      sources({
        bots: [makeBot({ accountId: 'ACC-2', startTime: moved })],
        botHistory: [
          makeBotHistoryEntry({
            accountId: 'ACC-1',
            startTime: Date.parse('2026-08-24T06:00:00.000Z'),
            endTime: moved,
          }),
        ],
        botSnapshots: [
          makeBotSnapshot({ id: 1, time: Date.parse('2026-08-25T07:00:00.000Z') }),
          makeBotSnapshot({ id: 2, time: Date.parse('2026-08-25T09:00:00.000Z') }),
        ],
      }),
    );
    const before = events.find((event) => event.id === 'botSnapshot:1')!;
    const after = events.find((event) => event.id === 'botSnapshot:2')!;
    expect(before.accountKey).toBe(accountIdentityKey('ACC-1', 'BRK-1'));
    expect(after.accountKey).toBe(accountIdentityKey('ACC-2', 'BRK-1'));
  });

  it('comes back newest first', () => {
    const events = buildDiary(
      sources({
        accountTransactions: [
          makeAccountTransaction({ time: noon }),
          makeAccountTransaction({ time: noon + 60_000 }),
        ],
      }),
    );
    expect(events.map((event) => event.time)).toEqual([noon + 60_000, noon]);
    expect(sortDiary(events, false).map((event) => event.time)).toEqual([noon, noon + 60_000]);
  });
});

describe('filterDiary', () => {
  const events = buildDiary(
    sources({
      bots: [makeBot({ id: 'bot-alpha', startTime: noon })],
      botSnapshots: [makeBotSnapshot({ botId: 'bot-alpha', time: noon })],
      accountSnapshots: [makeAccountSnapshot({ time: noon })],
      errors: [
        {
          id: 1,
          time: noon,
          type: 'BarsDataError',
          information: '',
          accountId: null,
          brokerageId: null,
          context: null,
        },
      ],
    }),
  );
  const everything = {
    kinds: null,
    botFilter: false,
    botIds: null,
    accountFilter: false,
    accountKeys: null,
    from: null,
    to: null,
  };

  it('asks neither entity axis while its switch is off', () => {
    const kept = filterDiary(events, { ...everything, botIds: new Set<string>() });
    expect(kept).toHaveLength(events.length);
  });

  it('drops an entry that names no bot once the bot filter is switched on', () => {
    const kept = filterDiary(events, { ...everything, botFilter: true });
    // Every bot the page knows is ticked, and the two unattributed entries
    // still go: neither is about a bot at all.
    expect(kept.map((event) => event.kind).sort()).toEqual(['botHistory', 'botSnapshots']);
  });

  it('keeps nothing on the bot axis with the switch on and nothing ticked', () => {
    expect(
      filterDiary(events, { ...everything, botFilter: true, botIds: new Set<string>() }),
    ).toEqual([]);
  });

  it('narrows a bot entry through the account the bot was on', () => {
    const kept = filterDiary(events, {
      ...everything,
      accountFilter: true,
      accountKeys: new Set([accountIdentityKey('ACC-9', 'BRK-9')]),
    });
    // Nothing survives: the attributed entries all name ACC-1, and the error
    // the server could not attribute names no account at all.
    expect(kept).toEqual([]);
  });

  it('drops an unattributed error while the account filter is on', () => {
    const kept = filterDiary(events, {
      ...everything,
      accountFilter: true,
      accountKeys: new Set([accountIdentityKey('ACC-1', 'BRK-1')]),
    });
    expect(kept.map((event) => event.kind)).not.toContain('errors');
    expect(kept.map((event) => event.kind).sort()).toEqual([
      'accountSnapshots',
      'botHistory',
      'botSnapshots',
    ]);
  });

  it('reads both ends of the day range inclusively', () => {
    expect(filterDiary(events, { ...everything, from: DAY, to: DAY })).toHaveLength(events.length);
    expect(filterDiary(events, { ...everything, from: '2026-08-26', to: null })).toEqual([]);
  });

  it('counts a kind under the rest of the toolbar but not under its own ticks', () => {
    const counts = diaryKindCounts(events, {
      botFilter: true,
      botIds: null,
      accountFilter: false,
      accountKeys: null,
      from: null,
      to: null,
    });
    // The bot switch is on with every bot ticked, so a kind that names a bot
    // still counts and one that never does has nothing left to contribute.
    expect(counts.get('botSnapshots')).toBe(1);
    expect(counts.get('accountSnapshots')).toBe(0);
  });
});

describe('groupDiaryByDate', () => {
  it('keeps simultaneous buys and sells together by symbol without moving other times', () => {
    const orderEvents: DiaryEvent[] = [
      ['a-buy', 'AKBNK', noon],
      ['b-buy', 'THYAO', noon],
      ['c-sell', 'AKBNK', noon],
      ['d-sell', 'THYAO', noon],
      ['e-later', 'AKBNK', noon + 1],
    ].map(([id, symbol, time]) => ({
      id: String(id),
      symbol: String(symbol),
      time: Number(time),
      date: DAY,
      kind: 'orders',
      botId: 'bot',
      accountKey: null,
      subject: 'bot',
      description: [],
    }));
    for (const newestFirst of [true, false]) {
      const sorted = groupDiaryByDate(orderEvents, newestFirst)[0]!.events;
      const simultaneous = sorted.filter((event) => event.time === noon);
      expect(simultaneous[0]!.symbol).toBe(simultaneous[1]!.symbol);
      expect(simultaneous[2]!.symbol).toBe(simultaneous[3]!.symbol);
      expect(sorted[newestFirst ? 0 : 4]!.id).toBe('e-later');
    }
  });
  const earlier = Date.parse('2026-08-24T09:00:00.000Z');
  const events = buildDiary(
    sources({
      accountTransactions: [
        makeAccountTransaction({ time: earlier }),
        makeAccountTransaction({ time: noon }),
        makeAccountTransaction({ time: noon + 1_000 }),
      ],
    }),
  );

  it('orders the days and the entries inside them the same way', () => {
    const newest = groupDiaryByDate(events, true);
    expect(newest.map((group) => group.date)).toEqual(['2026-08-25', '2026-08-24']);
    expect(newest[0]!.events.map((event) => event.time)).toEqual([noon + 1_000, noon]);

    const oldest = groupDiaryByDate(events, false);
    expect(oldest.map((group) => group.date)).toEqual(['2026-08-24', '2026-08-25']);
    expect(oldest[1]!.events.map((event) => event.time)).toEqual([noon, noon + 1_000]);
  });

  it('offers every day an entry falls on, ascending', () => {
    expect(diaryDates(events)).toEqual(['2026-08-24', '2026-08-25']);
  });
});
