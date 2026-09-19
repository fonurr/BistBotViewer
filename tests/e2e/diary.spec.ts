import {
  FIXTURE_NOW_MS,
  makeAccount,
  makeAccountSnapshot,
  makeAccountTransaction,
  makeActiveOrder,
  makeCanceledOrder,
  makeBookReadFixture,
  makeBot,
  makeBotHistoryEntry,
  makeBotSnapshot,
  makeErrorRow,
} from '../../src/test/fixtures';
import { expect, makeBrowserScenario, test } from './safeHarness';

const EARLIER = Date.parse('2026-08-24T06:00:00.000Z');
const LATER = Date.parse('2026-08-25T09:00:00.000Z');

function diaryScenario() {
  return makeBrowserScenario({
    bist: {
      ...makeBookReadFixture(),
      activeOrders: [],
      canceledOrders: [],
      positions: [],
      closedTrades: [],
      bots: [makeBot({ forbiddenStocks: ['THYAO'], limit: 750_000, startTime: LATER })],
      accounts: [makeAccount()],
      botHistory: [
        makeBotHistoryEntry({ forbiddenStocks: [], startTime: EARLIER, endTime: LATER }),
      ],
      botSnapshots: [makeBotSnapshot({ time: LATER })],
      accountSnapshots: [makeAccountSnapshot({ time: LATER, marginTrading: 'Kapalı' })],
      accountTransactions: [makeAccountTransaction({ time: EARLIER, amount: -1_250.75 })],
      errors: [],
    },
  });
}

test('lists what the server wrote down outside the order tables, under each event day', async ({
  page,
  safeBridge,
}) => {
  safeBridge.useScenario(diaryScenario());
  await page.clock.setFixedTime(new Date(FIXTURE_NOW_MS));
  await page.goto('/diary');
  await safeBridge.stream.open();

  await expect(page.getByRole('heading', { name: 'Diary' })).toBeVisible();

  const list = page.getByRole('table', { name: 'Diary entries' });
  const newest = list.getByRole('button', { name: /^25\.08\.26/ });
  const oldest = list.getByRole('button', { name: /^24\.08\.26/ });

  // The first day opens itself; the rest wait behind their chevron.
  await expect(newest).toHaveAttribute('aria-expanded', 'true');
  await expect(oldest).toHaveAttribute('aria-expanded', 'false');

  // Only what the configuration change moved, never the whole record again.
  await expect(list).toContainText('limit: 500.000 → 750.000');
  await expect(list).toContainText('forbidden: +THYAO');
  // A zero column is left out of a snapshot; a null one with it.
  await expect(list).toContainText('budget: 500.000,00, held: 124.219,02');
  await expect(list).not.toContainText('scheduled buys');
  await expect(list).toContainText('margin: Kapalı');

  // The field name, the value and the delta are drawn in three different inks.
  await expect(list.locator('.diary-ink-field').first()).toBeVisible();
  await expect(list.locator('.diary-ink-added', { hasText: '+' })).toBeVisible();

  await oldest.click();
  const cash = list.getByRole('row').filter({ hasText: '1.250,75 TL withdrawn' });
  await expect(cash).toContainText('ACC-1 · BRK-1');
  await expect(cash.locator('.diary-time-ms')).toHaveText('.000');
});

