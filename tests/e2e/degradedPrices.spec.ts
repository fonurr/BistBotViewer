import {
  FIXTURE_NOW_MS,
  makeBookReadFixture,
  makePriceReadFixture,
  makePriceStatus,
} from '../../src/test/fixtures';
import { expect, makeBrowserScenario, test } from './safeHarness';

test('keeps an untrusted P&L inside its own column and out of colour', async ({
  page,
  safeBridge,
}) => {
  safeBridge.useScenario(
    makeBrowserScenario({
      price: makePriceReadFixture({ status: makePriceStatus({ feed: 'stalled' }) }),
    }),
  );
  await page.clock.setFixedTime(new Date(FIXTURE_NOW_MS));
  await page.setViewportSize({ width: 1500, height: 900 });
  await page.goto('/book');
  await safeBridge.stream.open();

  const row = page.locator('.book-row').filter({ hasText: 'THYAO' }).first();
  const pnl = row.locator('.book-pnl');
  await expect(pnl).toContainText('last known');

  // TOKENS rule 2: a figure we cannot defend is muted, never inked by sign.
  const tones = await pnl.evaluate((cell) => {
    const probe = document.createElement('span');
    document.body.append(probe);
    const read = (value: string) => {
      probe.style.color = value;
      return getComputedStyle(probe).color;
    };
    const tone = { muted: read('var(--mut)'), up: read('var(--st-live)') };
    probe.remove();
    return { ...tone, actual: getComputedStyle(cell).color };
  });
  expect(tones.actual).toBe(tones.muted);
  expect(tones.actual).not.toBe(tones.up);

  const overlap = await row.evaluate((element) => {
    const cells = [...element.children] as HTMLElement[];
    const pnlCell = element.querySelector<HTMLElement>('.book-pnl')!;
    const next = cells[cells.indexOf(pnlCell) + 1]!;
    return {
      pnlRight: pnlCell.getBoundingClientRect().right,
      nextLeft: next.getBoundingClientRect().left,
      scrolls: pnlCell.scrollWidth > pnlCell.clientWidth,
    };
  });
  expect(overlap.scrolls).toBe(false);
  expect(overlap.pnlRight).toBeLessThanOrEqual(overlap.nextLeft + 0.5);
});
