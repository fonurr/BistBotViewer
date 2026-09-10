import type { Locator } from '@playwright/test';

import { BOOK_TIME_STEPS, formatBookTime } from '../../src/domain/bookTimeFilter';
import { FIXTURE_NOW_MS, makeActiveOrder, makeBookReadFixture } from '../../src/test/fixtures';
import { expect, makeBrowserScenario, test } from './safeHarness';

const timeFields = ['created', 'sched', 'intent', 'sent', 'order', 'final'] as const;
const stamp = (clock: string) => Date.parse(`2026-08-25T${clock}+03:00`);

test.beforeEach(async ({ page, safeBridge }) => {
  const base = makeBookReadFixture();
  const order = (symbol: string, createdTime: number, id: number) =>
    makeActiveOrder({
      id,
      symbol,
      chainId: `time-${symbol}`,
      clientOrderId: `time-${symbol}-buy`,
      matriksOrderId: `time-${symbol}-exchange`,
      createdTime,
      sentTime: stamp('11:00:00.000'),
      orderTime: stamp('11:00:01.000'),
    });
  safeBridge.useScenario(
    makeBrowserScenario({
      bist: {
        ...base,
        activeOrders: [
          order('AKBNK', stamp('09:30:00.000'), 101),
          makeActiveOrder({
            ...order('AKBNK', stamp('10:02:59.999'), 102),
            scheduledTime: stamp('01:25:59.999'),
            clientOrderId: 'time-AKBNK-sell',
            matriksOrderId: 'time-AKBNK-sell-exchange',
            parentClientOrderId: 'time-AKBNK-buy',
            direction: 'sell',
          }),
          makeActiveOrder({
            ...order('THYAO', stamp('10:00:00.000'), 103),
            scheduledTime: stamp('00:15:00.000'),
          }),
          makeActiveOrder({
            ...order('GARAN', stamp('10:03:00.000'), 104),
            scheduledTime: stamp('01:26:00.000'),
            sentTime: stamp('10:01:00.000'),
          }),
          makeActiveOrder({
            ...order('ISCTR', stamp('09:59:59.999'), 105),
            scheduledTime: stamp('00:14:59.999'),
          }),
        ],
        canceledOrders: [],
        positions: [],
        closedTrades: [],
        pendingOrderRequests: [],
      },
    }),
  );
  await page.clock.setFixedTime(new Date(FIXTURE_NOW_MS));
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.goto('/book');
  await safeBridge.stream.open();
  await expect(page.getByRole('article')).toHaveCount(4);
});

test('keeps whole chains through the final millisecond of a picked minute and combines clocks with OR', async ({
  page,
  safeBridge,
}) => {
  const control = page.locator('.book-time-filter');
  await control.getByRole('button', { name: 'any time', exact: true }).click();
  const popover = control.getByRole('dialog');
  const enabled = popover.getByRole('checkbox', { name: 'filter', exact: true });
  const start = popover.getByRole('slider', { name: 'Start time', exact: true });
  const end = popover.getByRole('slider', { name: 'End time', exact: true });

  await expect(enabled).not.toBeChecked();
  for (const field of timeFields) {
    const checkbox = popover.getByRole('checkbox', { name: field, exact: true });
    await expect(checkbox).toBeChecked();
    await expect(checkbox).toBeDisabled();
  }
  await expect(start).toBeDisabled();
  await expect(end).toBeDisabled();

  await enabled.check();
  await end.press('Home');
  await advance(end, 'ArrowRight', BOOK_TIME_STEPS.indexOf(602));
  await advance(start, 'ArrowRight', BOOK_TIME_STEPS.indexOf(600));
  await popover.getByRole('button', { name: 'none', exact: true }).click();
  await popover.getByRole('checkbox', { name: 'created', exact: true }).check();

  await expect(page.getByRole('article')).toHaveCount(2);
  await expect(page.getByRole('article', { name: 'THYAO chain', exact: true })).toBeVisible();
  const retainedChain = page.getByRole('article', { name: 'AKBNK chain', exact: true });
  await expect(retainedChain.locator('.book-row')).toHaveCount(2);
  await expect(retainedChain.locator('.book-row-opener')).toContainText('09:30');
  await expect(page.getByRole('article', { name: 'GARAN chain', exact: true })).toHaveCount(0);
  await expect(page.getByRole('article', { name: 'ISCTR chain', exact: true })).toHaveCount(0);

  await popover.getByRole('checkbox', { name: 'sent', exact: true }).check();
  await expect(page.getByRole('article')).toHaveCount(3);
  await expect(page.getByRole('article', { name: 'GARAN chain', exact: true })).toBeVisible();
  await expect(retainedChain.locator('.book-row')).toHaveCount(2);

  await popover.getByRole('button', { name: 'all', exact: true }).click();
  for (const field of timeFields) {
    await expect(popover.getByRole('checkbox', { name: field, exact: true })).toBeChecked();
  }
  await expect(enabled).toBeChecked();
  await expectTime(start, 600);
  await expectTime(end, 602);

  await popover.getByRole('button', { name: 'none', exact: true }).click();
  for (const field of timeFields) {
    await expect(popover.getByRole('checkbox', { name: field, exact: true })).not.toBeChecked();
  }
  await expect(enabled).toBeChecked();
  await expectTime(start, 600);
  await expectTime(end, 602);
  await page.keyboard.press('Escape');
  await expect(popover).toHaveCount(0);
  await expect(
    control.getByRole('button', {
      name: `${formatBookTime(600)}-${formatBookTime(602)}`,
      exact: true,
    }),
  ).toBeFocused();

  await expect(page.getByText('No chains match this filter.')).toBeVisible();
  await page.getByRole('button', { name: 'clear the time filter', exact: true }).click();
  await expect(control.getByRole('button', { name: 'any time', exact: true })).toBeVisible();
  await expect(page.getByRole('article')).toHaveCount(4);
  expect(
    safeBridge.requests.some((request) =>
      /\/rpc\/(RefreshData|ConfigureBot|SendOrders|EditOrders|CancelOrders|CancelPendingOrderRequests)$/.test(
        request.path,
      ),
    ),
  ).toBe(false);
});

