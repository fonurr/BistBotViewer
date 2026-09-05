import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';

import { DateRangeFilter, rangeLabel, stepRange, type DateRange } from './DateRangeFilter';

// A Friday, a Monday and a Tuesday: the weekend between them is exactly the gap
// a step has to pass over, because no batch was ever filed under it.
const dates = ['2026-08-21', '2026-08-24', '2026-08-25', '2026-08-26'];
const CURRENT_SESSION = '2026-08-26';

describe('stepRange', () => {
  it('walks the whole window from one loaded batch to the next', () => {
    expect(stepRange({ from: '2026-08-21', to: '2026-08-24' }, dates, 'both', 1)).toEqual({
      from: '2026-08-24',
      to: '2026-08-25',
    });
    expect(stepRange({ from: '2026-08-24', to: '2026-08-25' }, dates, 'both', -1)).toEqual({
      from: '2026-08-21',
      to: '2026-08-24',
    });
  });

  it('refuses a step that would carry either end past the loaded batches', () => {
    // The window keeps its width rather than shortening against the edge.
    expect(stepRange({ from: '2026-08-25', to: '2026-08-26' }, dates, 'both', 1)).toBeNull();
    expect(stepRange({ from: '2026-08-21', to: '2026-08-24' }, dates, 'both', -1)).toBeNull();
  });

  it('moves one edge alone, and never through the other', () => {
    const range = { from: '2026-08-24', to: '2026-08-25' };
    expect(stepRange(range, dates, 'from', 1)).toEqual({ from: '2026-08-25', to: '2026-08-25' });
    expect(stepRange(range, dates, 'from', -1)).toEqual({ from: '2026-08-21', to: '2026-08-25' });
    expect(stepRange(range, dates, 'to', 1)).toEqual({ from: '2026-08-24', to: '2026-08-26' });
    expect(stepRange(range, dates, 'to', -1)).toEqual({ from: '2026-08-24', to: '2026-08-24' });

    const single = { from: '2026-08-24', to: '2026-08-24' };
    expect(stepRange(single, dates, 'from', 1)).toBeNull();
    expect(stepRange(single, dates, 'to', -1)).toBeNull();
  });

  it('resolves a window that has fallen between the loaded batches', () => {
    // 22.08 and 23.08 are a weekend no batch was ever filed under — a range a
    // narrowing filter can leave behind. It settles on the last batch the
    // window still reaches rather than on nothing, and steps from there.
    expect(stepRange({ from: '2026-08-22', to: '2026-08-23' }, dates, 'to', 1)).toEqual({
      from: '2026-08-21',
      to: '2026-08-24',
    });
  });

  it('has nothing to step while no batch has loaded', () => {
    expect(stepRange({ from: null, to: null }, [], 'both', 1)).toBeNull();
  });
});

describe('rangeLabel', () => {
  it('names one batch as a date rather than as a range onto itself', () => {
    expect(rangeLabel({ from: '2026-08-24', to: '2026-08-24' })).toBe('24.08.26');
    expect(rangeLabel({ from: '2026-08-21', to: '2026-08-26' })).toBe('21.08.26 → 26.08.26');
  });
});

