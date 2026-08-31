import { FIXTURE_NOW_MS, makeActiveOrder, makeBookReadFixture } from '../../src/test/fixtures';
import { expect, makeBrowserScenario, test } from './safeHarness';

test.describe('The Book safety smoke', () => {
  test.beforeEach(async ({ page, safeBridge }) => {
    safeBridge.useScenario(makeBrowserScenario());
    await page.clock.setFixedTime(new Date(FIXTURE_NOW_MS));
    await page.goto('/book');
    await safeBridge.stream.open();
    await expect(page.locator('.book-grid-wrap')).toBeVisible();
  });

  test('keeps the first render as a fixed desktop grid and recovers from an empty filter', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 900, height: 700 });
    await expect(page.getByRole('heading', { name: 'The Book' })).toBeVisible();

    const headers = page.getByRole('columnheader');
    await expect(headers).toHaveCount(12);
    await expect(headers).toHaveText([
      '',
      'symbol',
      'qty',
      'side / type',
      'order',
      'fill',
      'slip',
      'p&l',
      'ord time',
      'ack time',
      'status',
      'act',
    ]);

    const layout = await page.locator('.book-grid-wrap').evaluate((wrap) => {
      const columnRow = wrap.querySelector<HTMLElement>('.book-columns');
      const dataRow = wrap.querySelector<HTMLElement>('.book-row');
      if (!columnRow || !dataRow) throw new Error('The Book grid rows did not render.');
      return {
        bodyScrollWidth: document.body.scrollWidth,
        columnDisplay: getComputedStyle(columnRow).display,
        columnTemplate: getComputedStyle(columnRow).gridTemplateColumns,
        dataDisplay: getComputedStyle(dataRow).display,
        dataTemplate: getComputedStyle(dataRow).gridTemplateColumns,
        htmlMinWidth: getComputedStyle(document.documentElement).minWidth,
        rowCellCount: dataRow.children.length,
        viewportWidth: window.innerWidth,
      };
    });
    expect(layout).toMatchObject({
      columnDisplay: 'grid',
      dataDisplay: 'grid',
      htmlMinWidth: '1180px',
      rowCellCount: 12,
      viewportWidth: 900,
    });
    expect(layout.columnTemplate).toBe(layout.dataTemplate);
    expect(layout.bodyScrollWidth).toBeGreaterThan(layout.viewportWidth);

    await page.getByRole('button', { name: '1 bot', exact: true }).click();
    const botFilter = page.getByRole('dialog', { name: '1 bot filter' });
    const botCheckbox = botFilter.getByRole('checkbox', { name: /bot-alpha/i });
    // A real mouse click, not focus plus Space: the scrim that closes the popover is
    // fixed and full-viewport, so any stacking context around the toolbar would put it
    // over the open popover and swallow every option click.
    await expect(
      botCheckbox.evaluate((node) => {
        const box = node.getBoundingClientRect();
        const top = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
        return top?.closest('.filter-popover') === null ? 'covered' : 'clickable';
      }),
    ).resolves.toBe('clickable');
    await botCheckbox.click();
    await expect(
      page.getByRole('dialog', { name: '0 bots filter' }).getByRole('checkbox', {
        name: /bot-alpha/i,
      }),
    ).not.toBeChecked();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog', { name: /bots filter/ })).toHaveCount(0);

    await expect(page.getByText('No chains match this filter.')).toBeVisible();
    await expect(page.locator('.book-empty-filter')).toContainText('bot filter');
    await expect(page.locator('.book-grid-wrap')).toHaveCount(0);
    await page.getByRole('button', { name: 'clear the bot filter' }).click();
    await expect(page.locator('.book-grid-wrap')).toBeVisible();
    await expect(page.getByRole('article', { name: 'AKBNK chain' })).toBeVisible();
  });

  test('shows stream-down state in the header and holds every chain write', async ({
    page,
    safeBridge,
  }) => {
    await safeBridge.stream.down();

    await expect(page.getByText(/stream down.*reconnecting/i)).toBeVisible();
    await expect(
      page.getByRole('alert').filter({ hasText: 'The order stream dropped' }),
    ).toBeVisible();
    await expect(page.getByRole('button', { name: 'Refresh the order snapshot' })).toBeDisabled();

    await page.locator('article[aria-label="AKBNK chain"] .book-symbol').click();
    const dialog = page.getByRole('dialog', { name: /AKBNK.*chain/i });
    await expect(dialog).toBeVisible();
    await expect(
      dialog.getByText(
        'Actions are held until the order stream is live and the snapshot can reconcile them.',
      ),
    ).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'edit', exact: true })).toBeDisabled();
    await expect(dialog.getByRole('button', { name: 'cancel', exact: true })).toBeDisabled();
  });

  test('reads a guarded order out loud in the view a symbol click opens', async ({
    page,
    safeBridge,
  }) => {
    const base = makeBookReadFixture();
    safeBridge.useScenario(
      makeBrowserScenario({
        bist: {
          ...base,
          activeOrders: [
            makeActiveOrder({
              openPrice: '{"upperLimit":9.8,"lowerLimit":-9.8}',
              closePrice: '{"stopLoss":{"limit":-2,"base":"actualPrice"}}',
            }),
          ],
        },
      }),
    );
    await page.goto('/book');
    await safeBridge.stream.open();

    await page.locator('article[aria-label="AKBNK chain"] .book-symbol').click();
    const dialog = page.getByRole('dialog', { name: /AKBNK.*chain/i });

    await expect(
      dialog.getByText('entry · buy between −9,80% and +9,80% of the previous close'),
    ).toBeVisible();
    await expect(dialog.getByText('exit · stop loss at −2,00% of the average fill')).toBeVisible();
    await expect(dialog.getByText(/The server may add narrower ones of its own/)).toBeVisible();
  });

  test('traps modal focus, closes the top layer with Escape, and returns focus', async ({
    page,
  }) => {
    const trigger = page.locator('article[aria-label="AKBNK chain"] .book-symbol');
    await trigger.click();

    const dialog = page.getByRole('dialog', { name: /AKBNK.*chain/i });
    const first = dialog.getByRole('button', { name: 'Close dialog' });
    const last = dialog.getByRole('button', { name: 'Close', exact: true });
    await expect(first).toBeFocused();

    await page.keyboard.press('Shift+Tab');
    await expect(last).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(first).toBeFocused();

    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(trigger).toBeFocused();
  });
});
