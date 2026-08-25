import { describe, expect, it } from 'vitest';

import type { Quote } from '../priceApi/types';
import { requiredQuotesAreTrustworthy } from './dataHooks';

const quote = (symbol: string, son: number | null = 10, feed: Quote['feed'] = 'live'): Quote => ({
  symbol,
  son,
  feed,
  ghacim_try: null,
  quote_age_ms: 0,
  price_change_age_ms: 0,
  trade_age_ms: 0,
  server_ts: 1,
});

describe('requiredQuotesAreTrustworthy', () => {
  it('requires one live priced quote for every requested symbol', () => {
    expect(requiredQuotesAreTrustworthy(['AKBNK', 'THYAO'], 'live', [])).toBe(false);
    expect(requiredQuotesAreTrustworthy(['AKBNK', 'THYAO'], 'live', [quote('AKBNK')])).toBe(false);
    expect(
      requiredQuotesAreTrustworthy(['AKBNK', 'THYAO'], 'live', [quote('AKBNK'), quote('THYAO')]),
    ).toBe(true);
  });

  it('rejects null prices, stale rows, duplicate symbols, extras, and a stale feed', () => {
    expect(requiredQuotesAreTrustworthy(['AKBNK'], 'live', [quote('AKBNK', null)])).toBe(false);
    expect(requiredQuotesAreTrustworthy(['AKBNK'], 'live', [quote('AKBNK', 10, 'stalled')])).toBe(
      false,
    );
    expect(requiredQuotesAreTrustworthy(['AKBNK'], 'stalled', [quote('AKBNK')])).toBe(false);
    expect(requiredQuotesAreTrustworthy(['AKBNK'], 'live', [quote('AKBNK'), quote('AKBNK')])).toBe(
      false,
    );
    expect(requiredQuotesAreTrustworthy(['AKBNK'], 'live', [quote('THYAO')])).toBe(false);
  });
});
