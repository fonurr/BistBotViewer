# BotViewer — agent guide

BotViewer is a dark-only React + TypeScript SPA for supervising MatriksOrder bots that trade
real money on BIST. Treat every write path as safety-critical.

## Read first

1. `README.md` for setup, runtime boundaries, and verification commands.
2. The README in the page or boundary you are changing.
3. `initial design handoff/SPEC.md`, `SCREEN-MAP.md`, and `TOKENS.md` for product behavior.
4. The live sibling contracts when an API field or behavior is involved:
   `../MatriksOrder/API.md` and `../DailyDataAggregator/API.md`.

The three handoff contract documents outrank the visual reference. Server field names and
semantics always outrank design intent. `BotViewer.dc.html` is a visual reference only; never
port its markup. The handoff directory is immutable project history after implementation.

## Safety rules

- Never send, edit, cancel, reschedule, resend, or fire an order in automated or manual tests.
- Never use a real ConfigureBot mutation in tests. Mock every write response and SSE follow-up.
- Never modify anything under `../MatriksOrder/` or `../DailyDataAggregator/`.
- Never retry a write automatically. An unknown outcome stays unknown until a snapshot resolves it.
- `CancelOrders` returning `{}` means `Accepted`, not canceled. It is never green until refresh
  confirms the row moved. A scheduled cancel is the exception because it never reached the exchange.
- Hold every write action while the order SSE stream is down.
- A state that cannot be confirmed is never green.

## Architecture boundaries

- `src/bistApi/` is the only module that may contact MatriksOrder or read its local databases.
- `src/priceApi/` is the only module that may contact DailyDataAggregator or read `bars.db`.
- Browser code only uses same-origin `/bridge/*` routes. The bridge binds to loopback and never
  accepts an upstream URL or SQL from the browser.
- SQLite connections are read-only, query-only, bounded, short-lived, and opened per request so
  they do not hold WAL checkpoints open.
- `src/pages/*` may import `src/components/*`; `src/components/*` must never import a page.
- Shared state is central and non-persistent. Pages load lazily and reuse data already held.
- The Book is the source of shared chain, order-form, confirmation, result, filter-popover, and
  status-row behavior. Build or change those shared states before adapting them elsewhere.

## UI contract

- English UI and code only. Turkish number formatting, `dd.MM.yy` dates, Istanbul time.
- Dark only. Use the vendored Nocturne stylesheet and project tokens; do not add ad-hoc colors,
  spacing, radii, shadows, or font sizes.
- Status cells use only the stored statuses and display words from the spec. There is no `Active`.
- Empty table values stay empty. Do not replace missing values with zero or decorative dashes.
- Row actions are ghost buttons. One accent-outlined committing action is allowed per dialog bar.
- Preserve focus, trap it inside dialogs, return it to the trigger, and let Esc close only the
  topmost layer. A sending dialog cannot close.
- The Book is a fixed desktop grid and may scroll horizontally; it never becomes cards.

## Verification

Run the full local gate before handing off:

```text
npm run check
```

The gate must type-check, lint architecture and copy invariants, run unit/component tests, and
produce a production build. Browser tests use fixtures and mocked writes only.