test('gives each key-bearing record type its own color and marks errors red', async ({
  page,
  safeBridge,
}) => {
  const scenario = diaryScenario();
  scenario.bist.errors = [makeErrorRow({ time: LATER + 1_000 })];
  safeBridge.useScenario(scenario);
  await page.clock.setFixedTime(new Date(FIXTURE_NOW_MS));
  await page.goto('/diary');
  await safeBridge.stream.open();

  const list = page.getByRole('table', { name: 'Diary entries' });
  const keyColors = await Promise.all(
    ['botHistory', 'botSnapshots', 'accountSnapshots'].map((kind) =>
      list
        .locator(`.diary-row-${kind} .diary-ink-field`)
        .first()
        .evaluate((element) => getComputedStyle(element).color),
    ),
  );
  expect(new Set(keyColors).size).toBe(3);

  const errorDescription = list.locator('.diary-row-errors .diary-description > *');
  await expect(errorDescription).toHaveText('AccountFeedSilent');
  const [errorColor, deadColor] = await Promise.all([
    errorDescription.evaluate((element) => getComputedStyle(element).color),
    page.evaluate(() => {
      const probe = document.createElement('span');
      probe.style.color = 'var(--st-dead)';
      document.body.append(probe);
      const color = getComputedStyle(probe).color;
      probe.remove();
      return color;
    }),
  ]);
  expect(errorColor).toBe(deadColor);
});

test('reverses the reading order on one button and re-opens the first day', async ({
  page,
  safeBridge,
}) => {
  safeBridge.useScenario(diaryScenario());
  await page.clock.setFixedTime(new Date(FIXTURE_NOW_MS));
  await page.goto('/diary');
  await safeBridge.stream.open();

  const list = page.getByRole('table', { name: 'Diary entries' });
  await expect(list.getByRole('button', { name: /^25\.08\.26/ })).toHaveAttribute(
    'aria-expanded',
    'true',
  );

  await page.getByRole('button', { name: /Sorted newest first/ }).click();

  await expect(page.getByRole('button', { name: /Sorted oldest first/ })).toBeVisible();
  await expect(list.getByRole('button', { name: /^24\.08\.26/ })).toHaveAttribute(
    'aria-expanded',
    'true',
  );
});

test('holds no write path at all', async ({ page, safeBridge }) => {
  safeBridge.useScenario(diaryScenario());
  await page.clock.setFixedTime(new Date(FIXTURE_NOW_MS));
  await page.goto('/diary');
  await safeBridge.stream.open();
  await expect(page.getByRole('table', { name: 'Diary entries' })).toBeVisible();

  // Every entry is a record of something that already happened, so the page
  // offers nothing to act on and sends nothing but its own reads.
  const reads = new Set([
    'GetBots',
    'GetAccounts',
    'GetBotHistory',
    'GetBotSnapshots',
    'GetAccountSnapshots',
    'GetAccountTransactions',
    'GetErrors',
    'GetHolidays',
    'GetActiveOrders',
    'GetCanceledOrders',
    'GetPositions',
    'GetClosedTrades',
  ]);
  for (const request of safeBridge.requests) {
    const rpc = request.path.split('/rpc/')[1];
    if (rpc) expect(reads).toContain(decodeURIComponent(rpc));
  }
});

test('filters order lifecycles and updates a partial fill from the shared order stream', async ({
  page,
  safeBridge,
}) => {
  const scenario = diaryScenario();
  const order = makeActiveOrder({ origin: 'User', status: 'PartiallyFilled', filledQuantity: 10 });
  scenario.bist.activeOrders = [order];
  scenario.bist.canceledOrders = [
    makeCanceledOrder({ status: 'Rejected', reason: 'InsufficientFunds' }),
  ];
  safeBridge.useScenario(scenario);
  await page.clock.setFixedTime(new Date(FIXTURE_NOW_MS));
  await page.goto('/diary');
  await safeBridge.stream.open();

  const list = page.getByRole('table', { name: 'Diary entries' });
  await expect(list).toContainText(
    'AKBNK buy partly filled, 10 of 40 shares, average fill price 0,00; fill time unavailable from User.',
  );
  await expect(list).toContainText('THYAO sell rejected: InsufficientFunds.');
  await page.getByRole('button', { name: 'any order stage' }).click();
  await expect(page.getByRole('checkbox', { name: 'filled', exact: true })).not.toBeChecked();
  await expect(page.getByRole('checkbox', { name: 'filled', exact: true })).toBeDisabled();
  await page.getByRole('checkbox', { name: 'filter', exact: true }).check();
  await page.getByRole('checkbox', { name: 'filled', exact: true }).check();
  await page.keyboard.press('Escape');
  await expect(list).not.toContainText('rejected');

  await safeBridge.stream.emit('write', {
    table: 'ActiveOrders',
    action: 'update',
    botId: order.botId,
    row: { ...order, filledQuantity: 20 },
  });
  await expect(list).toContainText('20 of 40 shares');
  await expect(list.getByRole('row').filter({ hasText: 'partly filled' })).toHaveCount(1);

  await page.getByRole('button', { name: 'any origin' }).click();
  await page.getByRole('checkbox', { name: 'filter', exact: true }).check();
  await page.getByRole('checkbox', { name: 'User', exact: true }).check();
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'any symbol' }).click();
  await page.getByRole('button', { name: 'AKBNK', exact: true }).click();
  await page.keyboard.press('Escape');
  await expect(list.getByRole('row').filter({ hasText: 'partly filled' })).toHaveCount(1);
});