test('uses the requested clock steps and allows equal endpoints without crossing', async ({
  page,
}) => {
  const control = page.locator('.book-time-filter');
  await control.getByRole('button', { name: 'any time', exact: true }).click();
  const popover = control.getByRole('dialog');
  await popover.getByRole('checkbox', { name: 'filter', exact: true }).check();
  const start = popover.getByRole('slider', { name: 'Start time', exact: true });
  const end = popover.getByRole('slider', { name: 'End time', exact: true });

  await expectTime(start, 0);
  await expectTime(end, 1439);
  await start.press('ArrowRight');
  await expectTime(start, 60);
  await advance(start, 'ArrowRight', 8);
  await expectTime(start, 540);
  await start.press('ArrowRight');
  await expectTime(start, 590);
  await start.press('ArrowRight');
  await expectTime(start, 595);
  await start.press('ArrowRight');
  await expectTime(start, 596);

  await advance(end, 'ArrowLeft', BOOK_TIME_STEPS.length - 1 - BOOK_TIME_STEPS.indexOf(1085));
  await expectTime(end, 1085);
  await end.press('ArrowRight');
  await expectTime(end, 1090);
  await advance(end, 'ArrowRight', 10);
  await expectTime(end, 1140);
  await end.press('ArrowRight');
  await expectTime(end, 1200);
  await end.press('End');
  await expectTime(end, 1439);
  await end.press('ArrowLeft');
  await expectTime(end, 1380);
  await end.press('ArrowRight');
  await expectTime(end, 1439);
  await end.press('ArrowRight');
  await expectTime(end, 1439);

  await start.press('Home');
  await end.press('Home');
  await advance(end, 'ArrowRight', BOOK_TIME_STEPS.indexOf(600));
  await start.press('End');
  await expectTime(start, 600);
  await expectTime(end, 600);
  await start.press('ArrowRight');
  await expectTime(start, 600);
  await end.press('ArrowLeft');
  await expectTime(end, 600);

  // An equal range still represents one full minute, so 10:00:00 is retained.
  await popover.getByRole('button', { name: 'none', exact: true }).click();
  await popover.getByRole('checkbox', { name: 'created', exact: true }).check();
  await expect(page.getByRole('article')).toHaveCount(1);
  await expect(page.getByRole('article', { name: 'THYAO chain', exact: true })).toBeVisible();
});

