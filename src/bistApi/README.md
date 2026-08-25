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
- `api-log.db`, `wire-log.db`, and `matriksorder.db` are opened read-only and query-only for one
  bounded request at a time. Do not hold a reader transaction open.

Tests replace this boundary. No test may address port 8788 or mutate a real bot/order.