test('shows schedule details, suppresses skipped plans and separates time groups and sessions', async ({
  page,
  safeBridge,
}, testInfo) => {
  const scenario = diaryScenario();
  const created = Date.parse('2026-08-25T21:00:00+03:00');
  const scheduledTime = Date.parse('2026-08-26T09:55:30+03:00');
  const buy = makeActiveOrder({
    status: 'Scheduled',
    createdTime: created,
    scheduledTime,
    sentTime: null,
    orderTime: null,
  });
  scenario.bist.activeOrders = [buy, { ...buy, id: 102, clientOrderId: 'sale', direction: 'sell' }];
  scenario.bist.canceledOrders = [
    makeCanceledOrder({
      symbol: 'MARTI',
      status: 'Skipped',
      reason: 'ForbiddenStock',
      createdTime: created,
      scheduledTime,
      sentTime: null,
      finalSeenTime: created,
    }),
  ];
  safeBridge.useScenario(scenario);
  await page.goto('/diary');
  await safeBridge.stream.open();
  const list = page.getByRole('table', { name: 'Diary entries' });
  await expect(list).toContainText('AKBNK buy / sell scheduled for 09:55:30+1, order price 68,25.');
  await expect(list.getByRole('row').filter({ hasText: 'AKBNK' })).toHaveCount(1);
  await expect(list.getByRole('row').filter({ hasText: 'MARTI' })).toHaveCount(1);
  await expect(list).toContainText('MARTI sell skipped: ForbiddenStock.');
  await expect(list.getByRole('separator', { name: 'Session start 09:55' })).toBeVisible();
  await expect(list.getByRole('separator', { name: 'Session end 18:10' })).toBeVisible();
  const scheduled = list.locator('.diary-event-cluster').filter({ hasText: 'scheduled for' });
  await expect(scheduled).toHaveCount(1);
  await expect(scheduled.locator('.diary-row')).toHaveCount(2);
  await expect(scheduled.locator('sup.diary-day-offset')).toHaveText(['+1']);
  await expect(scheduled).toHaveCSS('border-top-width', '1px');
  await expect(scheduled).toHaveCSS('border-bottom-width', '0px');
  await expect(list.locator('.diary-event-cluster-after-session')).toHaveCSS(
    'border-top-width',
    '0px',
  );
  await expect(list.locator('.diary-session-boundary hr').first()).toHaveCSS(
    'border-top-width',
    '3px',
  );
  const buyColor = await list
    .locator('.diary-ink-buy')
    .first()
    .evaluate((element) => getComputedStyle(element).color);
  const sellColor = await list
    .locator('.diary-ink-sell')
    .first()
    .evaluate((element) => getComputedStyle(element).color);
  expect(buyColor).not.toBe(sellColor);
  await page.screenshot({ path: testInfo.outputPath('diary-timeline.png'), fullPage: true });
});