test('range buttons update the kept chains without changing the chosen clock', async ({ page }) => {
  const control = page.locator('.book-time-filter');
  await control.getByRole('button', { name: 'any time', exact: true }).click();
  const popover = control.getByRole('dialog');
  await popover.getByRole('checkbox', { name: 'filter', exact: true }).check();
  const start = popover.getByRole('slider', { name: 'Start time', exact: true });
  const end = popover.getByRole('slider', { name: 'End time', exact: true });
  await end.press('Home');
  await advance(end, 'ArrowRight', BOOK_TIME_STEPS.indexOf(602));
  await advance(start, 'ArrowRight', BOOK_TIME_STEPS.indexOf(600));
  await popover.getByRole('button', { name: 'none', exact: true }).click();
  await popover.getByRole('checkbox', { name: 'created', exact: true }).check();
  await expect(page.getByRole('article')).toHaveCount(2);

  await popover
    .getByRole('button', { name: 'Whole time range one step later', exact: true })
    .click();
  await expectTime(start, 601);
  await expectTime(end, 603);
  await expect(page.getByRole('article')).toHaveCount(2);
  await expect(page.getByRole('article', { name: 'AKBNK chain', exact: true })).toBeVisible();
  await expect(page.getByRole('article', { name: 'GARAN chain', exact: true })).toBeVisible();
  await expect(page.getByRole('article', { name: 'THYAO chain', exact: true })).toHaveCount(0);

  await popover.getByRole('button', { name: 'Start time one step earlier', exact: true }).click();
  await expectTime(start, 600);
  await expectTime(end, 603);
  await expect(page.getByRole('article')).toHaveCount(3);
  await popover.getByRole('button', { name: 'End time one step earlier', exact: true }).click();
  await expectTime(start, 600);
  await expectTime(end, 602);
  await expect(page.getByRole('article')).toHaveCount(2);
  await expect(page.getByRole('article', { name: 'THYAO chain', exact: true })).toBeVisible();
  await expect(page.getByRole('article', { name: 'GARAN chain', exact: true })).toHaveCount(0);
  await expect(popover.getByRole('checkbox', { name: 'created', exact: true })).toBeChecked();
  for (const field of timeFields.filter((field) => field !== 'created')) {
    await expect(popover.getByRole('checkbox', { name: field, exact: true })).not.toBeChecked();
  }
});

test('edits exact custom minutes and keeps matching chains through the entire end minute', async ({
  page,
}) => {
  const control = page.locator('.book-time-filter');
  await control.getByRole('button', { name: 'any time', exact: true }).click();
  const popover = control.getByRole('dialog');
  const startInput = popover.getByRole('textbox', { name: 'Start time', exact: true });
  const endInput = popover.getByRole('textbox', { name: 'End time', exact: true });
  const start = popover.getByRole('slider', { name: 'Start time', exact: true });
  const end = popover.getByRole('slider', { name: 'End time', exact: true });

  await expect(startInput).toBeDisabled();
  await expect(endInput).toBeDisabled();
  await popover.getByRole('checkbox', { name: 'filter', exact: true }).check();
  await popover.getByRole('button', { name: 'none', exact: true }).click();
  await popover.getByRole('checkbox', { name: 'sched', exact: true }).check();
  await startInput.click();
  await expectSelectedTime(startInput);
  await startInput.pressSequentially('001');
  await expect(startInput).toHaveValue('00:1');
  await expect(start).toHaveAttribute('aria-valuetext', '00:00');
  await startInput.pressSequentially('5abc9');
  await expect(startInput).toHaveValue('00:15');
  await expect(start).toHaveAttribute('aria-valuetext', '00:15');
  await endInput.click();
  await expectSelectedTime(endInput);
  await endInput.pressSequentially('0125');
  await expect(endInput).toHaveValue('01:25');
  await expect(end).toHaveAttribute('aria-valuetext', '01:25');

  await expect(page.getByRole('article')).toHaveCount(2);
  await expect(page.getByRole('article', { name: 'THYAO chain', exact: true })).toBeVisible();
  const retainedChain = page.getByRole('article', { name: 'AKBNK chain', exact: true });
  await expect(retainedChain.locator('.book-row')).toHaveCount(2);
  await expect(page.getByRole('article', { name: 'GARAN chain', exact: true })).toHaveCount(0);
  await expect(page.getByRole('article', { name: 'ISCTR chain', exact: true })).toHaveCount(0);

  await startInput.click();
  await expectSelectedTime(startInput);
  await startInput.click();
  await expect
    .poll(() =>
      startInput.evaluate((input: HTMLInputElement) => input.selectionStart === input.selectionEnd),
    )
    .toBe(true);
  await popover.getByRole('button', { name: 'Start time one step later', exact: true }).click();
  await expect(startInput).toHaveValue('01:00');
  await expect(page.getByRole('article')).toHaveCount(1);
  await expect(retainedChain).toBeVisible();
  await end.press('ArrowLeft');
  await expect(startInput).toHaveValue('01:00');
  await expect(endInput).toHaveValue('01:00');
  await expect(page.getByText('No chains match this filter.')).toBeVisible();
});

async function advance(slider: Locator, direction: 'ArrowLeft' | 'ArrowRight', count: number) {
  for (let index = 0; index < count; index += 1) await slider.press(direction);
}

async function expectSelectedTime(input: Locator) {
  await expect
    .poll(() =>
      input.evaluate((element: HTMLInputElement) => [element.selectionStart, element.selectionEnd]),
    )
    .toEqual([0, 5]);
}

async function expectTime(slider: Locator, minute: number) {
  await expect(slider).toHaveValue(String(BOOK_TIME_STEPS.indexOf(minute)));
  await expect(slider).toHaveAttribute('aria-valuetext', formatBookTime(minute));
}
