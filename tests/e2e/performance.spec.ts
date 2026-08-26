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

  // Entry and exit are derivable from the stored order prices; the limit/market
  // split is what ClosedTrades cannot supply, and the section says so once.
  const slippage = page.locator('.slippage-grid');
  await expect(slippage.locator('.slippage-metric')).toHaveCount(2);
  await expect(page.locator('.slippage-reason')).toContainText(
    'cannot be sorted across the four without inventing which prices were sent',
  );

  const symbolSection = page
    .locator('section.performance-section')
    .filter({ hasText: 'by symbol' });
  const symbolRow = symbolSection.getByRole('row').filter({ hasText: 'THYAO' });
  await expect(symbolRow.getByRole('cell', { name: 'not available' })).toBeVisible();
  await expect(symbolRow.getByRole('cell', { name: '1 boundary bars missing' })).toBeVisible();
  await expect(page.getByText(/These are acknowledgement dates, not fill times/)).toBeVisible();
  await expect(page.getByText(/There is no net result to give/)).toBeVisible();

  expect(
    safeBridge.requests.some(
      (request) => request.method === 'POST' && request.path === '/bridge/price/bars/closing',
    ),
  ).toBe(true);
});
