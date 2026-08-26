# Shared components

This directory owns application-wide presentation primitives. Pages may import these
components; shared components never import a page.

- `AppShell` renders navigation, the single freshness indicator, refresh control, stream
  interruption, logs trigger, and toast region.
- `Modal` provides focus entry, focus trapping, Escape handling, and trigger-focus return. Its
  heading takes an optional kicker, a subtitle naming the record, and an `aside` for the figure
  the dialog is really about — the shape the chain dialog's header uses.
- `ResultList` renders write outcomes without promoting accepted or unknown work to success.
- `FilterPopover` is the one filter-control shape: a trigger stating the current selection, a
  popover carrying the fact that prevents a wrong reading, Escape closing the top layer, and
  focus returning to the trigger. The Book and Performance both use it.
- `useMinuteClock` ticks relative copy — a scheduled countdown, how early a `fire now` goes —
  on the minute boundary, because a quiet snapshot does not re-render on its own.

Components use the Nocturne classes and the variables in `styles/tokens.css`. They do not
contact either upstream service directly.
