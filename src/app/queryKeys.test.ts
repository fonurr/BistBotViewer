import { describe, expect, it } from 'vitest';

import { bistKeys, selectorIncludes } from './queryKeys';

describe('bot selector query keys', () => {
  it('keeps scalar ids structurally distinct from lists and wildcards', () => {
    const scalar = bistKeys.activeOrders('list:foo')[2];
    const list = bistKeys.activeOrders(['foo'])[2];
    const wildcard = bistKeys.activeOrders('*')[2];

    expect(scalar).not.toEqual(list);
    expect(selectorIncludes(scalar, 'list:foo')).toBe(true);
    expect(selectorIncludes(scalar, 'foo')).toBe(false);
    expect(selectorIncludes(list, 'foo')).toBe(true);
    expect(selectorIncludes(wildcard, 'anything')).toBe(true);
  });

  it('does not collide comma-bearing ids with multi-bot selectors', () => {
    expect(bistKeys.positions('a,b')[2]).not.toEqual(bistKeys.positions(['a', 'b'])[2]);
    expect(selectorIncludes(bistKeys.positions('a,b')[2], 'a,b')).toBe(true);
  });
});
