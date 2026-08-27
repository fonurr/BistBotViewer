# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

BistBotViewer is a dark-only, desktop-oriented React 19 + TypeScript SPA for supervising
MatriksOrder bots that trade real money on BIST. It is read-mostly: it presents bots, complete
order chains, gross closed-trade performance, and bounded local logs without changing either
sibling service. **Treat every write path as safety-critical.**

## Commands

```powershell
npm install
npx playwright install chromium   # once, before test:e2e

npm run dev          # Vite dev server + loopback bridges on 127.0.0.1:5175
npm run build        # tsc -b && vite build
npm start            # preview the production build on 127.0.0.1:4175

npm run check        # the full gate: format:check -> typecheck -> lint -> test:coverage -> build -> test:e2e
npm run typecheck    # tsc -b plus the separate e2e project (tsconfig.e2e.json)
npm run lint         # oxlint + node scripts/check-architecture.mjs
npm test             # vitest run (unit/component, jsdom)
npm run test:e2e     # playwright, fixture mode, its own dev server on port 5176
```

Single test runs:

```powershell
npx vitest run src/domain/chains.test.ts
npx vitest run -t "partial fill"
npx playwright test tests/e2e/book.spec.ts
npx playwright test tests/e2e/book.spec.ts -g "holds writes"
```

Vitest only collects `src/**/*.test.{ts,tsx}`; Playwright only `tests/e2e`. Coverage thresholds
are enforced by `npm run test:coverage` (statements 65 / branches 55 / functions 65 / lines 67),
so `npm run check` fails if coverage drops below them.

## Safety rules (non-negotiable)

- Never send, edit, cancel, reschedule, resend, or fire an order in automated or manual tests.
  Never use a real `ConfigureBot` mutation in a test. Mock every write response and SSE follow-up.
- Tests must never address ports 8788 or 8789. The Playwright harness aborts such requests and
  fails the run.
- Never modify anything under `../MatriksOrder/` or `../DailyDataAggregator/`.
- Never retry a write automatically. An unknown outcome stays unknown until a snapshot resolves it.
- `CancelOrders` returning `{}` means `Accepted`, not `Canceled`. It is never green until a refresh
  confirms the row moved. Server-held scheduled orders are the only confirmed-remove exception.
- Hold every write while the order SSE stream is not live, and re-check the hold immediately
  before fetch (after session bootstrap).
- **A state that cannot be confirmed is never green.** This decides more UI than any other rule.

## Architecture

```text
browser pages
  |- src/bistApi/client.ts   -> /bridge/bist/*  -> MatriksOrder HTTP/SSE + read-only log DBs
  |- src/priceApi/client.ts  -> /bridge/price/* -> DailyDataAggregator + read-only bars.db worker
```

The bridges are **Vite plugins** ([src/bistApi/server/bridge.ts](src/bistApi/server/bridge.ts),
[src/bistApi/server/logs/logsMiddleware.ts](src/bistApi/server/logs/logsMiddleware.ts),
[src/priceApi/server/bridge.ts](src/priceApi/server/bridge.ts)) wired in
[vite.config.ts](vite.config.ts). They run inside the dev and preview servers — there is no
separate backend process. Consequences:

- The browser never learns an upstream URL or database path; it only ever calls same-origin
  `/bridge/*`. Shared host guards live in [src/serverBridge/http.ts](src/serverBridge/http.ts):
  loopback host/origin check, `Sec-Fetch-Site`, bounded JSON bodies, security headers.
- RPC names are allowlisted per bridge (`READ_RPCS` / `MUTATING_RPCS`). Mutations require a
  per-launch CSRF token (cookie plus `X-BotViewer-CSRF` header, compared with `timingSafeEqual`).
- SQLite runs in workers (`*.mjs`), read-only and query-only, opened per bounded request and
  closed, so no WAL checkpoint is held open. No endpoint accepts SQL or a filesystem path.
- `BIST_VIEWER_FIXTURES=true` blocks every live bridge before a worker or upstream connection is
  created. Playwright sets it and intercepts its own fixtures.
- `tsconfig.app.json` deliberately excludes `src/*Api/server` and `src/serverBridge`; that server
  code is type-checked as the node project. `tsconfig.e2e.json` covers `tests/e2e` plus fixtures.

### Runtime state ([src/app/](src/app/))

- `queryClient` is the single, **memory-only** TanStack Query cache. Nothing is persisted; the
  architecture guard rejects `localStorage`/`sessionStorage`/`indexedDB` anywhere in `src/`.
- `ViewerRuntime` owns stream condition, generation-scoped refresh reconciliation, write-event
  buffering, the write hold (`installBistWriteGuard`), scroll restoration, logs visibility, and
  toasts. Pages read it through `useViewerRuntime()`.
