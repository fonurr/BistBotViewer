import type { Locator } from '@playwright/test';

import {
  FIXTURE_NOW_MS,
  makeBookReadFixture,
  makeBot,
  makeBotBudget,
  makeClosedTrade,
} from '../../src/test/fixtures';
import { expect, makeBrowserScenario, test } from './safeHarness';

test('keeps the current batch, columns and bot visible while scrolling', async ({
  page,
  safeBridge,
}, testInfo) => {
  const bots = [makeBot(), makeBot({ id: 'bot-beta' })];
  const closedTrades = [0, 1].flatMap((batch) =>
    bots.flatMap((bot, botIndex) =>
      Array.from({ length: 16 }, (_, index) => {
        const id = batch * 100 + botIndex * 20 + index;
        const openTime = FIXTURE_NOW_MS - batch * 86_400_000 - 3_600_000;
        return makeClosedTrade({
          id,
          botId: bot.id,
          chainId: `sticky-chain-${id}`,
          positionId: `sticky-position-${id}`,
          clientOpenOrderId: `sticky-open-${id}`,
          clientCloseOrderId: `sticky-close-${id}`,
          openCreatedTime: openTime - 2_000,
          openSentTime: openTime - 1_000,
          openOrderTime: openTime,
          openFinalSeenTime: openTime + 2_000,
          closeCreatedTime: openTime + 600_000,
          closeSentTime: openTime + 601_000,
          closeOrderTime: openTime + 602_000,
          closeFinalSeenTime: openTime + 603_000,
        });
      }),
    ),
  );
  safeBridge.useScenario(
    makeBrowserScenario({
      bist: {
        ...makeBookReadFixture(),
        bots,
        activeOrders: [],
        positions: [],
        closedTrades,
        budgets: Object.fromEntries(bots.map((bot) => [bot.id, makeBotBudget()])),
      },
    }),
  );
  await page.setViewportSize({ width: 1800, height: 800 });
  await page.clock.setFixedTime(new Date(FIXTURE_NOW_MS));
  await page.goto('/book');
  await safeBridge.stream.open();
  await expect(page.locator('.book-date-group')).toHaveCount(2);
  await page.locator('.book-date-heading[aria-expanded="false"]').click();

  const batches = page.locator('.book-date-group');
  const firstBot = batches.first().locator('.book-bot-group').first();
  const nextBot = batches.first().locator('.book-bot-group').nth(1);
  const olderBot = batches.nth(1).locator('.book-bot-group').first();

  async function scrollIntoGroup(group: Locator) {
    await group.evaluate((element) => {
      window.scrollTo(window.scrollX, window.scrollY + element.getBoundingClientRect().top + 300);
    });
    await expectStack(group);
  }

  async function expectStack(group: Locator) {
    await expect
      .poll(() =>
        group.evaluate((element) => {
          const batch = element.closest('.book-date-group')!;
          const nav = document.querySelector('.viewer-nav')!.getBoundingClientRect();
          const date = batch.querySelector('.book-date-heading')!.getBoundingClientRect();
          const columns = batch.querySelector('.book-columns')!.getBoundingClientRect();
          const bot = element.querySelector('.book-bot-heading')!.getBoundingClientRect();
          return [date.top - nav.bottom, columns.top - date.bottom, bot.top - columns.bottom].map(
            (gap) => Math.round(gap),
          );
        }),
      )
      .toEqual([0, 0, 0]);
  }

  await scrollIntoGroup(firstBot);
  await page.screenshot({ path: testInfo.outputPath('book-sticky.png') });
  await scrollIntoGroup(nextBot);
  await scrollIntoGroup(olderBot);

  // The same columns must follow horizontal page scrolling on a narrow desktop.
  await page.setViewportSize({ width: 900, height: 700 });
  await scrollIntoGroup(olderBot);
  await page.evaluate(() => window.scrollTo(350, window.scrollY));
  await expectStack(olderBot);
  const alignment = await olderBot.evaluate((element) => {
    const batch = element.closest('.book-date-group')!;
    const column = batch.querySelector('[role="columnheader"]:nth-child(5)')!;
    const cell = element.querySelector('.book-row > :nth-child(5)')!;
    return {
      scrollX: window.scrollX,
      gap: Math.round(column.getBoundingClientRect().left - cell.getBoundingClientRect().left),
    };
  });
  expect(alignment.scrollX).toBeGreaterThan(0);
  expect(alignment.gap).toBe(0);

  // Height changes must update both offsets without another scroll event.
  await page.addStyleTag({
    content: '.viewer-nav, .book-date-heading { padding-block: var(--space-8); }',
  });
  await expectStack(olderBot);

  await page.evaluate(() => window.scrollTo(0, window.scrollY));
  await batches.nth(1).locator('.book-date-heading').click();
  await expect(batches.nth(1).locator('.book-columns')).toHaveCount(0);
  await expect(batches.nth(1).locator('.book-bot-heading')).toHaveCount(0);
  await scrollIntoGroup(firstBot);
});
