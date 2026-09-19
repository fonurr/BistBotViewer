import type {
  Account,
  AccountSnapshot,
  AccountTransaction,
  Bot,
  BotHistoryEntry,
  BotSnapshot,
  ErrorRow,
} from '../bistApi/types';
import type { BookChainSources } from './chains';
import { diaryOrderEvents, type DiaryOrderStage } from './diaryOrders';
import { accountIdentityKey } from './accounts';
import { formatNumber, formatPercentage, formatSignedNumber, toIstanbulDateKey } from './format';

/**
 * The records the server writes down, including order lifecycle events. Each is one kind
 * of diary entry, and the type filter ticks them by these keys.
 */
export type DiaryKind =
  'botHistory' | 'botSnapshots' | 'accountSnapshots' | 'accountTransactions' | 'errors' | 'orders';

export const DIARY_KINDS: readonly DiaryKind[] = [
  'botHistory',
  'botSnapshots',
  'accountSnapshots',
  'accountTransactions',
  'errors',
  'orders',
];

export const diaryKindLabels: Readonly<Record<DiaryKind, string>> = {
  botHistory: 'Bot history',
  botSnapshots: 'Bot snapshots',
  accountSnapshots: 'Account snapshots',
  accountTransactions: 'Account transactions',
  errors: 'Errors',
  orders: 'Orders',
};

/**
 * The inks a description is written in. A reader has to be able to tell a field
 * name from the figure behind it at a glance, and an array delta from either —
 * so the sentence is built as fragments and the page colors them, rather than
 * as one string a stylesheet could never take apart again.
 */
export type DiaryInk = 'text' | 'field' | 'value' | 'added' | 'removed' | 'wait' | 'buy' | 'sell';

export interface DiaryFragment {
  ink: DiaryInk;
  text: string;
  superscript?: boolean;
}

export interface DiaryEvent {
  /** Stable across re-reads: nothing here is keyed by list position. */
  id: string;
  kind: DiaryKind;
  /** Null only for confirmed fills whose observation time was not stored. Otherwise the event's own instant — the one thing that makes it an event at all. */
  time: number | null;
  /** Null fills live in a separate untimed group. The Istanbul calendar day `time` falls on. Filtering and grouping read this. */
  date: string | null;
  /** The bot the entry is about, where it is about one. */
  botId: string | null;
  /** `accountIdentityKey` of the account it is about, where one is known. */
  accountKey: string | null;
  /** What the bot/account column prints — the bot id, or `accountId · brokerageId`. */
  subject: string;
  symbol?: string;
  origin?: string | null;
  orderStage?: DiaryOrderStage;
  description: DiaryFragment[];
}

const text = (value: string): DiaryFragment => ({ ink: 'text', text: value });
const field = (value: string): DiaryFragment => ({ ink: 'field', text: value });
const value = (raw: string): DiaryFragment => ({ ink: 'value', text: raw });

/** A bot's configuration as one link in its timeline, newest last. */
interface ConfigLink {
  config: Bot;
  startTime: number | null;
}

/** Which account a bot was bound to across one span of its life. */
interface AccountSpan {
  from: number;
  accountKey: string | null;
}

export interface DiarySources {
  orders?: BookChainSources;
  bots: readonly Bot[];
  accounts: readonly Account[];
  botHistory: readonly BotHistoryEntry[];
  botSnapshots: readonly BotSnapshot[];
  accountSnapshots: readonly AccountSnapshot[];
  accountTransactions: readonly AccountTransaction[];
  errors: readonly ErrorRow[];
}

/**
 * Every diary entry the loaded reads can account for, newest first.
 *
 * **An entry that cannot name its own instant is not an entry.** A bot whose
 * oldest configuration carries no `startTime` was configured before the server
 * recorded it — that is "not known", never zero and never the beginning of
 * time — so the entry is dropped rather than filed under a day it invented.
 */
