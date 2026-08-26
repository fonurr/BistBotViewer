# Logs drawer

`LogsDrawer` is the read-only, modal drawer opened over any viewer page. Its public surface is:

```tsx
<LogsDrawer open={logsOpen} onClose={closeLogs} />
```

The app shell owns whether the drawer is open. Keep the component mounted if ranges, filters,
search text, sorting, and column widths should survive closing and reopening during the current
session. Nothing is persisted.

## Data and paging

- All reads go through `bistApi/logClient`; this module never opens a database or contacts an
  upstream service directly.
- Errors, Wire log, and API log remember separate date ranges. Each starts at today-to-today,
  even when today has no stored row, and choosing Today restores that exact range.
- A page is at most 100 rows per source. Older pages repeat the exact date/type filters and use
  the last server-ordered row id as `beforeId`. Display sorting never changes that cursor.
- Totals and type counts come from the first page and stay stable while older pages append.
  Type counts deliberately ignore the current type selection, matching the range-chip contract.
  A type with no row in the chosen range is not offered as a chip at all — a count within the
  range is what makes a chip a filter worth pressing — but a type the user has already selected
  stays, so the control they just pressed never vanishes under them.
- Search is client-side over loaded rows only. Its label and result copy state that scope; it
  never pretends to search rows that have not been loaded.
- Empty unfiltered ranges resolve the nearest stored day. The newer side is found with bounded
  day-level queries because the database boundary intentionally exposes no arbitrary sort.

## Tables

The three source tabs expose every contracted database field. Wide tables scroll horizontally.
Error columns read time → type → account → information, the order the reference puts them in;
every remaining stored field still has a column of its own after those, id included.
Headers sort loaded rows and each column has a pointer/keyboard resize separator. Wire/API body
fields expand below their row, pretty-print JSON when possible, and copy only after an explicit
user action. Display sorting never changes the server-ordered paging cursor, and the footer names
the active display order.

## Modal behavior

Opening captures the invoking element, moves focus to Close, traps Tab inside the drawer, and
restores focus on close. Escape closes the range popover first and the drawer second. Backdrop
interaction follows the same top-layer rule. The native date inputs use the real per-log MIN/MAX
extent and crossing one bound moves the other with an announced explanation.

## Safety boundary

This module contains no write path. `OrderAccountMismatch` and `AccountFeedSilent` are called out
when loaded, but their required page-level escalation remains the Book's responsibility; closing
this drawer must never hide those conditions. Fixture tests must mock `logClient` and must never
address MatriksOrder or its live databases.
