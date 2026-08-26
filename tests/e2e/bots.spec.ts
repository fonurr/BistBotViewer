import {
  FIXTURE_NOW_MS,
  makeActiveOrder,
  makeBookReadFixture,
  makeBot,
  makeBotBudget,
  makeErrorRow,
} from '../../src/test/fixtures';
import { expect, makeBrowserScenario, test } from './safeHarness';

test.describe('Bots fleet smoke', () => {
  test.beforeEach(async ({ page, safeBridge }) => {
    safeBridge.useScenario(makeBrowserScenario());
    await page.clock.setFixedTime(new Date(FIXTURE_NOW_MS));
    await page.goto('/bots');
    await safeBridge.stream.open();
    await expect(page.getByRole('heading', { name: 'Bots' })).toBeVisible();
  });

  test('renders the fleet, restores account-filter focus, and scopes Performance', async ({
    page,
  }) => {
    const card = page.locator('article.bots-card').filter({ hasText: 'bot-alpha' });
    await expect(card).toBeVisible();
    await expect(card).toContainText('ACC-1 · BRK-1');
    await expect(card.getByLabel('1 position, 0 open sells, 0 scheduled sells')).toBeVisible();
    await expect(page.getByText(/prices live · orders updated/i)).toBeVisible();

    // The toolbar uses the Book's shared filter popover, so it is named for its
    // trigger and closes on Escape with focus back where it started.
    const accountTrigger = page.getByRole('button', { name: /^All accounts/ });
    const accountPopover = page.getByRole('dialog', { name: 'All accounts filter' });
    await accountTrigger.click();
    await expect(accountPopover).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(accountPopover).toHaveCount(0);
    await expect(accountTrigger).toBeFocused();

    await card.getByRole('link', { name: 'Performance' }).click();
    await expect(page).toHaveURL(/\/performance\?bot=bot-alpha$/);
    await expect(page.getByRole('heading', { name: 'Performance' })).toBeVisible();
    await expect(page.getByText('bot-alpha').last()).toBeVisible();
  });

  test('opens the Book already narrowed to the card it came from', async ({ page, safeBridge }) => {
    const base = makeBookReadFixture();
    const beta = makeBot({ id: 'bot-beta' });
    safeBridge.useScenario(
      makeBrowserScenario({
        bist: {
          ...base,
          bots: [...base.bots, beta],
          activeOrders: [
            ...base.activeOrders,
            makeActiveOrder({
              id: 202,
              botId: beta.id,
              clientOrderId: 'client-garan-000002',
              matriksOrderId: 'mx-garan-000002',
              chainId: 'client-garan-000002',
              symbol: 'GARAN',
            }),
          ],
          budgets: { ...base.budgets, [beta.id]: makeBotBudget() },
        },
      }),
    );
    await page.goto('/bots');
    await safeBridge.stream.open();

    await page
      .locator('article.bots-card')
      .filter({ hasText: 'bot-beta' })
      .getByRole('link', { name: 'Open book' })
      .click();

    await expect(page).toHaveURL(/\/book\?bot=bot-beta$/);
    await expect(page.getByRole('button', { name: '1 bot', exact: true })).toBeVisible();
    await expect(page.getByRole('article', { name: 'GARAN chain' })).toBeVisible();
    await expect(page.getByRole('article', { name: 'AKBNK chain' })).toHaveCount(0);

    // Clearing the chip hands the filter back to the user and drops the link.
    await page
      .locator('.filter-chips')
      .getByRole('button', { name: /^1 bot/ })
      .click();
    await expect(page).toHaveURL(/\/book$/);
    await expect(page.getByRole('article', { name: 'AKBNK chain' })).toBeVisible();
  });

  test('interrupts with a silent account feed away from the Book', async ({ page, safeBridge }) => {
    safeBridge.useScenario(
      makeBrowserScenario({ bist: { ...makeBookReadFixture(), errors: [makeErrorRow()] } }),
    );
    await page.goto('/bots');
    await safeBridge.stream.open();

    const interrupt = page.locator('.feed-interrupt');
    await expect(interrupt).toBeVisible();
    await expect(interrupt).toContainText('AccountFeedSilent');
    await expect(interrupt).toContainText('fills or cancels are happening unseen');
  });

  test('shows a recoverable empty filter without issuing a write', async ({ page, safeBridge }) => {
    await page.getByLabel('Search by bot or algorithm').fill('does-not-exist');
    await expect(page.getByText('No bots match these filters.')).toBeVisible();
    await page.getByRole('button', { name: 'Clear filters' }).click();
    await expect(page.locator('article.bots-card').filter({ hasText: 'bot-alpha' })).toBeVisible();
    expect(
      safeBridge.requests.some((request) =>
        ['ConfigureBot', 'SendOrders', 'EditOrders', 'CancelOrders'].some((name) =>
          request.path.endsWith(`/rpc/${name}`),
        ),
      ),
    ).toBe(false);
  });
});
