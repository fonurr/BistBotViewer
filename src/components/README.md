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
  keeps meaning every bot. Given `active` and `onActiveChange` it also grows an off switch leading
  that row, for a filter that narrows the page even with every option ticked — the Book's canceled
  statuses. Off is not a selection but the filter not applying, so every box goes ticked and
  disabled behind it and the trigger falls back to `inactiveLabel` in placeholder ink; the bot,
  account and symbol controls omit the pair and are always on. `SymbolFilter` never accepts free
  text: a symbol the loaded rows
  do not name cannot be filtered to, and a typed one would silently return nothing. Toggling a
  symbol (by click or Enter) clears the search box so the next one starts fresh.
- `DateRangeFilter` is the one batch-range control, built on `FilterPopover` and shared by the
  Book and Performance so a range means the same thing on both. **Every date it can reach is a
  batch date**: the steppers walk the loaded list and the calendar disables every day no batch was
  filed under, so a window over a day nothing was filed in cannot be asked for. `null` at either
  end is not a range but the state before the first read; the control resolves it to its
  `defaultRange` as soon as a batch exists — `latest` for the Book, whose subject is a day's work,
  and `all` for Performance, where a report over one day is not a report. A page that clears the
  filter back to `null` therefore gets that default back, so a control meaning to widen a range
  must state the widest one outright.
  Its whole-set shortcuts sit on the same row `MultiSelectFilter` gives `all` and `none`:
  `latest`, `last 5`, `all`. `all` is a range like any other and names its days rather than
  reading as unset. `latest` is the newest batch **the desk has reached** — `currentSession`,
  which is `sessionBatchDate` of this moment and not today's calendar day: on a Saturday it is
  Monday's session, because Friday's evening orders are already filed under it. A scheduled order
  reaches further still, being filed under whichever session it is aimed at, and `latest` stops
  short of that; `all`, the steppers and the calendar all still go on, because those are real
  batches. Settling waits on `ready`: a page's reads land one at a time, the default is taken once
  and never revisited, so a first snapshot must not get to choose the day. Five steppers surround the trigger — `‹` and `›` walk the whole window, and
  the `+ / −` pair on each side moves that side's edge alone. None of them shortens the window
  against a bound: a step that cannot be taken whole is refused, and `stepRange` returning `null`
  is what disables the button that asked. The trigger is a fixed width and names one batch as one
  date, so a range collapsing does not resize the toolbar under the hand that collapsed it.
- `useMinuteClock` ticks relative copy — a scheduled countdown, how early a `fire now` goes —
  on the minute boundary, because a quiet snapshot does not re-render on its own.

Components use the Nocturne classes and the variables in `styles/tokens.css`. They do not
contact either upstream service directly.
