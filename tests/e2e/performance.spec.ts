import {
  FIXTURE_NOW_MS,
  makePerformanceReadFixture,
  makePriceReadFixture,
} from '../../src/test/fixtures';
import { expect, makeBrowserScenario, test } from './safeHarness';

test('keeps unprovable Performance metrics unavailable instead of rendering zero', async ({
  page,
  safeBridge,
}) => {
  safeBridge.useScenario(
    makeBrowserScenario({
      bist: makePerformanceReadFixture(),
      price: makePriceReadFixture({ closingBars: [] }),
    }),
  );
  await page.clock.setFixedTime(new Date(FIXTURE_NOW_MS));
  await page.goto('/performance');
  await safeBridge.stream.open();

  await expect(page.getByRole('heading', { name: 'Performance' })).toBeVisible();
  await expect(page.getByText(/closed round trips only, gross.*1 trade/i)).toBeVisible();

  const exitTiming = page.locator('.performance-card').filter({ hasText: 'exit timing' });
  await expect(
    exitTiming.getByRole('heading', { name: 'Not derivable from ClosedTrades' }),
  ).toBeVisible();
  await expect(exitTiming).toContainText(/required hold-boundary bars (?:are )?missing/);
  await expect(exitTiming).toContainText('never counted as zero');

  const slippage = page.locator('.slippage-grid');
  await expect(slippage.locator('.unavailable-metric')).toHaveCount(4);
  await expect(slippage.locator('.unavailable-metric strong')).toHaveText([
    'not available',
    'not available',
    'not available',
    'not available',
  ]);
  await expect(slippage).toContainText('cannot be split without inventing which prices were sent');

  const symbolSection = page
    .locator('section.performance-section')
    .filter({ hasText: 'by symbol' });
  const symbolRow = symbolSection.getByRole('row').filter({ hasText: 'THYAO' });
  await expect(symbolRow.getByRole('cell', { name: 'not available' })).toBeVisible();
  await expect(symbolRow.getByRole('cell', { name: '1 boundary bars missing' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Acknowledgement, not fill time' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'No net result' })).toBeVisible();

  expect(
    safeBridge.requests.some(
      (request) => request.method === 'POST' && request.path === '/bridge/price/bars/closing',
    ),
  ).toBe(true);
});
