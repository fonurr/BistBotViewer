import {
  FIXTURE_NOW_MS,
  makeLatestBar,
  makePriceReadFixture,
  makePriceStatus,
} from '../../src/test/fixtures';
import { expect, makeBrowserScenario, test } from './safeHarness';

/**
 * The fixture clock sits at 12:00 Istanbul on a Tuesday, inside the continuous session, so a feed
 * that is not live is a fault the header has to state. Prices themselves keep coming from the
 * stored bar, and no row changes because of it.
 */
const barPriced = () =>
  makeBrowserScenario({
    price: makePriceReadFixture({
      quotes: [],
      latestBars: [makeLatestBar({ symbol: 'THYAO', close: 305.5 })],
    }),
  });

test('states the global price age in amber while the producer says its feed is stalled', async ({
  page,
  safeBridge,
}) => {
  safeBridge.useScenario(barPriced());
  await page.clock.setFixedTime(new Date(FIXTURE_NOW_MS));
  await page.goto('/book');
  await safeBridge.stream.open();

  await safeBridge.stream.emit(
    'status',
    makePriceStatus({ feed: 'stalled', feed_age_ms: 240_000 }),
    'prices',
  );

  const priceLine = page.locator('.freshness', { hasText: 'prices' });
  await expect(priceLine).toHaveText('prices 4 minutes old');
  await expect(priceLine).toHaveClass(/status-warn/);
  // The snapshot's own line is still there and still separate.
  await expect(page.locator('.freshness', { hasText: 'updated' })).toBeVisible();

  // The row is priced from the stored close and says nothing about it.
  const row = page.locator('.book-row').filter({ hasText: 'THYAO' }).first();
  await expect(row.locator('.book-pnl')).toContainText('+400');
});

test('turns the price light red when the stream itself is gone', async ({ page, safeBridge }) => {
  safeBridge.useScenario(barPriced());
  await page.clock.setFixedTime(new Date(FIXTURE_NOW_MS));
  await page.goto('/book');
  await safeBridge.stream.open();

  await safeBridge.stream.emit(
    'status',
    makePriceStatus({ feed: 'stalled', feed_age_ms: 3_600_000 }),
    'prices',
  );
  await safeBridge.stream.down('prices');

  const priceLine = page.locator('.freshness', { hasText: 'prices' });
  await expect(priceLine).toHaveText('prices 1 hour old');
  await expect(priceLine).toHaveClass(/status-dead/);
});

test('says nothing about prices while every quote on screen is live', async ({
  page,
  safeBridge,
}) => {
  safeBridge.useScenario(makeBrowserScenario());
  await page.clock.setFixedTime(new Date(FIXTURE_NOW_MS));
  await page.goto('/book');
  await safeBridge.stream.open();

  await safeBridge.stream.emit(
    'quote',
    {
      symbol: 'THYAO',
      son: 305.5,
      ghacim_try: null,
      quote_age_ms: 10,
      price_change_age_ms: 10,
      trade_age_ms: 10,
      feed: 'live',
      server_ts: FIXTURE_NOW_MS / 1_000,
    },
    'prices',
  );

  const row = page.locator('.book-row').filter({ hasText: 'THYAO' }).first();
  await expect(row.locator('.book-pnl')).toContainText('+400');
  await expect(page.locator('.freshness', { hasText: 'prices' })).toHaveCount(0);
});
