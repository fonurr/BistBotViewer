# MatriksOrder boundary

This directory is the only frontend/server boundary allowed to contact MatriksOrder or read its
local databases. Browser callers use `client.ts`; loopback bridge code lives under `server/`.

Rules:

- Browser requests are same-origin `/bridge/bist/*`; the upstream URL is never exposed.
- RPC names are allowlisted by the bridge. Mutations require a per-launch CSRF token.
- A write is sent once. The client and bridge never retry it.
- `CancelOrders` success is only `Accepted`; SSE or a later snapshot confirms the move.
- SSE has no replay IDs. Every reconnect refetches active snapshots before applying new events.
- Table reads reject an empty bot list locally instead of calling the server with `[]`.
- `openPrice` and `closePrice` are **buy-only rule objects**, not prices: an entry band and a
  take-profit/stop-loss pair, as signed percentages against a named base. Reads echo them back as
  the JSON string the request supplied, on active, scheduled and canceled orders, and `closePrice`
  alone on a position. `storedPriceRuleSchema` therefore stays lenient — a shape we do not
  recognize costs one rule, never a whole table read; `domain/priceRules.ts` decides what it means.
- The write schemas carry the server's acceptance rules, so a rule it would refuse never leaves the
  browser. On `EditOrders` an omitted rule leaves the stored one alone and an explicit `null` clears
  it; that null is the only way to disarm a guard, so it is never sent by accident.
- `api-log.db`, `wire-log.db`, and `matriksorder.db` are opened read-only and query-only for one
  bounded request at a time. Do not hold a reader transaction open.

Tests replace this boundary. No test may address port 8788 or mutate a real bot/order.