export function buildDiary(sources: DiarySources): DiaryEvent[] {
  const timelines = botTimelines(sources.bots, sources.botHistory);
  const accountSpans = botAccountSpans(timelines);
  const events = [
    ...botHistoryEvents(timelines),
    ...botSnapshotEvents(sources.botSnapshots, accountSpans),
    ...accountSnapshotEvents(sources.accountSnapshots),
    ...accountTransactionEvents(sources.accountTransactions),
    ...errorEvents(sources.errors),
    ...(sources.orders
      ? diaryOrderEvents(sources.orders, (botId, time) =>
          time === null ? null : accountKeyAt(accountSpans.get(botId), time),
        )
      : []),
  ];
  return events.sort(byNewestFirst);
}

/** Newest first; simultaneous order events stay together by symbol, across both sides. */
function byNewestFirst(left: DiaryEvent, right: DiaryEvent): number {
  if (left.time === null && right.time !== null) return 1;
  if (right.time === null && left.time !== null) return -1;
  if (left.time !== null && right.time !== null && left.time !== right.time)
    return right.time - left.time;
  if (left.kind !== right.kind) return left.kind.localeCompare(right.kind);
  if (left.kind === 'orders') {
    const symbolOrder = (left.symbol ?? '').localeCompare(right.symbol ?? '');
    if (symbolOrder !== 0) return symbolOrder;
  }
  return left.id.localeCompare(right.id);
}

export function sortDiary(events: readonly DiaryEvent[], newestFirst: boolean): DiaryEvent[] {
  const sorted = [...events].sort(byNewestFirst);
  return newestFirst ? sorted : sorted.reverse();
}

/**
 * One bot's whole configuration life, oldest first: the superseded entries as
 * `GetBotHistory` gives them, then the current record from `GetBots`. The
 * server's own chaining is what joins them — the newest history item's
 * `endTime` is the current configuration's `startTime` — so nothing here has to
 * guess where one span ends.
 */
function botTimelines(
  bots: readonly Bot[],
  history: readonly BotHistoryEntry[],
): Map<string, ConfigLink[]> {
  const timelines = new Map<string, ConfigLink[]>();
  for (const entry of history) {
    const links = timelines.get(entry.id) ?? [];
    links.push({ config: entry, startTime: entry.startTime ?? null });
    timelines.set(entry.id, links);
  }
  for (const bot of bots) {
    const links = timelines.get(bot.id) ?? [];
    links.push({ config: bot, startTime: bot.startTime ?? null });
    timelines.set(bot.id, links);
  }
  for (const links of timelines.values()) {
    /* Oldest first. A link with no start is the one the server never recorded a
       beginning for, and only a bot's oldest link can be it, so it leads. */
    links.sort((left, right) => {
      if (left.startTime === right.startTime) return 0;
      if (left.startTime === null) return -1;
      if (right.startTime === null) return 1;
      return left.startTime - right.startTime;
    });
  }
  return timelines;
}

/**
 * Which account each bot was bound to, as spans opened by the configuration
 * that set it. A snapshot is a moment a bot had a budget, and a budget is
 * charged against an account — so it is filed under the account the bot was on
 * *then*, not the one it is on now.
 */
function botAccountSpans(timelines: ReadonlyMap<string, ConfigLink[]>): Map<string, AccountSpan[]> {
  const spans = new Map<string, AccountSpan[]>();
  for (const [botId, links] of timelines) {
    spans.set(
      botId,
      links.map((link) => ({
        from: link.startTime ?? Number.NEGATIVE_INFINITY,
        accountKey: configAccountKey(link.config),
      })),
    );
  }
  return spans;
}

function configAccountKey(config: Bot): string | null {
  if (!config.accountId || !config.brokerageId) return null;
  return accountIdentityKey(config.accountId, config.brokerageId);
}

