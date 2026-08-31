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
  focus returning to the trigger.
- `EntityFilters` builds the Book's own bot, account and symbol controls on it, and Bots and
  Performance use those same components rather than shapes of their own. `MultiSelectFilter`
  treats `null` as every option — which is not the same set as all of them ticked, because a page
  that gains a bot keeps meaning _every bot_ until someone narrows it — and its trigger counts the
  selection instead of naming it. Given `picks`, it moves `all` out of the heading corner onto a
  row of whole-set shortcuts; `botPicks` builds the bot row the Book and Performance share
  (`all`, `none`, `active`, `inactive`). A pick states the set it selects at the moment it is
  taken, so a bot switched on afterwards does not join a selection made as `active` — only `all`
  keeps meaning every bot. `SymbolFilter` never accepts free text: a symbol the loaded rows
  do not name cannot be filtered to, and a typed one would silently return nothing.
- `useMinuteClock` ticks relative copy — a scheduled countdown, how early a `fire now` goes —
  on the minute boundary, because a quiet snapshot does not re-render on its own.

Components use the Nocturne classes and the variables in `styles/tokens.css`. They do not
contact either upstream service directly.
