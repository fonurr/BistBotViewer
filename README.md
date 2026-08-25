# BistBotViewer

BistBotViewer is a loopback-only operations console for MatriksOrder. It presents bots, complete
order chains, gross closed-trade performance, and bounded local logs without changing either
sibling service.

The application is dark-only and desktop-oriented. The Book uses one fixed grid so prices and
statuses remain aligned across every leg of every chain.

## Prerequisites

- Node.js 22.16 or newer
- MatriksOrder listening on `127.0.0.1:8788`
- DailyDataAggregator listening on `127.0.0.1:8789`
- Their SQLite databases at the sibling paths shown in `.env.example`, or explicit overrides

Install and run:

```powershell
npm install
npx playwright install chromium
npm run dev
```

Open `http://127.0.0.1:5175/book`. The Vite host is part of the security boundary: browser code
talks only to same-origin `/bridge/*` routes, and those routes accept same-origin requests from a
loopback host only.

For a production build and local preview:

```powershell
npm run build
npm start
```

## Architecture

```text
browser pages
  ├─ src/bistApi     → loopback bridge → MatriksOrder HTTP/SSE + read-only log databases
  └─ src/priceApi    → loopback bridge → DailyDataAggregator + read-only bars.db worker
```

The browser never receives upstream addresses or database paths. SQLite work happens in workers;
connections are opened read-only and query-only for one bounded request, then closed. No endpoint
accepts SQL or a filesystem path from the browser.

The shared TanStack Query cache is memory-only. MatriksOrder SSE events reconcile loaded reads.
Every table read checkpoints a bounded in-memory event journal and replays writes that arrive
while its HTTP snapshot is unresolved, including the first read of a lazy page. Initial connect,
reconnect, protocol recovery, and manual read retry all take a complete snapshot while buffering
events before the runtime enables writes.

## Safety model

- Writes require a per-launch same-origin CSRF session and are held while SSE is down, refreshing,
  or reconciling. The hold is checked again after session bootstrap, immediately before fetch.
- Writes are never retried automatically.
- Unknown outcomes stay unknown and state whether they may have reached the exchange.
- An empty `CancelOrders` reply is only `Accepted`; the row remains live until refresh confirms
  the cancellation. Server-held scheduled orders are the only confirmed-remove exception.
- Fixture mode blocks every live bridge before a worker or upstream connection is created.
- Automated tests must mock every write and must never target ports 8788 or 8789.

## Configuration

Copy `.env.example` to `.env.local` only when sibling URLs or database locations differ. Every
target URL must remain loopback. `BIST_VIEWER_FIXTURES=true` disables all live upstream and
database access; Playwright uses that mode and intercepts its own fixtures.

## Verification

```powershell
npm run check
```

`check` verifies formatting, type-checks, runs Oxlint plus architecture guards, executes
unit/component tests, builds the production bundle, and runs the fixture-only Chromium suite.
Playwright's bundled Chromium must be installed once with the command above.

The authoritative behavior lives in `initial design handoff/AGENTS.md`, `SPEC.md`,
`SCREEN-MAP.md`, and `TOKENS.md`. The root `AGENTS.md` records the implementation constraints for
future changes.
