import { describe, expect, it } from 'vitest';

import { accountIdentityKey } from './accounts';

describe('accountIdentityKey', () => {
  it('keeps the brokerage in account identity without delimiter collisions', () => {
    expect(accountIdentityKey('ACC-1', 'BRK-A')).not.toBe(accountIdentityKey('ACC-1', 'BRK-B'));
    expect(accountIdentityKey('ACC:1', 'BRK')).not.toBe(accountIdentityKey('ACC', '1:BRK'));
  });
});
