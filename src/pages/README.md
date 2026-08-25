# Pages

Top-level navigation is flat: Bots, The Book, and Performance. Logs is a drawer over whichever
page is active. Each page owns a README with its reads, writes, and degraded-state rules.

Pages may import shared components and API/domain interfaces. Shared components never import a
page, and no page performs raw network or database access.