function accountKeyAt(spans: readonly AccountSpan[] | undefined, time: number): string | null {
  if (!spans || spans.length === 0) return null;
  let resolved: string | null = spans[0]!.accountKey;
  for (const span of spans) {
    if (span.from > time) break;
    resolved = span.accountKey;
  }
  return resolved;
}

/**
 * The configuration entries. A bot's first link is its creation; every later
 * one is a `ConfigureBot` that changed something, and says only what changed.
 */
function botHistoryEvents(timelines: ReadonlyMap<string, ConfigLink[]>): DiaryEvent[] {
  const events: DiaryEvent[] = [];
  for (const [botId, links] of timelines) {
    links.forEach((link, index) => {
      const time = link.startTime;
      if (time === null) return;
      const previous = index === 0 ? null : links[index - 1]!.config;
      const description =
        previous === null ? creationDescription(link.config) : configDiff(previous, link.config);
      // A ConfigureBot that moved nothing this page reads about — only a date —
      // is not something to report as a change it cannot name.
      if (description.length === 0) return;
      events.push({
        id: `botHistory:${botId}:${time}:${index}`,
        kind: 'botHistory',
        time,
        date: toIstanbulDateKey(time),
        botId,
        accountKey: configAccountKey(link.config),
        subject: botId,
        description,
      });
    });
  }
  return events;
}

function creationDescription(config: Bot): DiaryFragment[] {
  if (!config.accountId || !config.brokerageId) {
    /* An incomplete bot names no account yet. Saying so is the fact; inventing
       one, or printing an empty pair, would not be. */
    return [text('Bot created, account unset')];
  }
  return [text('Bot created on '), value(`${config.accountId} · ${config.brokerageId}`)];
}

/** The configuration fields worth reporting, in the order a reader scans them. */
const CONFIG_FIELDS = [
  'algoritmId',
  'accountId',
  'brokerageId',
  'active',
  'limit',
  'limitPercentage',
  'limitPerPosition',
  'limitPercentagePerPosition',
  'forbiddenStocks',
  'emails',
  'description',
] as const;

type ConfigField = (typeof CONFIG_FIELDS)[number];

const CONFIG_LABELS: Readonly<Record<ConfigField, string>> = {
  algoritmId: 'algorithm',
  accountId: 'account',
  brokerageId: 'brokerage',
  active: 'active',
  limit: 'limit',
  limitPercentage: 'limit %',
  limitPerPosition: 'per-position limit',
  limitPercentagePerPosition: 'per-position %',
  forbiddenStocks: 'forbidden',
  emails: 'emails',
  description: 'description',
};

const ARRAY_FIELDS: ReadonlySet<ConfigField> = new Set(['forbiddenStocks', 'emails']);

/**
 * What one `ConfigureBot` changed, and nothing else. The stamps are left out —
 * they are the entry's own time, which the row already prints — and `complete`
 * with them, since it is computed from the four fields above it rather than
 * configured.
 */
export function configDiff(previous: Bot, next: Bot): DiaryFragment[] {
  const parts: DiaryFragment[][] = [];
  for (const key of CONFIG_FIELDS) {
    if (ARRAY_FIELDS.has(key)) {
      const delta = arrayDelta(
        (previous[key] as string[] | null) ?? [],
        (next[key] as string[] | null) ?? [],
      );
      if (delta.length > 0) parts.push([field(CONFIG_LABELS[key]), text(': '), ...delta]);
      continue;
    }
    if (previous[key] === next[key]) continue;
    if (key === 'active') {
      parts.push([text(next.active ? 'Activated' : 'Deactivated')]);
      continue;
    }
    parts.push([
      field(CONFIG_LABELS[key]),
      text(': '),
      value(configValue(key, previous[key])),
      text(' → '),
      value(configValue(key, next[key])),
    ]);
  }
  return joinFragments(parts, ' · ');
}

/**
 * A stored value in the form the field is read in. A lifted TL cap is `null`
 * upstream and the word `lifted` here, because `null` is a value on those two
 * fields rather than a missing one — it says the percentage beside it is the
 * bot's only cap on that axis.
 */
