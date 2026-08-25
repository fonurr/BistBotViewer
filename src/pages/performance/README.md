# Performance

This page reports completed round trips only. Every money figure is gross because the service
does not store commissions or taxes.

`PerformancePage` scopes raw ClosedTrades by the selected bot/account/symbol and date window,
then delegates arithmetic to `domain/performance`. Auction-bar reads are bounded to the exact
symbol/date keys requested by that report. Missing bars, incomplete holiday coverage, missing
true fill timestamps, and the absence of order type on ClosedTrades are represented as
unavailable metrics rather than zeros or estimates.

Execution timestamps are acknowledgement times, not true fill times. A trade learned on a weekend
or full holiday remains in totals and is bucketed by that observed date; it is never discarded for
being learned outside a trading session. Missing current-session closing bars are polled so a bar
written later can replace an earlier unavailable metric.

The page is read-only. A bot-card deep link uses `?bot=<id>` and recomputes the whole report;
fleet comparison tables disappear for that single-bot scope.
