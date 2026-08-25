import { FIXTURE_NOW_MS, makeBookReadFixture, makeErrorRow } from '../../src/test/fixtures';
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

    const accountTrigger = page.getByRole('button', { name: /^All accounts/ });
    await accountTrigger.click();
    await expect(page.getByRole('dialog', { name: 'Filter bots by account' })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog', { name: 'Filter bots by account' })).toHaveCount(0);
    await expect(accountTrigger).toBeFocused();

    await card.getByRole('link', { name: 'Performance' }).click();
    await expect(page).toHaveURL(/\/performance\?bot=bot-alpha$/);
    await expect(page.getByRole('heading', { name: 'Performance' })).toBeVisible();
    await expect(page.getByText('bot-alpha').last()).toBeVisible();
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