function configValue(key: ConfigField, raw: unknown): string {
  if (key === 'limit' || key === 'limitPerPosition') {
    return raw === null ? 'lifted' : formatNumber(Number(raw), 0);
  }
  if (key === 'limitPercentage' || key === 'limitPercentagePerPosition') {
    return formatPercentage(Number(raw), 0, false);
  }
  if (raw === null || raw === '') return 'unset';
  return String(raw).replace(/\s+/g, ' ').trim();
}

/** What an array gained and lost, never the whole list again. */
function arrayDelta(previous: readonly string[], next: readonly string[]): DiaryFragment[] {
  const before = new Set(previous);
  const after = new Set(next);
  const added = next.filter((entry) => !before.has(entry));
  const removed = previous.filter((entry) => !after.has(entry));
  const parts: DiaryFragment[][] = [];
  if (added.length > 0) {
    parts.push([{ ink: 'added', text: `+${added.join(', ')}` }]);
  }
  if (removed.length > 0) {
    parts.push([{ ink: 'removed', text: `-${removed.join(', ')}` }]);
  }
  return joinFragments(parts, ', ');
}

/**
 * The figures on a bot's budget at one instant. A zero is left out on purpose:
 * every one of these is a size, and a size of nothing is not news — what a
 * reader is after is which of them the bot was carrying.
 */
const BOT_SNAPSHOT_FIELDS: readonly { key: keyof BotSnapshot; label: string }[] = [
  { key: 'totalBotBudget', label: 'budget' },
  { key: 'heldPositionsSize', label: 'held' },
  { key: 'scheduledBuysSize', label: 'scheduled buys' },
  { key: 'openBuysSize', label: 'open buys' },
  { key: 'remainingBotBudget', label: 'remaining' },
];

function botSnapshotEvents(
  snapshots: readonly BotSnapshot[],
  accountSpans: ReadonlyMap<string, AccountSpan[]>,
): DiaryEvent[] {
  return snapshots.map((snapshot) => ({
    id: `botSnapshot:${snapshot.id}`,
    kind: 'botSnapshots' as const,
    time: snapshot.time,
    date: toIstanbulDateKey(snapshot.time),
    botId: snapshot.botId,
    accountKey: accountKeyAt(accountSpans.get(snapshot.botId), snapshot.time),
    subject: snapshot.botId,
    description: joinFragments(
      BOT_SNAPSHOT_FIELDS.flatMap(({ key, label }) => {
        const figure = snapshot[key];
        if (typeof figure !== 'number' || figure === 0) return [];
        // `remainingBotBudget` may be negative, and that says the bot is over its
        // limit — worth seeing with its sign rather than flattened.
        return [[field(label), text(': '), value(formatNumber(figure, 2))]];
      }),
      ', ',
    ),
  }));
}

/**
 * What the terminal reported about an account at one instant. A `null` here is
 * an entry the brokerage did not send — not a zero — so it is left out for the
 * same reason a zero is: neither is something that moved.
 */
const ACCOUNT_SNAPSHOT_FIELDS: readonly {
  key: keyof AccountSnapshot;
  label: string;
  format?: 'percent' | 'signed' | 'text';
}[] = [
  { key: 'portfolioValue', label: 'portfolio' },
  { key: 'portfolioValueExcludingForbidden', label: 'portfolio ex-forbidden' },
  { key: 'buyingPower', label: 'buying power' },
  { key: 'cashBalance', label: 'cash' },
  { key: 'stockTotal', label: 'stocks' },
  { key: 'fundTotal', label: 'funds' },
  { key: 'pendingSettlementT1', label: 'T+1' },
  { key: 'pendingSettlementT2', label: 'T+2' },
  { key: 'dailyPnl', label: 'daily P&L', format: 'signed' },
  { key: 'dailyPnlPercent', label: 'daily P&L %', format: 'percent' },
  { key: 'marginTrading', label: 'margin', format: 'text' },
];

