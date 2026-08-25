# Domain rules

Pure calculations and presentation semantics live here so page components do not reinterpret the
trading contract. Functions in this module do not fetch, mutate, or retain server state.

High-risk rules—chain identity, sellable quantity, status vocabulary, trust-aware P&L, budget
caps, date/session handling, and write-result state—must have direct unit tests. Preserve unknown
values as `null`; never coerce them to zero or a successful status.
