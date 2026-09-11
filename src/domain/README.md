# Domain rules

Pure calculations and presentation semantics live here so page components do not reinterpret the
trading contract. Functions in this module do not fetch, mutate, or retain server state.

High-risk rules—chain identity, sellable quantity, status vocabulary, trust-aware P&L, budget
caps, date/session handling, and write-result state—must have direct unit tests. Preserve unknown
values as `null`; never coerce them to zero or a successful status.

## Session hours

`sessionHours.ts` is the one place BIST's hours are written down, in Istanbul minutes past
midnight. Never write one as a literal anywhere else — import it, or better, go through the
`calendar.ts` helper that turns it into an instant on a given day:

| anchor                    | full day | half day | constant                                 |
| ------------------------- | -------- | -------- | ---------------------------------------- |
| opening auction match     | 09:55    | 09:55    | `OPENING_MATCH_MINUTE`                   |
| continuous trading opens  | 10:00    | 10:00    | `CONTINUOUS_OPEN_MINUTE`                 |
| continuous trading closes | 18:00    | 12:30    | `CLOSE_MINUTE` / `HALF_DAY_CLOSE_MINUTE` |
| closing auction match     | 18:05    | 12:35    | close + `CLOSING_MATCH_OFFSET_MINUTES`   |
| session stops taking work | 18:10    | 12:40    | close + `SESSION_GRACE_MINUTES`          |

A half day only moves the close; everything read off the close moves with it. The first three
anchors are confirmed against both MatriksOrder's `API.md` ("Which session an order belongs to")
and its `src/orders/schedule.ts`; the steps past the close are that `API.md` section's table,
which `firstTradeInstant` implements. ⚠️ MatriksOrder's own `sessionDay` rolls a batch five
minutes past the close rather than ten; the viewer follows `API.md`, which outranks the sibling's
code here. The file imports nothing so the nightly snapshot worker in `histApi/server` can be
handed the same values by its scheduler rather than keep a copy. Two neighbouring clocks are
deliberately not here: DailyDataAggregator's producer schedule (up from 09:35, gone fifteen
minutes past the close) stays in `calendar.ts`, and MatriksOrder's own send times for a scheduled
order (09:00, and thirty seconds past the opening match or the close) stay in `schedule.ts`,
since neither is the exchange's.

`batchRange.ts` owns the two ways a batch range is read. `batch` keeps what was filed under one of
its sessions; `active` keeps an `ActiveSpan` — from the batch through the session of the newest
thing recorded, open-ended while still alive — that touches any of them. Both pages build their
spans with it (`BookChain.activeSpan`, `closedTradeSpan`), so `active` means the same set of days on
the Book and on Performance.

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
