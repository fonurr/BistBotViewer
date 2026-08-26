# The Book

The Book is the primary operational surface. `BookPage` loads one global snapshot through the
typed boundaries, builds chains strictly from `chainId`, filters them client-side, and renders
the fixed desktop grid. Null chain links stay independent.

A bot card's `Open book` arrives as `?bot=<id>`. The parameter seeds the bot filter once and
is dropped as soon as the toolbar is used, so the URL never fights the state it seeded.

The four scopes are a **partition of chains, not a row filter**. Every chain is classified once,
by the furthest stage its own life reached — it holds shares (`positions`), it bought and sold
(`trades`), it can still execute and has bought nothing (`waiting`), or only dead legs are left
(`canceled`). A scope toggle therefore adds or removes whole chains, and a chain in view draws
**every leg it owns** whatever kind that leg is; the only rows a toggle may withhold are the
canceled ones, and that is the canceled toggle's job alone.

Grouping is date → bot → scope. The scope line (`waiting · 3 chains · 6 waiting orders, nothing
bought yet`) **opens its own group**, immediately above the chains it counts, and carries that
group's aggregate — unrealized for positions, realized for trades. The focused
`no closing order` list spans scopes on purpose, so it groups by bot alone.

`BookFilters` owns additive scopes and the bot, account, symbol, and batch-range controls.
Account selection uses the stored account and brokerage together; matching account numbers at
different brokerages remain separate filters.
Queued baskets carry per-row selection. `CancelPendingOrderRequests` names one bot, so a
selection spanning bots becomes one call per bot, itemized in the confirm step in the order they
will be made, and every id gets its own outcome — `canceled`, `gone` and `wrongBot` are each
rendered as themselves.

`BookGrid` owns chain grouping and row vocabulary. `OrderDialog` is the only place from this
page that performs writes; it keeps the view → form/confirm → sending → result sequence and
never retries a write automatically.

Price values are trusted only while DailyDataAggregator reports a live feed. The page remains a
frozen, timestamped snapshot and holds every write when the MatriksOrder event stream is down.
Partially filled buys and sells contribute their confirmed filled shares to row and aggregate P&L
without double-counting the full Position that remains stored during a partial sell.
