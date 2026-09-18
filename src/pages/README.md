# Pages

Top-level navigation is flat: Bots, Diary, The Book, and Performance. Logs is a drawer over
whichever page is active. Each page owns a README with its reads, writes, and degraded-state
rules.

The Book and Performance file their rows by **batch** — the session a chain belongs to. The Diary
files by the **event's own Istanbul day** instead, because nothing it draws is a chain. The two
words are kept apart in the UI: the shared range control is headed `batch range` on the first two
and `event days` on the Diary.

Pages may import shared components and API/domain interfaces. Shared components never import a
page, and no page performs raw network or database access.
