import {
  FIXTURE_NOW_MS,
  makeActiveOrder,
  makeBookReadFixture,
  makeCanceledOrder,
  makePosition,
} from '../../src/test/fixtures';
import { expect, makeBrowserScenario, test } from './safeHarness';

test.beforeEach(async ({ page, safeBridge }) => {
  const base = makeBookReadFixture();
  safeBridge.useScenario(
    makeBrowserScenario({
      bist: {
        ...base,
        activeOrders: [
          makeActiveOrder({
            id: 102,
            clientOrderId: 'client-thyao-sell-1',
            matriksOrderId: 'mx-thyao-sell-1',
            symbol: 'THYAO',
            direction: 'sell',
            orderQuantity: 40,
            chainId: 'chain-thyao',
            parentClientOrderId: 'client-thyao-open-000001',
          }),
        ],
        canceledOrders: [makeCanceledOrder()],
        positions: [makePosition()],
      },
    }),
  );
  await page.clock.setFixedTime(new Date(FIXTURE_NOW_MS));
  await page.setViewportSize({ width: 1500, height: 900 });
  await page.goto('/book');
  await safeBridge.stream.open();
  await expect(page.locator('.book-grid-wrap')).toBeVisible();
});

test('hides canceled legs behind a toggle that is itself the count', async ({ page }) => {
  const toggle = page.locator('.canceled-global');
  await expect(toggle).toHaveText('1 canceled order hidden');
  // The count is the control: it carries no instruction to click it.
  await expect(toggle).not.toContainText('show');

  const tail = page.locator('.canceled-tail');
  await expect(tail.locator('.book-row')).toHaveCount(0);

  await toggle.click();
  await expect(toggle).toHaveText('1 canceled order shown');
  await expect(tail.locator('.book-row')).toHaveCount(1);
  await expect(tail.locator('.book-status')).toHaveText('By user');

  // Reconciles the per-chain override against the global toggle.
  await tail.getByRole('button', { name: /^hide/ }).click();
  await expect(toggle).toHaveText('1 canceled order shown · 1 chain closed by hand');
  await expect(tail.locator('.book-row')).toHaveCount(0);
});

test('withholds resend, and says why, when the position cannot cover the canceled sell', async ({
  page,
  safeBridge,
}) => {
  await page.locator('.canceled-global').click();
  const tail = page.locator('.canceled-tail');

  // 100 held, 40 claimed by the resting sell, so the stored 120 can never go out.
  await expect(tail).toContainText(
    'none offers resend: each asks for at least 120 and only 60 shares are unclaimed',
  );
  await expect(tail.locator('.book-actions button')).toHaveCount(0);

  expect(
    safeBridge.requests.some((request) =>
      /\/rpc\/(SendOrders|CancelOrders|EditOrders)$/.test(request.path),
    ),
  ).toBe(false);
});
