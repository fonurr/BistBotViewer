# Shared components

This directory owns application-wide presentation primitives. Pages may import these
components; shared components never import a page.

- `AppShell` renders navigation, the single freshness indicator, refresh control, stream
  interruption, logs trigger, and toast region.
- `Modal` provides focus entry, focus trapping, Escape handling, and trigger-focus return.
- `ResultList` renders write outcomes without promoting accepted or unknown work to success.

Components use the Nocturne classes and the variables in `styles/tokens.css`. They do not
contact either upstream service directly.
