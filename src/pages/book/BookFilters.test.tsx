import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { accountIdentityKey } from '../../domain/accounts';
import { makeAccount, makeBot } from '../../test/fixtures';
import { BookFilters } from './BookFilters';
import { defaultBookFilters } from './types';

describe('BookFilters account identity', () => {
  it('offers identical account numbers at different brokerages as distinct filters', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const accounts = [
      makeAccount({ brokerageId: 'BRK-1', owner: 'Owner one' }),
      makeAccount({ brokerageId: 'BRK-2', owner: 'Owner two' }),
    ];

    render(
      <BookFilters
        filters={defaultBookFilters}
        onChange={onChange}
        bots={[
          makeBot({ id: 'bot-one', brokerageId: 'BRK-1' }),
          makeBot({ id: 'bot-two', brokerageId: 'BRK-2' }),
        ]}
        accounts={accounts}
        chains={[]}
        noClosingOrderCount={0}
        mismatchCount={0}
        canceledCount={0}
        canceledVisible={false}
        manualOpenLegs={0}
        manualClosedChains={0}
        onToggleCanceled={vi.fn()}
        onOpenMismatch={vi.fn()}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'All accounts' }));
    const firstBrokerage = screen.getByRole('checkbox', { name: /ACC-1.*BRK-1/ });
    const secondBrokerage = screen.getByRole('checkbox', { name: /ACC-1.*BRK-2/ });

    expect(firstBrokerage).toBeChecked();
    expect(secondBrokerage).toBeChecked();
    await user.click(secondBrokerage);

    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({
        accountIds: new Set([accountIdentityKey('ACC-1', 'BRK-1')]),
      }),
    );
  });
});
