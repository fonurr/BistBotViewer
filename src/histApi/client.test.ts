import { afterEach, describe, expect, it, vi } from 'vitest';

import { histApi, MAX_INTENT_KEYS } from './client';
import type { IntentBar } from './types';

function bar(ts: number): IntentBar {
  return { symbol: 'THYAO', sessionDate: '2026-08-25', ts, open: 1, close: 2, isAuction: false };
}

afterEach(() => vi.unstubAllGlobals());

describe('getIntentBars', () => {
  it('splits a request the bridge would refuse, rather than losing the whole column', async () => {
    // The Book asks for every drawn row: a year of batches passes the per-request
    // bound easily, and one refusal used to empty every cell on the page.
    const keys = Array.from({ length: MAX_INTENT_KEYS + 129 }, (_, index) => ({
      symbol: 'THYAO',
      ts: index,
    }));
    const sent: number[] = [];
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { keys: { ts: number }[] };
      sent.push(body.keys.length);
      return new Response(JSON.stringify(body.keys.map((key) => bar(key.ts))), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const bars = await histApi.getIntentBars(keys);

    expect(sent).toEqual([MAX_INTENT_KEYS, 129]);
    expect(bars).toHaveLength(MAX_INTENT_KEYS + 129);
  });

  it('de-duplicates before splitting, so one minute is never asked for twice', async () => {
    const keys = Array.from({ length: 40 }, (_, index) => ({ symbol: 'thyao', ts: index % 10 }));
    const sent: number[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: RequestInit) => {
        const body = JSON.parse(String(init.body)) as { keys: { ts: number }[] };
        sent.push(body.keys.length);
        return new Response('[]', { status: 200 });
      }),
    );

    await histApi.getIntentBars(keys);

    expect(sent).toEqual([10]);
  });

  it('asks nothing when no row named a minute', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(histApi.getIntentBars([])).resolves.toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