function accountSnapshotEvents(snapshots: readonly AccountSnapshot[]): DiaryEvent[] {
  return snapshots.map((snapshot) => ({
    id: `accountSnapshot:${snapshot.id}`,
    kind: 'accountSnapshots' as const,
    time: snapshot.time,
    date: toIstanbulDateKey(snapshot.time),
    botId: null,
    accountKey: accountIdentityKey(snapshot.accountId, snapshot.brokerageId),
    subject: `${snapshot.accountId} · ${snapshot.brokerageId}`,
    description: joinFragments(
      ACCOUNT_SNAPSHOT_FIELDS.flatMap(({ key, label, format }) => {
        const figure = snapshot[key];
        if (format === 'text') {
          if (typeof figure !== 'string' || figure.trim() === '') return [];
          return [[field(label), text(': '), value(figure)]];
        }
        if (typeof figure !== 'number' || figure === 0) return [];
        const printed =
          format === 'percent'
            ? formatPercentage(figure, 2)
            : format === 'signed'
              ? formatSignedNumber(figure, 2)
              : formatNumber(figure, 2);
        return [[field(label), text(': '), value(printed)]];
      }),
      ', ',
    ),
  }));
}

/**
 * Cash in or out. The sign is the whole fact, so it is said in words and the
 * figure is printed unsigned — `1.250,75 TL withdrawn` is the sentence, not
 * `−1.250,75 TL`.
 */
function accountTransactionEvents(transactions: readonly AccountTransaction[]): DiaryEvent[] {
  return transactions.map((transaction, index) => ({
    // Transactions carry no id upstream, and two can share every other field,
    // so the position in the server's own ordering is part of the key.
    id: `accountTransaction:${index}:${transaction.time}`,
    kind: 'accountTransactions' as const,
    time: transaction.time,
    date: toIstanbulDateKey(transaction.time),
    botId: null,
    accountKey: accountIdentityKey(transaction.accountId, transaction.brokerageId),
    subject: `${transaction.accountId} · ${transaction.brokerageId}`,
    description: [
      value(`${formatNumber(Math.abs(transaction.amount), 2)} TL`),
      text(transaction.amount < 0 ? ' withdrawn' : ' deposited'),
    ],
  }));
}

/**
 * The stored errors, by their type alone. The text behind one belongs in the
 * log drawer, which is where a reader goes once the diary has told them an
 * error of that type happened at that minute.
 */
function errorEvents(errors: readonly ErrorRow[]): DiaryEvent[] {
  return errors.map((row) => ({
    id: `error:${row.id}`,
    kind: 'errors' as const,
    time: row.time,
    date: toIstanbulDateKey(row.time),
    botId: null,
    accountKey:
      row.accountId && row.brokerageId ? accountIdentityKey(row.accountId, row.brokerageId) : null,
    subject: row.accountId && row.brokerageId ? `${row.accountId} · ${row.brokerageId}` : '',
    description: [value(row.type)],
  }));
}

/** Fragment groups run together with one separator, in plain `text` ink. */
function joinFragments(groups: readonly DiaryFragment[][], separator: string): DiaryFragment[] {
  return groups.flatMap((group, index) => (index === 0 ? group : [text(separator), ...group]));
}

export interface DiaryFilter {
  symbols?: ReadonlySet<string>;
  symbolsExcluded?: boolean;
  originFilter?: boolean;
  origins?: ReadonlySet<string> | null;
  orderStageFilter?: boolean;
  orderStages?: ReadonlySet<string> | null;
  kinds: ReadonlySet<DiaryKind> | null;
  /** Whether the bot filter applies at all. Off, the bot axis is not asked. */
  botFilter: boolean;
  /** `null` is every bot, which is not the same set as every bot ticked. */
  botIds: ReadonlySet<string> | null;
  /** The same switch over the account axis. */
  accountFilter: boolean;
  accountKeys: ReadonlySet<string> | null;
  from: string | null;
  to: string | null;
}

