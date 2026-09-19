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
  await expect(list).toContainText('forbidden: added THYAO');
  // A zero column is left out of a snapshot; a null one with it.
  await expect(list).toContainText('budget: 500.000,00, held: 124.219,02');
  await expect(list).not.toContainText('scheduled buys');
  await expect(list).toContainText('margin: Kapalı');

  // The field name, the value and the delta are drawn in three different inks.
  await expect(list.locator('.diary-ink-field').first()).toBeVisible();
  await expect(list.locator('.diary-ink-added', { hasText: 'THYAO' })).toBeVisible();

  await oldest.click();
  const cash = list.getByRole('row').filter({ hasText: '1.250,75 TL withdrawn' });
  await expect(cash).toContainText('ACC-1 · BRK-1');
  await expect(cash.locator('.diary-time-ms')).toHaveText('.000');
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
    'AKBNK buy partly filled, 10 of 40 shares; fill time unavailable from User.',
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
