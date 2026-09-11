import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';

import { BookTimeFilter } from './BookTimeFilter';
import { defaultBookFilters, type BookFilterState } from './types';

describe('BookTimeFilter range buttons', () => {
  it('shows the compact active range label and resets only the two times', async () => {
    const user = userEvent.setup();
    renderControl({ timeFrom: 85, timeTo: 602, timeFields: new Set(['createdTime']) });

    expect(screen.getByRole('button', { name: '01:25-10:02' })).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Reset time range' }));

    expectRange('00:00', '23:59');
    expect(screen.getByRole('checkbox', { name: 'created' })).toBeChecked();
    for (const field of ['sched', 'intent', 'sent', 'order', 'final']) {
      expect(screen.getByRole('checkbox', { name: field })).not.toBeChecked();
    }
    expect(screen.getByRole('button', { name: 'Reset time range' })).toBeDisabled();
  });

  it('disables every range button while off and the outward steps at the day bounds', async () => {
    const user = userEvent.setup();
    renderControl({ timeFilter: false });

    const buttons = screen.getAllByRole('button', { name: /one step/ });
    expect(buttons).toHaveLength(6);
    for (const button of buttons) expect(button).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Reset time range' })).toBeDisabled();
    for (const input of screen.getAllByRole('textbox')) expect(input).toBeDisabled();

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
    expectRange('23:00', '23:59');
    expect(stepButton('Whole time range', 'later')).toBeDisabled();
    await user.click(stepButton('Whole time range', 'later'));
    expectRange('23:00', '23:59');
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

describe('BookTimeFilter editable times', () => {
  it('selects the time on entry, inserts the colon, and keeps at most four digits when typing or pasting', async () => {
    const user = userEvent.setup();
    renderControl();
    const start = timeInput('Start time');
    expect(start).toHaveAttribute('inputmode', 'numeric');

    await user.click(start);
    expect(start.selectionStart).toBe(0);
    expect(start.selectionEnd).toBe(5);
    await user.keyboard('0125');
    expect(start).toHaveValue('01:25');
    expectRange('01:25', '23:59');

    await user.click(timeInput('End time'));
    await user.click(start);
    await user.paste('0125');
    expect(start.selectionStart).toBe(5);
    expect(start.selectionEnd).toBe(5);
    await user.keyboard('9abc');
    expect(start).toHaveValue('01:25');
    expectRange('01:25', '23:59');

    await user.click(timeInput('End time'));
    await user.click(start);
    expect(start.selectionStart).toBe(0);
    expect(start.selectionEnd).toBe(5);
    await user.paste('a00:15b9');
    expect(start).toHaveValue('00:15');
    expectRange('00:15', '23:59');
  });

  it('lets Backspace and Delete edit digits across the automatic colon', async () => {
    const user = userEvent.setup();
    renderControl({ timeFrom: 85 });
    const start = timeInput('Start time');
    await user.click(start);
    await user.keyboard('{Home}{ArrowRight}{ArrowRight}{ArrowRight}{Backspace}');
    expect(start).toHaveValue('02:5');
    expect(start.selectionStart).toBe(1);
    expectRange('01:25', '23:59');
    await user.keyboard('1');
    expect(start).toHaveValue('01:25');

    await user.keyboard('{Home}{ArrowRight}{ArrowRight}{Delete}');
    expect(start).toHaveValue('01:5');
    expect(start.selectionStart).toBe(2);
    expectRange('01:25', '23:59');
    await user.keyboard('2');
    expect(start).toHaveValue('01:25');
  });

  it('moves the other endpoint when a typed value crosses it in either direction', async () => {
    const user = userEvent.setup();
    renderControl({ timeFrom: 600, timeTo: 602 });

    await user.click(timeInput('Start time'));
    await user.keyboard('1105');
    expectRange('11:05', '11:05');
    expect(timeInput('End time')).toHaveValue('11:05');
    expect(stepButton('Start time', 'later')).toBeDisabled();
    expect(stepButton('End time', 'earlier')).toBeDisabled();

    await user.click(timeInput('End time'));
    await user.keyboard('0125');
    expectRange('01:25', '01:25');
    expect(timeInput('Start time')).toHaveValue('01:25');
    await user.click(stepButton('Whole time range', 'later'));
    expectRange('02:00', '02:00');
  });

  it('leaves the applied range intact during incomplete or invalid drafts and restores it on blur or Enter', async () => {
    const user = userEvent.setup();
    renderControl({ timeFrom: 85, timeTo: 600 });
    const start = timeInput('Start time');

    await user.click(start);
    await user.keyboard('12');
    expectRange('01:25', '10:00');
    await user.click(timeInput('End time'));
    expect(start).toHaveValue('01:25');

    for (const invalid of ['0061', '2400', '2360']) {
      await user.click(start);
      await user.keyboard(`{Control>}a{/Control}${invalid}`);
      expectRange('01:25', '10:00');
      await user.keyboard('{Enter}');
      expect(start).toHaveValue('01:25');
    }

    await user.keyboard('{Control>}a{/Control}0160');
    expect(start).toHaveValue('02:00');
    expectRange('02:00', '10:00');
  });

  it('keeps individual and whole-range buttons usable with times between the normal slider stops', async () => {
    const user = userEvent.setup();
    renderControl({ timeFrom: 15, timeTo: 85 });

    await user.click(stepButton('Whole time range', 'later'));
    expectRange('01:00', '02:00');
    await user.click(timeInput('Start time'));
    await user.keyboard('0015');
    await user.click(timeInput('End time'));
    await user.keyboard('0125');
    expectRange('00:15', '01:25');
    await user.click(stepButton('Start time', 'later'));
    expectRange('01:00', '01:25');
    await user.click(stepButton('End time', 'earlier'));
    expectRange('01:00', '01:00');
    expect(stepButton('Start time', 'later')).toBeDisabled();
    expect(stepButton('End time', 'earlier')).toBeDisabled();
  });
});

describe('BookTimeFilter switch', () => {
  const CLOCKS = ['created', 'sched', 'intent', 'sent', 'order', 'final'];

  it('comes up off with no clock ticked, and switches on still ticking none', async () => {
    const user = userEvent.setup();
    renderControl({ timeFilter: false });

    for (const field of CLOCKS) {
      expect(screen.getByRole('checkbox', { name: field })).not.toBeChecked();
      expect(screen.getByRole('checkbox', { name: field })).toBeDisabled();
    }
    await user.click(screen.getByRole('checkbox', { name: 'filter' }));
    for (const field of CLOCKS) {
      expect(screen.getByRole('checkbox', { name: field })).not.toBeChecked();
      expect(screen.getByRole('checkbox', { name: field })).toBeEnabled();
    }
  });

  it('puts the clocks back to none when switched off, and keeps the range', async () => {
    const user = userEvent.setup();
    renderControl({ timeFrom: 600, timeTo: 602 });

    await user.click(screen.getByRole('button', { name: 'all' }));
    await user.click(screen.getByRole('checkbox', { name: 'filter' }));
    for (const field of CLOCKS) {
      expect(screen.getByRole('checkbox', { name: field })).not.toBeChecked();
    }
    expectRange('10:00', '10:02');
  });

  it('carries no leg-side toggles: those answer for every row filter, beside matching orders only', () => {
    renderControl();
    for (const name of ['buys', 'sells', 'include canceled']) {
      expect(screen.queryByRole('checkbox', { name })).toBeNull();
    }
  });
});

function timeInput(name: 'Start time' | 'End time') {
  return screen.getByRole<HTMLInputElement>('textbox', { name });
}

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
