# DailyDataAggregator boundary

This directory is the only frontend/server boundary allowed to contact DailyDataAggregator or
read its `bars.db` database.

- Live quotes come through same-origin `/bridge/price/*` routes.
- `feed !== "live"` makes every price untrustworthy, regardless of its age fields.
- `trade_age_ms` is a liquidity signal, not a freshness verdict.
- Unknown symbols may be omitted upstream; callers reconcile the returned symbol keys.
- Never call `/quotes` with an empty list because upstream treats that as “all symbols”.
- Historical queries accept bounded symbol/date pairs and fixed bar types, never SQL.
- SQLite is opened read-only/query-only for each request and closed immediately.
