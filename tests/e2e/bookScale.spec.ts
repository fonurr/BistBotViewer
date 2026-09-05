import {
  FIXTURE_NOW_MS,
  makeAccount,
  makeBot,
  makeBotBudget,
  makeClosedTrade,
  makeLogReadFixture,
  makePriceReadFixture,
} from '../../src/test/fixtures';
import { expect, test } from './safeHarness';

/**
 * A year of batches is the load the Book has to survive: the reader opens
 * `trades` with every date selected and gets thousands of chains at once.
 * The grid answers that by drawing one batch — the newest, the one being
 * worked — and leaving the rest behind their chevron. This spec performs no
 * writes and touches no upstream.
 */

const DAY_MS = 24 * 60 * 60 * 1_000;
const BATCHES = 120;
const PER_BATCH = 20;
const CHAINS = BATCHES * PER_BATCH;

function scaledTrades() {
  return Array.from({ length: CHAINS }, (_, index) => {
    const batch = Math.floor(index / PER_BATCH);
    // Walk backwards a day at a time from the fixture clock; the calendar rolls
    // whatever lands on a weekend into the next session on its own.
    const openTime = FIXTURE_NOW_MS - batch * DAY_MS - 3 * 60 * 60 * 1_000;
    return makeClosedTrade({
      id: 10_000 + index,
      clientOpenOrderId: `client-open-${index}`,
      matriksOpenOrderId: `mx-open-${index}`,
      clientCloseOrderId: `client-close-${index}`,
      matriksCloseOrderId: `mx-close-${index}`,
      positionId: `position-${index}`,
      symbol: `SYM${String(index % 40).padStart(2, '0')}`,
      chainId: `chain-scale-${index}`,
      openOrderTime: openTime,
      openExecuteTime: openTime + 2_000,
      closeOrderTime: openTime + 60 * 60 * 1_000,
      closeExecuteTime: openTime + 60 * 60 * 1_000 + 3_000,
    });
  });
}

test.describe('The Book at a year of batches', () => {
  test.beforeEach(async ({ page, safeBridge }) => {
    const bot = makeBot();
    safeBridge.useScenario({
      bist: {
        bots: [bot],
        accounts: [makeAccount()],
        activeOrders: [],
        canceledOrders: [],
        positions: [],
        closedTrades: scaledTrades(),
        pendingOrderRequests: [],
        holidays: [],
        errors: [],
        budgets: { [bot.id]: makeBotBudget() },
      },
      price: makePriceReadFixture(),
      logs: makeLogReadFixture(),
    });
    await page.clock.setFixedTime(new Date(FIXTURE_NOW_MS));
    await page.goto('/book');
    await safeBridge.stream.open();
    // The reported stall: every date selected, with `Trades` on — which it now
    // is from the first render, so only the range has to be widened.
    await page.locator('.date-range .filter-trigger').click();
    await page.getByRole('button', { name: 'all', exact: true }).click();
    await page.keyboard.press('Escape');
    await expect(page.locator('.book-grid-wrap')).toBeVisible();
  });

  /** `20 chains` on a batch heading, as a number. */
  async function statedChains(heading: { textContent: () => Promise<string | null> }) {
    const text = (await heading.textContent()) ?? '';
    return Number(text.match(/(\d+) chains?/)![1]);
  }

  test('draws the newest batch alone and counts every one of the rest', async ({ page }) => {
    // Turkish grouping, the UI's own: 2.400 chains, both legs of each counted.
    await expect(page.locator('.book-stat').first()).toContainText('2.400 chains · 4.800 orders');
    // A weekend folds three calendar days into one session, so the batches are
    // fewer than the days that were written; what matters is that they are many.
    expect(await page.locator('.book-date-heading').count()).toBeGreaterThan(50);

    // One batch open, one column band, and only that batch's chains drawn.
    await expect(page.locator('.book-date-heading[aria-expanded="true"]')).toHaveCount(1);
    await expect(page.locator('.book-columns')).toHaveCount(1);
    const open = await statedChains(page.locator('.book-date-heading[aria-expanded="true"]'));
    await expect(page.locator('.book-chain')).toHaveCount(open);
    await expect(page.locator('.book-row')).toHaveCount(open * 2);
    expect(open).toBeLessThan(CHAINS / 10);

    // A shut batch still says what it holds.
    const shut = page.locator('.book-date-heading[aria-expanded="false"]').first();
    expect(await statedChains(shut)).toBeGreaterThan(0);
  });

  test('opens a batch on its chevron and shuts one on its own', async ({ page }) => {
    const open = await statedChains(page.locator('.book-date-heading[aria-expanded="true"]'));
    const shut = page.locator('.book-date-heading[aria-expanded="false"]').first();
    const second = await statedChains(shut);

    await shut.click();
    await expect(page.locator('.book-chain')).toHaveCount(open + second);
    await expect(page.locator('.book-columns')).toHaveCount(2);

    await page.locator('.book-date-heading[aria-expanded="true"]').first().click();
    await expect(page.locator('.book-chain')).toHaveCount(second);
  });

  test('keeps the fixed desktop grid on the batch it draws', async ({ page }) => {
    const templates = await page.evaluate(() => {
      const columnBand = document.querySelector('.book-columns');
      const dataRow = document.querySelector('.book-row');
      if (!columnBand || !dataRow) throw new Error('The Book grid did not render.');
      return {
        band: getComputedStyle(columnBand).gridTemplateColumns,
        row: getComputedStyle(dataRow).gridTemplateColumns,
        cells: dataRow.children.length,
      };
    });

    expect(templates.band).toBe(templates.row);
    expect(templates.cells).toBe(13);
  });
});
