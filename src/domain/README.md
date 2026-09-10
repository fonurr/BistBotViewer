# Domain rules

Pure calculations and presentation semantics live here so page components do not reinterpret the
trading contract. Functions in this module do not fetch, mutate, or retain server state.

High-risk rules—chain identity, sellable quantity, status vocabulary, trust-aware P&L, budget
caps, date/session handling, and write-result state—must have direct unit tests. Preserve unknown
values as `null`; never coerce them to zero or a successful status.

`priceRules.ts` owns the buy-only `openPrice`/`closePrice` rules end to end: reading the JSON the
server echoes back, saying it out loud, and turning the Book's form draft into a request. It draws
an absent rule apart from one it cannot re-express — display collapses both to nothing, but a write
path must ask `readOpenPrice`/`readClosePrice` and refuse rather than drop a guard it cannot read.

`budget.ts` answers what a group of chains meant to spend on its buys and what it spent, for the
Book's batch and bot headings. A chain contributes one budget however many attempts it took, and
the shares it acquired are read off the position plus every round trip already sold out of it —
never off a resting buy that a position already stands for. ⚠️ **A buy whose order type is no
longer stated is read as a market buy and carries the 10% reservation**: neither `Positions` nor
`ClosedTrades` keeps the opening buy's `type`, and reserving is the reading that cannot understate
what the bot committed. If MatriksOrder ever carries that field onto those tables, read it in
`buyBudgetBuffer` instead of assuming — see `src/pages/book/README.md`. `bookAllocation` answers the
strip's other question — what the chains on screen hold against their bots' limits right now — with
upstream's own two terms: positions at cost, forbidden symbols left out, plus every buy still to open
at its full reservation.
