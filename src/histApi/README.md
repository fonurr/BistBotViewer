# histApi — historical minute prices from BistData

The third data boundary, beside `bistApi` (MatriksOrder) and `priceApi` (DailyDataAggregator).
It answers one question: **what was this stock trading at, at one exact minute in the past** — the
`intent` instant the Book already computes, which no MatriksOrder table stores.

The source is the sibling `../BistData` pipeline. Unlike the other two boundaries, this one has no
upstream on a request path at all.

## The once-a-night contract

`../BistData/docs/database-guide.md` is blunt about the cost of opening its DuckDB files: **any**
connection — `read_only=True` included — takes a cross-process lock, and the pipeline, which must
open read-write, then aborts its next `sync` before fetching anything. Nothing is corrupted; the
databases silently stop advancing, and that stays invisible until someone notices the newest date
is old.

So the rule here is absolute:

> DuckDB is opened **once per snapshot day**, by `snapshotWorker.mjs`, in a worker thread the
> scheduler terminates the moment it answers. A browser request can never cause it to be touched.

Everything the running app reads comes from `data/intent-bars.db`, a SQLite cache this repo builds
and owns. Deleting that cache loses nothing — the next window rebuilds it.

- `scheduler.ts` aims at **23:00 Istanbul**. A **snapshot day** is named by that boundary and runs
  until **18:00 the next evening**; inside it, a failed attempt is retried at most hourly, and a
  successful one stops the scheduler until the following 23:00. A machine asleep at 23:00 catches
  up on the next server start, provided it is still inside the window.
- A locked source is the expected failure (BistData's own `sync` was running). The previous cache
  stays in place and the next hourly tick tries again. Nothing is ever half-written: the snapshot
  builds `intent-bars.db.building` and `rename()`s it into place.
- Terminating the worker is what unloads the native addon, so no handle can outlive a run.
  `npm run dev` holding a lock for a whole day is exactly the failure this design exists to
  prevent — verify it by re-opening `minute.duckdb` after a snapshot.
- The scheduler never runs under `BIST_VIEWER_FIXTURES` or `VITEST`. Playwright cannot reach DuckDB.

## What the snapshot takes, and why that much

Only what the viewer can be asked about: for every `(symbol, session)` that MatriksOrder holds an
order, position or trade in — read from the same `BIST_VIEWER_ORDER_DB` the logs bridge uses — plus
**the next trading session**, because a stamp written past close + 10 has its intent instant on the
following day. That is ~0.2% of `minute_bars` (410k of 198M rows, 30 MB, on the current history).

Whole sessions are taken rather than the individual target minutes, because the "previous minute's
close" rule needs the neighbour and because a later refinement of the intent rule should not need
another DuckDB visit.

### Normalization happens here, once

BistData stores whatever the provider served, and the provider adjusts for corporate actions
inconsistently. `scale.duckdb` records the multiplier that puts a stored price onto the **BIST daily
bulletin's raw scale** — `normalized_price = stored_price * factor`, as date ranges per
`(scope, symbol)`. `scope = 'daily'` covers the synthetic auction rows, `'minute'` the real traded
minutes.

That matters because MatriksOrder's fill price is the real price paid that session, i.e. already on
the bulletin's scale. Without the factor a corporate action silently poisons every intent slip.

The snapshot applies the factor and drops what it cannot stand behind, so a request is a plain
`(symbol, ts)` point lookup and the browser never sees a factor:

- a session listed in `scale_exception` for its scope — its multiplier contradicts its range;
- a session listed in `data_quality_finding` — the bar itself is wrong, not merely mis-scaled;
- `confidence: 'assumed'` is **kept** at its 1.0 factor. The bulletin never covered that symbol, so
  nothing can be measured; the ±23% guard in `domain/intentPrice` is what catches a bad scale
  instead. `scale_used` keeps every range that was applied, for explaining a surprising figure
  without opening DuckDB again.
- `symbol_alias` rows with `also_stored_locally` are collapsed onto `bulletin_symbol`, or the
  instrument would be stored twice.

### The half-day re-stamp

BistData always writes its synthetic closing print at **18:05**, including on a BIST half day whose
close is 12:30. `domain/calendar` puts the closing-auction instant at close + 5. The snapshot
therefore **re-stamps** the closing auction row to that session's own close + 5, so the domain can
do one point lookup on both kinds of day. The opening print stays at 09:55 — a half day only moves
the close.

## Routes

Both are loopback and same-origin only, and both are refused outright under fixtures.

| Route | Body | Answers |
|---|---|---|
| `GET /bridge/hist/status` | — | `available`, `snapshotFor`, `builtAt`, `barRows`, `stale` |
| `POST /bridge/hist/bars/intent` | `{ keys: [{ symbol, ts }] }`, ≤ 1000 | the matching `intent_bar` rows |

`ts` is epoch milliseconds and must already be the **exact minute wanted**: which minute answers an
intent instant is `domain/intentPrice`'s rule, not a database's. A missing minute comes back absent
rather than as an error — it means nothing traded then, and the caller withholds the figure rather
than reaching for a neighbour.

`intentBarsWorker.mjs` opens the cache read-only and query-only per bounded request and closes it in
a `finally`, exactly as `priceApi`'s bars worker does.

## Degraded states

A cache that has never been built is the ordinary first-run state, not an error: `status` reports
`available: false`, the bar read returns 503, and every intent cell stays empty. `stale` is
`snapshotFor` failing to be the current snapshot day — the page says the intent prices are out of
date rather than dropping them, since a day-old minute bar from 2026-08-25 is still the right answer
for an instant on 2026-08-25.
