import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';

import { BookTimeFilter } from './BookTimeFilter';
import { defaultBookFilters, type BookFilterState } from './types';

describe('BookTimeFilter range buttons', () => {
  it('disables every range button while off and the outward steps at the day bounds', async () => {
    const user = userEvent.setup();
    renderControl({ timeFilter: false });

    const buttons = screen.getAllByRole('button', { name: /one step/ });
    expect(buttons).toHaveLength(6);
    for (const button of buttons) expect(button).toBeDisabled();

    await user.click(screen.getByRole('checkbox', { name: 'filter' }));
    expect(stepButton('Start time', 'earlier')).toBeDisabled();
    expect(stepButton('End time', 'later')).toBeDisabled();
    expect(stepButton('Whole time range', 'earlier')).toBeDisabled();
    expect(stepButton('Whole time range', 'later')).toBeDisabled();
    expect(stepButton('Start time', 'later')).toBeEnabled();
    expect(stepButton('End time', 'earlier')).toBeEnabled();

    await user.click(stepButton('Start time', 'later'));
    await user.click(stepButton('End time', 'earlier'));
    expectRange('01:00', '23:00');
    for (const button of buttons) expect(button).toBeEnabled();

    await user.click(screen.getByRole('checkbox', { name: 'filter' }));
    for (const button of buttons) expect(button).toBeDisabled();
    expectRange('01:00', '23:00');
  });

  it('steps each endpoint along the clock scale while preserving the selected clocks', async () => {
    const user = userEvent.setup();
    renderControl({ timeFrom: 540, timeTo: 600, timeFields: new Set(['createdTime']) });

    await user.click(stepButton('Start time', 'later'));
    expectRange('09:50', '10:00');
    await user.click(stepButton('Start time', 'later'));
    expectRange('09:55', '10:00');
    await user.click(stepButton('Start time', 'later'));
    expectRange('09:56', '10:00');
    await user.click(stepButton('End time', 'earlier'));
    expectRange('09:56', '09:59');
    await user.click(stepButton('Start time', 'earlier'));
    await user.click(stepButton('End time', 'later'));
    expectRange('09:55', '10:00');

    expect(screen.getByRole('checkbox', { name: 'created' })).toBeChecked();
    for (const field of ['sched', 'intent', 'sent', 'order', 'final']) {
      expect(screen.getByRole('checkbox', { name: field })).not.toBeChecked();
    }
    expect(screen.getByRole('checkbox', { name: 'filter' })).toBeChecked();
  });

  it('moves the whole range by one slider stop and preserves its width at the bounds', async () => {
    const user = userEvent.setup();
    const { unmount } = renderControl({ timeFrom: 540, timeTo: 595 });

    await user.click(stepButton('Whole time range', 'later'));
    expectRange('09:50', '09:56');
    await user.click(stepButton('Whole time range', 'earlier'));
    expectRange('09:00', '09:55');
    unmount();

    const upper = renderControl({ timeFrom: 1320, timeTo: 1380 });
    await user.click(stepButton('Whole time range', 'later'));
    expectRange('23:00', '00:00 +1');
    expect(stepButton('Whole time range', 'later')).toBeDisabled();
    await user.click(stepButton('Whole time range', 'later'));
    expectRange('23:00', '00:00 +1');
    upper.unmount();

    renderControl({ timeFrom: 60, timeTo: 120 });
    await user.click(stepButton('Whole time range', 'earlier'));
    expectRange('00:00', '01:00');
    expect(stepButton('Whole time range', 'earlier')).toBeDisabled();
    await user.click(stepButton('Whole time range', 'earlier'));
    expectRange('00:00', '01:00');
  });

  it('allows the endpoints to meet, disables crossing, and moves an equal range together', async () => {
    const user = userEvent.setup();
    renderControl({ timeFrom: 600, timeTo: 601 });

    await user.click(stepButton('Start time', 'later'));
    expectRange('10:01', '10:01');
    expect(stepButton('Start time', 'later')).toBeDisabled();
    expect(stepButton('End time', 'earlier')).toBeDisabled();
    expect(stepButton('Start time', 'earlier')).toBeEnabled();
    expect(stepButton('End time', 'later')).toBeEnabled();
    await user.click(stepButton('Start time', 'later'));
    await user.click(stepButton('End time', 'earlier'));
    expectRange('10:01', '10:01');

    await user.click(stepButton('Whole time range', 'later'));
    expectRange('10:02', '10:02');
    await user.click(stepButton('Whole time range', 'earlier'));
    expectRange('10:01', '10:01');

    await user.click(stepButton('Start time', 'earlier'));
    await user.click(stepButton('End time', 'earlier'));
    expectRange('10:00', '10:00');
    expect(stepButton('Start time', 'later')).toBeDisabled();
    expect(stepButton('End time', 'earlier')).toBeDisabled();
  });
});

function stepButton(
  endpoint: 'Start time' | 'End time' | 'Whole time range',
  by: 'earlier' | 'later',
) {
  return screen.getByRole('button', { name: `${endpoint} one step ${by}` });
}

function expectRange(from: string, to: string) {
  expect(screen.getByRole('slider', { name: 'Start time' })).toHaveAttribute(
    'aria-valuetext',
    from,
  );
  expect(screen.getByRole('slider', { name: 'End time' })).toHaveAttribute('aria-valuetext', to);
}

function renderControl(overrides: Partial<BookFilterState> = {}) {
  function Harness() {
    const [open, setOpen] = useState<string | null>('time');
    const [filters, setFilters] = useState<BookFilterState>({
      ...defaultBookFilters,
      timeFilter: true,
      ...overrides,
    });
    return (
      <BookTimeFilter
        filters={filters}
        onChange={setFilters}
        open={open === 'time'}
        setOpen={setOpen}
      />
    );
  }
  return render(<Harness />);
}
