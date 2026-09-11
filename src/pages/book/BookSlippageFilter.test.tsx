import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';

import { BookSlippageFilter } from './BookSlippageFilter';
import { defaultBookFilters, type BookFilterState } from './types';

const FIELDS = [
  'created price',
  'intent price',
  'sent price',
  'sent time (10s)',
  'order time (5s)',
  'final time (10s or 2m)',
] as const;

const box = (name: string) => screen.getByRole<HTMLInputElement>('checkbox', { name });

describe('BookSlippageFilter', () => {
  it('comes up off, every box ticked and disabled, the trigger reading any slippage', async () => {
    const user = userEvent.setup();
    renderControl({ slippageFilter: false });

    expect(screen.getByRole('button', { name: 'any slippage' })).toBeVisible();
    for (const name of [...FIELDS, 'buys', 'sells']) {
      expect(box(name)).toBeChecked();
      expect(box(name)).toBeDisabled();
    }
    expect(screen.getByRole('button', { name: 'all' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'none' })).toBeDisabled();

    await user.click(box('filter'));
    expect(screen.getByRole('button', { name: '6 slips' })).toBeVisible();
    for (const name of [...FIELDS, 'buys', 'sells']) expect(box(name)).toBeEnabled();
  });

  it('counts the ticked columns on the trigger', async () => {
    const user = userEvent.setup();
    renderControl();

    await user.click(screen.getByRole('button', { name: 'none' }));
    expect(screen.getByRole('button', { name: '0 slips' })).toBeVisible();
    await user.click(box('sent time (10s)'));
    expect(screen.getByRole('button', { name: '1 slip' })).toBeVisible();
    await user.click(box('final time (10s or 2m)'));
    expect(screen.getByRole('button', { name: '2 slips' })).toBeVisible();
  });

  it('keeps the sides untouched when all and none change the columns', async () => {
    const user = userEvent.setup();
    renderControl();

    await user.click(box('sells'));
    await user.click(screen.getByRole('button', { name: 'none' }));
    for (const name of FIELDS) expect(box(name)).not.toBeChecked();
    expect(box('buys')).toBeChecked();
    expect(box('sells')).not.toBeChecked();

    await user.click(screen.getByRole('button', { name: 'all' }));
    for (const name of FIELDS) expect(box(name)).toBeChecked();
    expect(box('buys')).toBeChecked();
    expect(box('sells')).not.toBeChecked();
  });

  it('restores every column and both sides when switched off', async () => {
    const user = userEvent.setup();
    renderControl();

    await user.click(box('buys'));
    await user.click(box('created price'));
    await user.click(box('filter'));
    for (const name of [...FIELDS, 'buys', 'sells']) expect(box(name)).toBeChecked();
    expect(screen.getByRole('button', { name: 'any slippage' })).toBeVisible();
  });
});

function renderControl(overrides: Partial<BookFilterState> = {}) {
  function Harness() {
    const [open, setOpen] = useState<string | null>('slippage');
    const [filters, setFilters] = useState<BookFilterState>({
      ...defaultBookFilters,
      slippageFilter: true,
      ...overrides,
    });
    return (
      <BookSlippageFilter
        filters={filters}
        onChange={setFilters}
        open={open === 'slippage'}
        setOpen={setOpen}
      />
    );
  }
  return render(<Harness />);
}
