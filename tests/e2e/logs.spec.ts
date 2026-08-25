import { FIXTURE_NOW_MS } from '../../src/test/fixtures';
import { expect, makeBrowserScenario, test } from './safeHarness';

test('closes the Logs range layer before the drawer and returns focus to its trigger', async ({
  page,
  safeBridge,
}) => {
  safeBridge.useScenario(makeBrowserScenario());
  await page.clock.setFixedTime(new Date(FIXTURE_NOW_MS));
  await page.goto('/bots');
  await safeBridge.stream.open();

  const trigger = page.getByRole('button', { name: 'Logs' });
  await trigger.click();

  const drawer = page.getByRole('dialog', { name: 'Logs', exact: true });
  const close = drawer.getByRole('button', { name: 'Close', exact: true });
  await expect(drawer).toBeVisible();
  await expect(drawer).toContainText('read-only');
  await expect(close).toBeFocused();

  const rangeTrigger = drawer.getByRole('button', { name: /^Today/ });
  await expect(rangeTrigger).toBeEnabled();
  await rangeTrigger.click();
  const range = page.getByRole('dialog', { name: 'Days in error log' });
  await expect(range).toBeVisible();

  await page.keyboard.press('Escape');
  await expect(range).toHaveCount(0);
  await expect(drawer).toBeVisible();
  await expect(rangeTrigger).toBeFocused();

  await page.keyboard.press('Escape');
  await expect(drawer).toHaveCount(0);
  await expect(trigger).toBeFocused();
});
