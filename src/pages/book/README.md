# The Book

The Book is the primary operational surface. `BookPage` loads one global snapshot through the
typed boundaries, builds chains strictly from `chainId`, filters them client-side, and renders
the fixed desktop grid. Null chain links stay independent.

`BookFilters` owns additive scopes and the bot, account, symbol, and batch-range controls.
Account selection uses the stored account and brokerage together; matching account numbers at
different brokerages remain separate filters.
`BookGrid` owns chain grouping and row vocabulary. `OrderDialog` is the only place from this
page that performs writes; it keeps the view → form/confirm → sending → result sequence and
never retries a write automatically.

Price values are trusted only while DailyDataAggregator reports a live feed. The page remains a
frozen, timestamped snapshot and holds every write when the MatriksOrder event stream is down.
Partially filled buys and sells contribute their confirmed filled shares to row and aggregate P&L
without double-counting the full Position that remains stored during a partial sell.
