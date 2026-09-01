# Bots

`BotsPage` is the fleet surface and the only UI that calls `ConfigureBot`. It reads one shared
all-bot snapshot for identities, accounts, active and scheduled orders, positions, and closed
trades, and queued baskets. Budget reads begin only after that snapshot is complete, skip
incomplete bots, and are limited to bots visible under the current filters. A cached budget is
withheld while invalidated, refetching, stale, or failed. Live quotes are requested for every
visible Position and partially filled exposure; the runtime owns the one stream that serves them.

The toolbar's account filter is the Book's own `MultiSelectFilter`, so the control, its label, its
`all` action, Escape, click-away and focus return behave identically on every page. It carries one
option GetAccounts cannot supply — `No account set` — because a bot with unset routing belongs to no
account and would otherwise be unreachable from the filter.

Cards use the server's `complete` flag for health. The `buys` and `positions` counts are **live**
counts — only rows that can still execute — while `BotRowCounts` stays a raw row count, because
that is what decides delete versus deactivate. Counts and P&L are derived only after every
fleet table read succeeds; an incomplete read is rendered as unavailable, never as a false zero.
Unrealized P&L is all-or-nothing: **every** required symbol must resolve to a price, from the live
stream or from its newest stored bar. One symbol the viewer cannot price at all withholds the whole
figure and greys the ones it could compute. How old the prices are is stated once, in the header,
never on a row. Description text is displayed unchanged and is also the bot-name tooltip.

`Open book` and `Performance` both deep-link with `?bot=<id>`: the Book opens narrowed to that
bot, and Performance recomputes for it.

`BotConfigDialog` owns Add, Edit, and Finish setup. The limits fieldset resolves the arithmetic
rather than only describing it: the effective per-stock cap
(`min(limitPerPosition, portfolioValue × limitPercentagePerPosition/100)`) with the side that
binds, committed money against the limit currently typed, and a warning when a per-stock cap above
the total cap can never bind. A form that still matches the stored record is muted, not a fault. Add rejects duplicate and reserved ids; Edit
sends only dirty fields. Account routing is locked while active, scheduled, or position rows
exist. The form distinguishes an unset email list from a deliberately empty array, submits the
forbidden-stock list whole, and continuously checks limits against the latest known commitment.

`BotStatusDialog` owns Reactivate and the two outcomes of `active: false`. Its confirmation lists
the four persistent row counts plus queued baskets. Queued baskets block deletion, id reuse,
routing changes, and reactivation until canceled. Before any status write it refreshes those rows
once; if the outcome changed, it returns to the confirmation with the new facts.

Every write is held while the order stream is not live and is sent at most once. `ConfigureBot`
is an upsert and returns only `{}`, so each path performs a fresh `GetBots` preflight to avoid an
obvious overwrite/recreation and one postflight before naming a semantic result. A successful
write with a failed or contradictory postflight says only that configuration was saved and marks
the current bot state unknown. No dialog offers a retry.
