# Performance

This page reports completed round trips only. Every money figure is gross because the service
does not store commissions or taxes.

`PerformancePage` scopes raw ClosedTrades by the selected bots/accounts/symbols and date window,
then delegates arithmetic to `domain/performance`. Auction-bar reads are bounded to the exact
symbol/date keys requested by that report. Missing bars, incomplete holiday coverage, and the
absence of order type on ClosedTrades are represented as unavailable metrics rather than zeros or
estimates.

## What is derived, and from which stored field

- **Slippage** is `(averagePrice − orderPrice) / orderPrice`, per leg, signed by the direction the
  price moved — never by whether the move helped, and never inked (`SPEC.md` §4). `openOrderPrice`
  is always present, so entry slip exists for every trade; `closeOrderPrice` is `null` for a
  priceless market sell or a manual close, and that leg then yields nothing rather than a zero.
  The **limit/market split the reference shows is not derivable**: ClosedTrades stores prices but
  not order type, and the slippage section states that once.
- **Hold** is `closeExecuteTime − openExecuteTime`. Both are stamps from this server's own clock,
  so their difference is a duration. It is never a time-to-fill or a latency — `API.md` rules those
  out, because each stamp is an upper bound on when the shares actually traded.
- **Retried** counts distinct chains whose stored `openRetryOf…`/`closeRetryOf…` identifier is set.
  A missing order is not evidence of a retry and is never inferred as one.
- The **retry ledger** follows those edges: how many chains needed another attempt, how many ever
  closed, and what the retried fills cost against the price the first attempt had asked. That
  comparison needs the first attempt's canceled row with a non-market order price; a chain without
  one is counted as uncompared, never as neutral. CanceledOrders carries no account id, so
  canceled-only edges are dropped entirely while the account filter is narrowed.
- A bot in scope with **no closed round trip** gets a row saying so. It has no win rate, no
  expectancy and no slip, and averaging it in as zero would be the one figure here nobody could
  reproduce.

Every figure is filed by **batch**: the session a round trip's opening buy could reach, read with
`domain/calendar`'s rule, so this page and the Book file one chain under one day. A trade counts in
the batch it was opened in however many sessions later it closed, which is what makes the window a
set of batches rather than a set of closes — one opened before the window and closed inside it is
out, one opened inside it and closed after is in. An opening written after hours, at a weekend or
on a full holiday counts in the next trading session, and the standing note says how many.

Execution timestamps are acknowledgement times, not true fill times. A round trip whose close was
never observed is excluded, because nothing then places it in time; so is one carrying no opening
stamp, because nothing names its batch. Missing current-session closing bars are polled so a bar
written later can replace an earlier unavailable metric.

Bot, account and symbol filters are the Book's own controls from `components/EntityFilters`, so
all three pages carry one shape. The page is read-only. A bot-card deep link uses `?bot=<id>`,
which is the same state as selecting exactly one bot in the filter; it recomputes the whole report
and the fleet comparison tables disappear for that scope.

Budget context sits with the standing statements at the foot rather than among the figures: it is
a configured limit, not a result, and the window and symbol filters do not change it.
