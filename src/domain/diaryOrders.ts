import { buildBookChains, type BookChainRow, type BookChainSources } from './chains';
import type { DiaryEvent, DiaryFragment } from './diary';
import { accountIdentityKey } from './accounts';
import { formatNumber, formatRowTimeParts, toIstanbulDateKey } from './format';
import { displayStatus } from './status';

export const DIARY_ORDER_STAGES = ['scheduled', 'sent', 'canceled', 'filled'] as const;
export type DiaryOrderStage = (typeof DIARY_ORDER_STAGES)[number];

const part = (ink: DiaryFragment['ink'], text: string): DiaryFragment => ({ ink, text });

/** Project the Book's stored orders, not stream arrivals, into a repeatable history. */
export function diaryOrderEvents(
  sources: BookChainSources,
  accountAt: (botId: string, time: number | null) => string | null,
): DiaryEvent[] {
  const orders = new Map<string, Map<string, BookChainRow>>();
  for (const chain of buildBookChains(sources)) {
    for (const row of chain.rows) {
      // A chain may contain many attempts. Only an order id may join carriers;
      // neither chainId nor the broker's symbol-level positionId can do that.
      const identity = row.clientOrderId?.trim() ? `client:${row.clientOrderId}` : row.key;
      const key = JSON.stringify([row.botId, row.direction, identity]);
      const rows = orders.get(key) ?? new Map<string, BookChainRow>();
      rows.set(row.key, row);
      orders.set(key, rows);
    }
  }

  const events: DiaryEvent[] = [];
  for (const [key, carriers] of orders) {
    const rows = [...carriers.values()];
    const dead = rows.find((row) => row.source === 'canceled');
    const active = rows.find((row) => row.source === 'active' || row.source === 'scheduled');
    const position = rows.find((row) => row.source === 'position');
    const row = dead ?? active ?? position ?? rows[0]!;
    const stamp = (field: 'createdTime' | 'sentTime' | 'finalSeenTime') =>
      rows.find((entry) => entry[field] !== null)?.[field] ?? null;
    const origin = rows.find((entry) => entry.origin !== null)?.origin ?? null;
    const originalQuantity =
      dead?.quantity ??
      active?.quantity ??
      (position?.source === 'position' ? position.raw.orderQuantity : null);
    // A position is the remaining holding; closed slices carry the rest of the
    // same opening buy. A working sell has not moved its fills into trades yet.
    const carriedFills = rows.reduce(
      (total, entry) =>
        total +
        (entry.source === 'position' || entry.source === 'closed-trade'
          ? (entry.filledQuantity ?? 0)
          : 0),
      0,
    );
    // A zero canceledQuantity can mean fire-time sizing, not a full execution.
    // Only the actual fill carriers may contribute executed shares.
    const filled = Math.max(carriedFills, active?.filledQuantity ?? 0);
    const fillTime =
      rows.find(
        (entry) =>
          (entry.source === 'position' || entry.source === 'closed-trade') &&
          entry.finalSeenTime !== null,
      )?.finalSeenTime ??
      dead?.finalSeenTime ??
      null;
    const partial =
      filled > 0 &&
      ((originalQuantity !== null && filled < originalQuantity) ||
        (!dead && !!active && active.status !== 'Filled'));
    const fillCarriers = rows.filter(
      (entry) => entry.source === 'position' || entry.source === 'closed-trade',
    );
    const averagePrice =
      carriedFills > 0 && carriedFills >= (active?.filledQuantity ?? 0)
        ? fillCarriers.every((entry) => entry.averagePrice !== null)
          ? fillCarriers.reduce(
              (total, entry) => total + entry.averagePrice! * (entry.filledQuantity ?? 0),
              0,
            ) / carriedFills
          : null
        : (active?.averagePrice ?? null);

    const add = (stage: DiaryOrderStage, time: number | null, words: DiaryFragment[]) => {
      // An untimed confirmed fill still matters, but belongs to no invented day.
      if (time === null && stage !== 'filled') return;
      const trade = rows.find((entry) => entry.source === 'closed-trade');
      events.push({
        id: `order:${key}:${stage}`,
        kind: 'orders',
        time,
        date: time === null ? null : toIstanbulDateKey(time),
        botId: row.botId,
        accountKey:
          trade?.source === 'closed-trade'
            ? accountIdentityKey(trade.raw.accountId, trade.raw.brokerageId)
            : accountAt(row.botId, time ?? stamp('createdTime') ?? stamp('sentTime')),
        subject: row.botId,
        symbol: row.symbol,
        origin,
        orderStage: stage,
        description: [
          part('field', row.symbol),
          part('text', ' '),
          part(row.direction, row.direction),
          part('text', ' '),
          ...words,
          ...(origin && stage !== 'canceled'
            ? [part('text', ' from '), part('value', origin)]
            : []),
          part('text', '.'),
        ],
      });
    };
    const scheduled = rows.find((entry) => entry.scheduledTime !== null);
    // Skipped rows retain the requested schedule, but were never admitted to it.
    const created = stamp('createdTime');
    if (
      scheduled &&
      created !== null &&
      dead?.status !== 'Skipped' &&
      dead?.status !== 'SkippedForNow'
    ) {
      const due = scheduled.scheduledTime!;
      const dueTime = formatRowTimeParts(due, toIstanbulDateKey(created))!;
      add('scheduled', created, [
        part('wait', 'scheduled'),
        part('text', ' for '),
        part('value', `${dueTime.minute}${dueTime.seconds}`),
        ...(dueTime.dayOffset === null
          ? []
          : [{ ...part('value', dueTime.dayOffset), superscript: true }]),
        ...priceWords('order price', scheduled.orderPrice),
      ]);
    }
    const marketPrice = rows.find((entry) => entry.marketPrice !== null)?.marketPrice ?? null;
    add('sent', stamp('sentTime'), [
      part('field', 'sent'),
      ...priceWords('market price', marketPrice),
    ]);
    if (dead) {
      const status = displayStatus(dead.status);
      const words = status.startsWith('By ')
        ? `canceled ${status.toLowerCase()}`
        : status === 'Canceled' && dead.statusSource
          ? dead.statusSource === 'External'
            ? 'canceled externally'
            : `canceled by ${dead.statusSource.toLowerCase()}`
          : status.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase();
      add('canceled', dead.finalSeenTime, [
        part(status === 'Unconfirmed' ? 'wait' : 'removed', words),
        ...(filled > 0 && dead.canceledQuantity !== null
          ? [
              part('text', ', '),
              part('value', formatNumber(dead.canceledQuantity, 0)),
              part('text', ' remaining'),
            ]
          : []),
        ...(dead.reason ? [part('text', ': '), part('value', dead.reason)] : []),
      ]);
    }
    if (filled > 0) {
      add('filled', fillTime, [
        part(partial ? 'wait' : 'added', partial ? 'partly filled' : 'filled'),
        part('text', ', '),
        part('value', formatNumber(filled, 0)),
        ...(partial && originalQuantity !== null
          ? [part('text', ' of '), part('value', formatNumber(originalQuantity, 0))]
          : []),
        part('text', ' shares'),
        ...priceWords('average fill price', averagePrice),
        ...(fillTime === null ? [part('text', '; fill time unavailable')] : []),
      ]);
    }
  }
  return events;
}

function priceWords(label: string, price: number | null): DiaryFragment[] {
  return price === null ? [] : [part('text', `, ${label} `), part('value', formatNumber(price))];
}