- `dataHooks` define the lazy per-page reads and price polling; `liveUpdates` applies validated
  SSE write events to every matching cached selector.
- `queryKeys` encodes the bot selector (`'*'` / one id / a sorted id list) into the key, and
  `selectorIncludes` lets an event find every cache entry that covers a bot.
- Upstream SSE has **no event ids and no replay**. So [src/bistApi/eventJournal.ts](src/bistApi/eventJournal.ts)
  journals validated writes around every unresolved read (`journaledRead`), and initial connect,
  reconnect, protocol recovery, and manual retry all take a complete snapshot with events buffered
  before writes are re-enabled. A read that cannot be reconciled twice fails as `SnapshotOverrun`
  rather than returning a stale snapshot.
- All responses are parsed with Zod schemas in `bistApi/types.ts` / `priceApi/types.ts`. Failures
  become `BistApiError` with a `kind` of `refused | unknown | unavailable | protocol` plus
  `mayHaveReachedExchange` — the UI copy is derived from those fields, so preserve them.

### Module boundaries (enforced by [scripts/check-architecture.mjs](scripts/check-architecture.mjs))

- `src/bistApi/` is the only module that may contact MatriksOrder or read its databases;
  `src/priceApi/` the only one for DailyDataAggregator and `bars.db`. The two never import
  each other.
- `fetch` / `EventSource` outside those two boundaries is an error. `node:fs`, `node:path`,
  `node:worker_threads`, and any sqlite import are allowed only under `*/server/`.
- `src/pages/*` may import `src/components/*`; `src/components/*` must never import a page.
- Runtime code may not import from `initial design handoff/` or the sibling projects.
- Hard-coded `127.0.0.1:8788`/`8789` or sibling `data/` paths outside an API boundary is an error.

Every page module, `components/`, and each API boundary carries its own README describing reads,
writes, and degraded-state rules — read the README of whatever you are changing first. The
[Book README](src/pages/book/README.md) and [Bots README](src/pages/bots/README.md) carry the
densest write-path rules.

### Pages

Flat navigation: Bots, The Book, Performance; Logs is a drawer over whichever page is active. All
four load lazily from [src/app/App.tsx](src/app/App.tsx) and reuse data already in the cache.

The Book is the source of shared chain, order-form, confirmation, result, filter-popover, and
status-row behavior. Build or change those shared states there before adapting them elsewhere.
Chains are built strictly from `chainId`; null links stay independent.

## UI contract

- English UI and code only. Turkish number formatting, `dd.MM.yy` dates, Istanbul time.
- A **batch is a session, not a clock day**: work is filed under the session its opening order
  belongs to — one that keeps what is written for it until ten minutes past the close (18:10, or
  12:40 on a half day), after which the next trading day takes it. `src/domain/calendar.ts` owns
  that rule; the Book files chains by it and Performance reports every figure by it, so one chain
  belongs to one batch on both pages.
- Dark only. Use the vendored Nocturne stylesheet and `src/styles/tokens.css`; never add ad-hoc
  colors, spacing, radii, shadows, or font sizes.
- Status cells carry only stored statuses in their display form (`By user`, not `CanceledByUser`;
  `Partly filled`, not `PartiallyFilled`). There is no `Active`.
- Empty table values stay empty. Never substitute zero or a decorative dash for a missing value;
  `src/domain/` preserves unknowns as `null`.
- Prices are trusted only while DailyDataAggregator reports `feed === "live"`; `trade_age_ms` is a
  liquidity signal, not a freshness verdict. Unrealized P&L is all-or-nothing.
- Row actions are ghost buttons; at most one accent-outlined committing action per dialog bar.
- Preserve focus, trap it inside dialogs, return it to the trigger, and let Esc close only the
  topmost layer. A sending dialog cannot close.
- The Book is a fixed desktop grid that may scroll horizontally; it never becomes cards.
- Do not invent copy for an unspecified state — ask.

## Reference documents

`initial design handoff/` (`SPEC.md`, `SCREEN-MAP.md`, `TOKENS.md`) is the original product
contract and is immutable project history. `BotViewer.dc.html` is a visual reference only; never
port its markup. The sibling contracts `../MatriksOrder/API.md` and
`../DailyDataAggregator/API.md` outrank both: server field names and semantics always win over
design intent. Where the shipped code or a module README contradicts the handoff, the code is the
current truth.

## Git workflow

Agents work directly on `main`. Commit when a task is done; never push.

## Configuration

Copy `.env.example` to `.env.local` only when sibling URLs or database locations differ. Every
target URL must remain an `http://` loopback URL — `assertLoopbackTarget` throws at server start
otherwise.
