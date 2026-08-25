# Bots

`BotsPage` is the fleet surface and the only UI that calls `ConfigureBot`. It reads one shared
all-bot snapshot for identities, accounts, active and scheduled orders, positions, and closed
trades, and queued baskets. Budget reads begin only after that snapshot is complete, skip
incomplete bots, and are limited to bots visible under the current filters. A cached budget is
withheld while invalidated, refetching, stale, or failed. Live quotes are requested for every
visible Position and partially filled exposure.

Cards use the server's `complete` flag for health. Counts and P&L are derived only after every
fleet table read succeeds; an incomplete read is rendered as unavailable, never as a false zero.
Unrealized P&L is all-or-nothing: the producer and every required quote must be live and carry a
price. Description text is displayed unchanged and is also the bot-name tooltip.

`Open book` and `Performance` both deep-link with `?bot=<id>`: the Book opens narrowed to that
bot, and Performance recomputes for it.

`BotConfigDialog` owns Add, Edit, and Finish setup. Add rejects duplicate and reserved ids; Edit
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