describe('DateRangeFilter', () => {
  it('settles on its default range as soon as a batch is loaded', async () => {
    // The Book opens on the newest session; a report over one day is not a
    // report, so Performance opens on every batch it has.
    const { unmount } = renderControl('latest');
    expect(await screen.findByRole('button', { name: '26.08.26' })).toBeVisible();
    unmount();

    renderControl('all');
    expect(await screen.findByRole('button', { name: '21.08.26 → 26.08.26' })).toBeVisible();
  });

  it('stops `latest` at the batch the desk has reached', async () => {
    const user = userEvent.setup();
    // A scheduled order is filed under the session it is aimed at, so the list
    // runs two batches past the one being worked.
    const ahead = [...dates, '2026-08-27', '2026-08-28'];
    renderControl('latest', ahead);
    expect(await screen.findByRole('button', { name: '26.08.26' })).toBeVisible();

    // They are real batches, so `all` holds them and the steppers reach them.
    const later = screen.getByRole('button', { name: /whole range one batch later/i });
    expect(later).toBeEnabled();
    await user.click(later);
    expect(screen.getByRole('button', { name: '27.08.26' })).toBeVisible();

    await user.click(screen.getByRole('button', { name: '27.08.26' }));
    await user.click(screen.getByRole('button', { name: 'all' }));
    expect(screen.getByRole('button', { name: '21.08.26 → 28.08.26' })).toBeVisible();

    await user.click(screen.getByRole('button', { name: 'latest' }));
    expect(screen.getByRole('button', { name: '26.08.26' })).toBeVisible();
  });

  it('takes the nearest batch where every loaded one is beyond the current', async () => {
    renderControl('latest', ['2026-08-27', '2026-08-28']);

    expect(await screen.findByRole('button', { name: '27.08.26' })).toBeVisible();
  });

  it('does not settle before the reads are in', async () => {
    // The page's reads land one at a time, and this is taken once — so the
    // first one back must not get to choose the day.
    renderControl('latest', ['2026-08-28'], false);

    expect(await screen.findByRole('button', { name: 'Every batch' })).toBeVisible();
  });

  it('walks the window from its steppers and disables them at the bounds', async () => {
    const user = userEvent.setup();
    renderControl();

    const later = screen.getByRole('button', { name: /whole range one batch later/i });
    const earlier = screen.getByRole('button', { name: /whole range one batch earlier/i });
    await screen.findByRole('button', { name: '26.08.26' });
    expect(later).toBeDisabled();

    await user.click(earlier);
    expect(screen.getByRole('button', { name: '25.08.26' })).toBeVisible();
    expect(later).toBeEnabled();

    // 23.08 is a Sunday and 22.08 a Saturday: neither carries a batch, so the
    // step lands on the Friday.
    await user.click(earlier);
    await user.click(earlier);
    expect(screen.getByRole('button', { name: '21.08.26' })).toBeVisible();
    expect(earlier).toBeDisabled();
  });

  it('moves each edge from its own pair, and stops it against the other', async () => {
    const user = userEvent.setup();
    renderControl();
    await screen.findByRole('button', { name: '26.08.26' });

    await user.click(screen.getByRole('button', { name: /start one batch earlier/i }));
    expect(screen.getByRole('button', { name: '25.08.26 → 26.08.26' })).toBeVisible();

    await user.click(screen.getByRole('button', { name: /end one batch earlier/i }));
    expect(screen.getByRole('button', { name: '25.08.26' })).toBeVisible();
    expect(screen.getByRole('button', { name: /end one batch earlier/i })).toBeDisabled();
    expect(screen.getByRole('button', { name: /start one batch later/i })).toBeDisabled();
  });

  it('offers the whole-set shortcuts, and states all of them as dates', async () => {
    const user = userEvent.setup();
    renderControl();
    await screen.findByRole('button', { name: '26.08.26' });

    await user.click(screen.getByRole('button', { name: '26.08.26' }));
    await user.click(screen.getByRole('button', { name: 'all' }));
    // `all` is a range like any other, so it names its days rather than reading
    // as an unset filter.
    expect(screen.getByRole('button', { name: '21.08.26 → 26.08.26' })).toBeVisible();

    await user.click(screen.getByRole('button', { name: 'latest' }));
    expect(screen.getByRole('button', { name: '26.08.26' })).toBeVisible();
  });

  it('refuses a day no batch was filed under, and takes two clicks for a range', async () => {
    const user = userEvent.setup();
    renderControl();
    await screen.findByRole('button', { name: '26.08.26' });
    await user.click(screen.getByRole('button', { name: '26.08.26' }));

    expect(screen.getByRole('button', { name: '23 August 2026' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '22 August 2026' })).toBeDisabled();

    await user.click(screen.getByRole('button', { name: '21 August 2026' }));
    expect(screen.getByRole('button', { name: '21.08.26' })).toBeVisible();

    await user.click(screen.getByRole('button', { name: '25 August 2026' }));
    expect(screen.getByRole('button', { name: '21.08.26 → 25.08.26' })).toBeVisible();
  });
});

function renderControl(
  defaultRange: 'latest' | 'all' = 'latest',
  loaded: readonly string[] = dates,
  ready = true,
) {
  function Harness() {
    const [open, setOpen] = useState<string | null>(null);
    const [range, setRange] = useState<DateRange>({ from: null, to: null });
    return (
      <DateRangeFilter
        open={open === 'dates'}
        setOpen={setOpen}
        dates={loaded}
        ready={ready}
        currentSession={CURRENT_SESSION}
        range={range}
        onChange={setRange}
        defaultRange={defaultRange}
      />
    );
  }
  return render(<Harness />);
}
