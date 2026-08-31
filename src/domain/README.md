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
