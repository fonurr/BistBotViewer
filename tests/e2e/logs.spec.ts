import {
  FIXTURE_LOG_DAY_START_MS,
  FIXTURE_NOW_MS,
  makeLogReadFixture,
} from '../../src/test/fixtures';
import type { WireLogQueryResult } from '../../src/bistApi/logTypes';
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

test('mouse wheel over the log grid scrolls the drawer body', async ({ page, safeBridge }) => {
  const base = makeLogReadFixture();
  const wireRows = Array.from({ length: 120 }, (_, index) => {
    const id = 120 - index;
    return {
      id,
      at: FIXTURE_LOG_DAY_START_MS + id * 1_000,
      atText: `2026-08-25 00:${String(id).padStart(2, '0')}:00.000`,
      target: 'matriks' as const,
      direction: 'in' as const,
      type: 'routine' as const,
      operation: `GetBots ${id}`,
      apiCommand: 1,
      ref: null,
      latencyMs: 4,
      accountId: null,
      brokerageId: null,
      symbol: null,
      clientOrderId: null,
      orderId: null,
      ordStatus: null,
      note: 'fixture reply',
      body: '[]',
      truncated: 0 as const,
    };
  });
  const wire: WireLogQueryResult = {
    source: 'wire',
    rows: wireRows,
    countsByType: { routine: wireRows.length, action: 0, unexpected: 0, error: 0 },
    total: wireRows.length,
    extent: {
      minMs: wireRows[wireRows.length - 1]!.at,
      maxMs: wireRows[0]!.at,
    },
  };
  safeBridge.useScenario(
    makeBrowserScenario({
      logs: {
        extents: { ...base.extents, wire: wire.extent },
        results: { ...base.results, wire },
      },
    }),
  );
  await page.clock.setFixedTime(new Date(FIXTURE_NOW_MS));
  await page.goto('/bots');
  await safeBridge.stream.open();

  const drawer = page.getByRole('dialog', { name: 'Logs', exact: true });
  await page.getByRole('button', { name: 'Logs' }).click();
  await expect(drawer).toBeVisible();
  await drawer.getByRole('tab', { name: 'Wire log' }).click();
  await expect(drawer.getByText('GetBots 120')).toBeVisible();

  const grid = page.locator('.logs-table-scroll');
  await expect(grid).toHaveJSProperty('scrollTop', 0);

  // Wheel while the pointer is over the rows, not the toolbar above them.
  const box = await grid.boundingBox();
  await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height - 20);
  await page.mouse.wheel(0, 600);
  await expect.poll(() => grid.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);

  // The header stays pinned while the rows scroll under it.
  const offset = await page.evaluate(() => {
    const th = document.querySelector('.logs-table thead th') as HTMLElement;
    const scroller = document.querySelector('.logs-table-scroll') as HTMLElement;
    return th.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
  });
  expect(Math.abs(offset)).toBeLessThan(2);
});