/**
 * The entries a toolbar keeps.
 *
 * The bot and account filters each sit behind a switch, and each governs only
 * what it can name. **Off is not "every option" — it is the filter not being
 * asked**, and every entry passes it. On, an entry has to name a ticked
 * subject: an entry about a bot must have that bot ticked, an entry about an
 * account must have that account ticked, and an entry that names neither — an
 * error the server could not attribute, and for the bot axis an account
 * snapshot or a cash movement — is not about anything the filter asked for, so
 * it drops out even with every option ticked. A bot entry also carries the
 * account the bot was on at that instant, so narrowing to one account narrows
 * its bots with it.
 */
export function filterDiary(events: readonly DiaryEvent[], filter: DiaryFilter): DiaryEvent[] {
  return events.filter((event) => {
    if (filter.kinds !== null && !filter.kinds.has(event.kind)) return false;
    if (event.date !== null && filter.from !== null && event.date < filter.from) return false;
    if (event.date !== null && filter.to !== null && event.date > filter.to) return false;
    if (filter.botFilter && !ticked(event.botId, filter.botIds)) return false;
    if (filter.accountFilter && !ticked(event.accountKey, filter.accountKeys)) return false;
    if (filter.symbols?.size) {
      const matches = event.symbol !== undefined && filter.symbols.has(event.symbol);
      if (filter.symbolsExcluded ? matches : !matches) return false;
    }
    if (filter.originFilter && !ticked(event.origin ?? null, filter.origins ?? null)) return false;
    if (filter.orderStageFilter && !ticked(event.orderStage ?? null, filter.orderStages ?? null))
      return false;
    return true;
  });
}

/**
 * Whether a switched-on filter keeps an entry: it has to name a subject at all,
 * and that subject has to be ticked. `null` is every subject — not every entry.
 */
function ticked(subject: string | null, selected: ReadonlySet<string> | null): boolean {
  if (subject === null) return false;
  return selected === null || selected.has(subject);
}

export interface DiaryDateGroup {
  date: string | null;
  events: DiaryEvent[];
}

/** The entries under their own day, the days in the order the sort asks for. */
export function groupDiaryByDate(
  events: readonly DiaryEvent[],
  newestFirst: boolean,
): DiaryDateGroup[] {
  const byDate = new Map<string | null, DiaryEvent[]>();
  for (const event of sortDiary(events, newestFirst)) {
    const group = byDate.get(event.date) ?? [];
    group.push(event);
    byDate.set(event.date, group);
  }
  return [...byDate.entries()]
    .sort(([left], [right]) =>
      left === null
        ? 1
        : right === null
          ? -1
          : newestFirst
            ? right.localeCompare(left)
            : left.localeCompare(right),
    )
    .map(([date, group]) => ({ date, events: group }));
}

/** Every day the loaded entries fall on, ascending — what the range control offers. */
export function diaryDates(events: readonly DiaryEvent[]): string[] {
  return [...new Set(events.flatMap((event) => (event.date === null ? [] : [event.date])))].sort();
}

/** How many entries each kind would contribute, before the type filter is read. */
export function diaryKindCounts(
  events: readonly DiaryEvent[],
  filter: Omit<DiaryFilter, 'kinds'>,
): Map<DiaryKind, number> {
  const scoped = filterDiary(events, { ...filter, kinds: null });
  const counts = new Map<DiaryKind, number>(DIARY_KINDS.map((kind) => [kind, 0]));
  for (const event of scoped) counts.set(event.kind, (counts.get(event.kind) ?? 0) + 1);
  return counts;
}

/** The same, per bot — the count beside each option in the bot filter. */
export function diaryBotCounts(events: readonly DiaryEvent[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const event of events) {
    if (event.botId === null) continue;
    counts.set(event.botId, (counts.get(event.botId) ?? 0) + 1);
  }
  return counts;
}
