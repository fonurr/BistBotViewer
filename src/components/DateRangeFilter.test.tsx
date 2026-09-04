import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';

import { DateRangeFilter, shiftRange, type DateRange } from './DateRangeFilter';

const dates = ['2026-08-24', '2026-08-25', '2026-08-26', '2026-08-27'];

describe('shiftRange', () => {
  it('walks both ends one calendar day at a time', () => {
    expect(shiftRange({ from: '2026-08-25', to: '2026-08-26' }, dates, 1)).toEqual({
      from: '2026-08-26',
      to: '2026-08-27',
    });
    expect(shiftRange({ from: '2026-08-25', to: '2026-08-26' }, dates, -1)).toEqual({
      from: '2026-08-24',
      to: '2026-08-25',
    });
  });

  it('steps over a day no batch was filed under, because the step is a day', () => {
    // 25th and 26th are missing from the loaded batches; the window still lands
    // on them rather than skipping to the next session that has rows.
    expect(
      shiftRange({ from: '2026-08-24', to: '2026-08-24' }, ['2026-08-24', '2026-08-27'], 1),
    ).toEqual({ from: '2026-08-25', to: '2026-08-25' });
  });

  it('holds the end that is against the bound and moves the other', () => {
    expect(shiftRange({ from: '2026-08-26', to: '2026-08-27' }, dates, 1)).toEqual({
      from: '2026-08-27',
      to: '2026-08-27',
    });
    expect(shiftRange({ from: '2026-08-24', to: '2026-08-25' }, dates, -1)).toEqual({
      from: '2026-08-24',
      to: '2026-08-24',
    });
  });

  it('reads an open end as the bound it stands for', () => {
    expect(shiftRange({ from: null, to: null }, dates, 1)).toEqual({
      from: '2026-08-25',
      to: '2026-08-27',
    });
    expect(shiftRange({ from: null, to: null }, dates, -1)).toEqual({
      from: '2026-08-24',
      to: '2026-08-26',
    });
  });

  it('refuses the step only when neither end can move', () => {
    expect(shiftRange({ from: '2026-08-27', to: '2026-08-27' }, dates, 1)).toBeNull();
    expect(shiftRange({ from: '2026-08-24', to: '2026-08-24' }, dates, -1)).toBeNull();
    expect(shiftRange({ from: null, to: null }, ['2026-08-24'], 1)).toBeNull();
    expect(shiftRange({ from: null, to: null }, [], 1)).toBeNull();
  });

  it('pulls a range left outside the loaded batches back inside them', () => {
    expect(shiftRange({ from: '2020-01-01', to: '2030-01-01' }, dates, 1)).toEqual({
      from: '2026-08-25',
      to: '2026-08-27',
    });
  });
});

describe('DateRangeFilter', () => {
  it('walks the window from its steppers and stops only where neither end can move', async () => {
    const user = userEvent.setup();
    renderControl();

    const later = screen.getByRole('button', { name: /one day later/i });
    const earlier = screen.getByRole('button', { name: /one day earlier/i });
    expect(screen.getByRole('button', { name: /Every batch/ })).toBeVisible();

    await user.click(later);
    // The open window stood for 24.08 → 27.08; its far end is already against
    // the last batch, so only the near end moved.
    expect(screen.getByRole('button', { name: /25\.08\.26 → 27\.08\.26/ })).toBeVisible();

    await user.click(later);
    await user.click(later);
    expect(screen.getByRole('button', { name: /27\.08\.26 → 27\.08\.26/ })).toBeVisible();
    expect(later).toBeDisabled();
    expect(earlier).toBeEnabled();

    await user.click(earlier);
    expect(screen.getByRole('button', { name: /26\.08\.26 → 26\.08\.26/ })).toBeVisible();
    expect(later).toBeEnabled();
  });

  it('offers the whole-set shortcuts as the bot filter offers all and none', async () => {
    const user = userEvent.setup();
    renderControl();

    await user.click(screen.getByRole('button', { name: /Every batch/ }));
    await user.click(screen.getByRole('button', { name: 'latest' }));
    expect(screen.getByRole('button', { name: /27\.08\.26 → 27\.08\.26/ })).toBeVisible();

    // A pick leaves the popover open, so the next one is one click away.
    await user.click(screen.getByRole('button', { name: 'all' }));
    expect(screen.getByRole('button', { name: /Every batch/ })).toBeVisible();
  });
});

function renderControl(initial: DateRange = { from: null, to: null }) {
  function Harness() {
    const [open, setOpen] = useState<string | null>(null);
    const [range, setRange] = useState(initial);
    return (
      <DateRangeFilter
        open={open === 'dates'}
        setOpen={setOpen}
        dates={dates}
        range={range}
        onChange={setRange}
      />
    );
  }
  return render(<Harness />);
}
