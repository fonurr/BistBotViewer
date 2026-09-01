# DailyDataAggregator boundary

This directory is the only frontend/server boundary allowed to contact DailyDataAggregator or
read its `bars.db` database.

- Live quotes are **pushed**: `/bridge/price/stream` proxies upstream `/api/stream` as SSE, and
  `subscribeToPriceEvents` validates every `subscribed` / `quote` / `status` / `stopped` event.
  `/quotes` and `/status` remain as the fallback for a stream that cannot be opened and for a
  symbol set larger than one stream may carry.
- A stream carries at most **200** symbols; `/quotes` takes up to 700. Never send either an empty
  list: upstream reads a missing `symbols` as _none_ on `/stream` and as _all_ on `/quotes`.
- The symbol set is changed by **reopening** the stream, not by upstream's subscribe/unsubscribe
  endpoints. This bridge stays read-only and needs no CSRF; upstream pushes an immediate `quote`
  for every symbol on connect, so nothing is missed beyond the reconnect.
- `status` arrives every five seconds whether or not anything ticked. It is the keep-alive, so
  silence means the connection died rather than the market going quiet, and it keeps flowing while
  the producer's main loop is blocked reconnecting.
- `feed !== "live"` means the quote is not a live price. It does **not** mean the viewer has no
  price: `/bars/latest` returns the newest stored bar per symbol (`PREV_CLOSE` excluded, because it
  is a synthetic sentinel) and `resolvePrices` falls back to it. The header states which is on
  screen; see [priceFeed.ts](../app/priceFeed.ts).
- `trade_age_ms` is a liquidity signal, not a freshness verdict.
- Unknown symbols may be omitted upstream; callers reconcile the returned symbol keys.
- Upstream only runs inside the session and refuses everything outside it, so the viewer opens the
  stream and polls only within `isProducerExpectedUp` (see [calendar.ts](../domain/calendar.ts)).
- Historical queries accept bounded symbol/date pairs and fixed bar types, never SQL.
- SQLite is opened read-only/query-only for each request and closed immediately.
