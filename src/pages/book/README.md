# The Book

The Book is the primary operational surface. `BookPage` loads one global snapshot through the
typed boundaries, builds chains strictly from `chainId`, filters them client-side, and renders
the fixed desktop grid. Null chain links stay independent.

A bot card's `Open book` arrives as `?bot=<id>`. The parameter seeds the bot filter once and
is dropped as soon as the toolbar is used, so the URL never fights the state it seeded.

The four scopes are a **partition of chains, not a row filter**. Every chain is classified once,
by the furthest stage its own life reached — it holds shares (`positions`), it bought and sold
(`trades`), it can still execute and has bought nothing (`waiting`), or only dead legs are left
(`canceled`, drawn as **Never Opened** — the scope key is not its word, and what the reader is
picking is the chains that never opened a position, not the chains that own a canceled leg). A scope toggle therefore adds or removes whole chains, and a chain in view draws
**every leg it owns** whatever kind that leg is; the only rows a toggle may withhold are the
canceled ones, and that is the canceled toggle's job alone.

Grouping is date → bot → scope. The batch heading leads (`15.08.26 · batch · friday · 11
chains`) and the column band sits **under** it, because the columns belong to the batch they
head. A batch is a **session, not a clock day**: a chain is filed under the session its opening
order belongs to. A session keeps what is written for it until ten minutes past its close
(18:10, or 12:40 on a half day); anything later, at the weekend, or on a full holiday belongs
to the next trading day. `domain/calendar.ts` owns that rule and reads it against the
`GetHolidays` calendar; without one it still rolls off a weekend and off the close, since an
absent holiday row cannot prove a weekday was open. A row whose own day is not the batch date
then states its date beside the clock, which is what `formatRowTime` already does. Ord time and
ack time carry their seconds: the minute is what a reader scans, so `formatRowTimeParts` hands
the seconds back separately and the cell draws them — their colon with them — at half opacity.

A batch heading is the control that opens its batch: the whole line is a button with a chevron
and `aria-expanded`, and the column band and every bot under it are drawn only while it is open.
**The newest batch opens itself and the rest wait behind their chevron** — that is the one batch
being worked, and it is what keeps the Book quick when every date is selected and `trades` is
switched on. A shut batch still names its date, its weekday and how many chains it holds, so
nothing is hidden that a reader has to open the batch to learn. `BookGrid` keeps two sets rather
than one: `opened` is what a reader asked for and `closed` is the newest batch they shut, so the
default follows the newest batch whatever the filters make it. The scope line **opens its own
group**, immediately above the chains it heads, and is the scope's word plus that group's
aggregate — unrealized for positions, realized for trades — and nothing else. It restates
neither the chain count the batch heading already carries nor what the scope means. The
focused `no closing order` list spans scopes on purpose, so it groups by bot alone.

Row vocabulary follows the visual reference: an opener carries its symbol alone and a leg carries
nothing in that column — the opener above already said the symbol and the hairline says where the
chain ends, so a leg only speaks its symbol to a screen reader. A **sell row leaves the qty column
empty** when its size is the buy's whole size — an `auto` sell, or one whose quantity equals the
chain's opening buy; only a partial sell writes a number there. **No id is printed in the grid.**
Both the chain id and every order's client-order id are read in the chain dialog, opened from the
symbol, and there they are given in full rather than abbreviated to a tail. The
**The asked price is gray and the fill is not**: `order` is only the setting a row was sent
with, while `fill` is the figure the `slip` and `p&l` beside it are both read off, so the fill
column keeps the row's ink and weight and the order column steps back into muted (a market
order's captured price keeps its italic over that). The
status cell states its qualifier **inline** in muted ink after a middle dot — `New · resting 22m
· 40 of 150 filled`, `Position · held 3d 2h`, `By user · canceled in the MatriksIQ terminal`. On a
canceled row that qualifier is the server's own `reason` first, then the verbatim wire
`explanation`, then the retry count — every part that is stored, joined by middle dots. The
`x of y filled` clause is drawn **only for a genuine partial fill** (some filled, not all): a
resting order with nothing filled says as much by resting, and a filled one is not waiting. A
resting time is read off `orderTime`, the exchange's own registration stamp, never off the ack
column. The one row that takes lines of its own is a cancel in flight: its two sentences span
the row beneath the cells, because it is the only row whose state changes while you watch it.

An order that **executed** carries the faintest gray tint behind it (`--st-done-t`, read off the
body text since settled ink has no hue of its own), the way a canceled tail carries the dead tint:
a trades chain draws every leg it ever had, and the tint is what separates the legs it has finished
with from the ones still in play. It sits a shade under the canceled tint on purpose — nothing
there needs attention, and a filled row is the ordinary outcome.

A canceled tail collapses to `+N canceled` in dead ink, the breakdown of who ended the orders,
and `show` on the right; opened, the rows sit inside the tint with the note and `hide` beneath
them. **Switching the never-opened scope on opens the tails with it** — a chain in that scope owns
nothing but canceled legs, so asking for it while they are hidden would draw collapsed stubs. That
runs one way only: switching the scope back off leaves the toggle where the reader left it, since
by then they may be reading canceled legs on chains that traded.

`BookFilters` owns additive scopes and the bot, account, symbol, canceled-status, reason, source,
and batch-range controls. The
bot, account and symbol controls are `components/EntityFilters` and the batch range is
`components/DateRangeFilter`, which the Bots and Performance
pages import unchanged — the Book defines the shape, and no page reimplements it. A trigger states
the current selection as a count (`4 bots`, `2 accounts`), and an unset symbol filter reads
`any symbol` in placeholder ink. The bot popover carries `all`, `none`, `active` and `inactive`
over its heading; `none` empties the book and the reason panel names the bot narrowing that did
it, while `all` returns to meaning every bot rather than ticking today's. The **needs-a-human** pill lives at the right of
that same toolbar row — a dead-tinted pill with its warning glyph, its clickable counts, and the
word `unfiltered`, said once. Its counts never follow the filters — it is the one count on this
toolbar that does not, which is why it says so. The canceled toggle beside it **is** its own
count, so it counts what it would uncover: the canceled legs on the chains the filters kept, and
it is not drawn at all where they kept none.
Account selection uses the stored account and brokerage together; matching account numbers at
different brokerages remain separate filters.

The **batch range** is `components/DateRangeFilter`, and Performance draws the same control over
the same list, so a range set on one page means the same set of sessions on the other. Its list
holds only the dates the loaded chains were filed under — a session where no bot ran has no batch
and is simply not in it — but its two steppers walk **calendar days**, so a window can be nudged
onto a day that holds nothing. Both ends move together until one reaches the first or last loaded
batch; that end then holds while the other keeps moving, and the stepper only goes disabled once
neither can move.

The **canceled-status filter** lists every status the loaded canceled orders carry, in the display
form the status cells print (`By user`, not `CanceledByUser`), so raw wire values that share a
display form share one option. The list is built from the whole loaded book and never follows the
other filters, and each option counts the chains it would keep rather than the legs. It selects
chains, not rows: a chain qualifies by owning a canceled order whose status is ticked, and it is
then drawn whole, exactly as a symbol match draws a whole chain. **Switching it on is itself a
narrowing** — a chain that never lost a leg has nothing that can match, so it drops out even with
every status ticked, and a queued basket, which owns no order yet, drops with it. That is what the
off switch leading the `all` / `none` row is for: off is not "all of them", it is the filter not
being asked, so the boxes behind it are ticked and disabled and the trigger reads `any status` in
placeholder ink. Off also pins the selection back to every status, so those ticked boxes are
telling the truth rather than hiding a narrowing that would spring back on. The switch is the
`active` / `onActiveChange` pair on `components/EntityFilters`; the bot, account and symbol
controls omit it and are always on. Where a book holds no canceled order at all the control is not
drawn — a filter over an empty universe is not a control.

The **reason filter** is the same control over a wider field. `reason` is the server's own key for
why — why an order exists (`ScheduledExit`, `Retry`), why one ended (`BuyGuard`, `Expired`), why a
cancel is in flight for a live order, and why a position was closed (`TakeProfit`). It is never
prose, so it is ticked and printed verbatim, exactly as it arrives; a position row is given none,
because nothing states why a holding exists beyond the buy that opened it. Unlike the status filter
above it reads **every** row, not only the canceled ones: a chain qualifies where any of its rows —
live, scheduled, canceled, or the sell that closed a trade — carries a ticked reason, and is then
drawn whole. Its list is built from the whole loaded book, never follows the other filters, and each
option counts the chains it would keep rather than the rows. It carries the same off switch and for
the same reason: a chain the server recorded nothing about cannot match, so switching it on narrows
the Book even with every reason ticked, and a queued basket — which owns no order yet — drops with
it. Off pins the selection back to every reason. Where no loaded row carries one, the control is not
drawn.

Every row that carries a reason **prints it**, in the status cell's own qualifier line: leading on a
canceled leg, before the verbatim wire `explanation`, and leading likewise on a live or scheduled
order, before whatever that row says about itself. A cancel in flight names who asked and then why,
and the sell that closed a round trip carries why on the `Filled` leg — never on the `Closed` one,
which carries the hold instead. The filter ticks the words the rows print. `reasonData` — the
numbers behind the three reasons that have any — hangs off the reason on the same middle dot,
`BuyGuard · upperLimit: 119,34`, with the server's key unchanged, a colon joining a key to its value
and a comma between pairs, since the dots are already spent. The figure takes the page's own Turkish
form; a value that names the default it came from (`lowerLimit: floor`) prints verbatim, because a
default's number says nothing without its name, and a value of a shape the contract does not
describe is left out rather than guessed at.

**`source` sits beside the status, not in that line at all** — `By user · User`, joined on the same
middle dot and drawn in the status's own hue by `RowVerdict`, because who ended an order is the
other half of the verdict rather than a qualifier of it. Only a stored death names one: nothing says
who is behind a live order, and a row without one simply shows its status. The contract calls the
field `source`; on a Book row that name is already the row's origin table, so the row carries it as
`statusSource`. A cancel still in flight is a separate question — the order has not ended — so it
keeps its own muted `asked by the server` clause and is not folded in here.

The **source filter** is the reason filter's twin over that field: `Broker`, `Bot`, `Server`,
`User`, ticked in the server's own key form, counting the chains each would keep, off by default
behind the same switch, and not drawn at all where no loaded row names a hand.

That line carries **three inks, loudest first** (`BookRowDetailTone`, drawn by `RowDetail` for both
the grid and the chain dialog). What the server decided — the reason and its numbers — is a fact of
the row and stays in body ink. What this page worked out about the row — `resting 22m`, `no exchange
id`, who asked for a cancel, the retry count — is muted. Matriks' own words, quoted verbatim in
`explanation`, ride behind at the same half strength as the seconds on a time cell, so a reason is
never read past to reach an explanation.
Queued baskets draw as the reference does: a tinted header line naming the request, its next
attempt and its budget, with `call off…` on the right, and the basket's stocks beneath it as
rows in the Book's own column grid so their prices stay in the price column. They sit above the
batch groups because a basket has no batch date to file it under. They also carry per-row
selection. `CancelPendingOrderRequests` names one bot, so a
selection spanning bots becomes one call per bot, itemized in the confirm step in the order they
will be made, and every id gets its own outcome — `canceled`, `gone` and `wrongBot` are each
rendered as themselves.

`BookGrid` owns chain grouping and row vocabulary. `OrderDialog` is the only place from this
page that performs writes; it keeps the view → form/confirm → sending → result sequence and
never retries a write automatically.

**Price rules** (`openPrice`, `closePrice`) are the one thing on a row the server acts on by
itself: an entry band keeps guarding a buy after it rests, so a buy can disappear without anyone
asking, and a reached exit cancels the position's scheduled sells and sells it at market. Both are
buy-only, so the guards fieldset is drawn for a buy and for nothing else. The view step states what
a row carries — opener, legs, and the position that inherited a `closePrice` — beneath a standing
note that the server may add narrower rules of its own, because the block is a floor and never a
complete account. **Disarming a guard has to be asked for.** An edit prefills from the stored rule
and omits it while it is untouched; `remove` is what sends the explicit `null` that clears it, and a
stored rule whose fields are merely blanked is refused with the sentence that says so. `fire now`
carries the schedule's rules into its replacement and compares them in the preflight, and refuses to
cancel anything at all when a stored rule cannot be re-expressed — a replacement that went out
unguarded is the one outcome that path may never produce.

A price is either a live streamed quote or the newest stored bar for that symbol, and the row is
drawn the same way whichever it is — how old the prices are is stated once in the header and never
in a cell. A symbol that resolves to neither has no price at all: its figure is withheld, and the
fleet totals beside it go untrusted. The page remains a frozen, timestamped snapshot and holds
every write when the MatriksOrder event stream is down.
The **p&l column carries a figure only on a Position row** (unrealized, all-or-nothing) **and on a
filled sell** (realized — a partial sell's confirmed shares, a closed round trip's closing leg). A
buy order never shows one, and the round trip is read off the sell that closed it, not off the
opening leg. Partial fills still contribute their confirmed shares to the scope-heading and
stat-strip aggregates, without double-counting the full Position stored during a partial sell.

The **today column, right of `p&l`, is the same P&L read from the start of today's Istanbul
calendar day**, with its own percentage beside it — **never the trading session**, which rolls to
the next day ten minutes past the close while it is still today by the clock until midnight; reading
the session date here instead used to zero the column the moment that grace period passed, because a
chain that opened today would suddenly compare itself to today's own, now-final close. A chain whose
batch falls on today's calendar date is measured from its own average entry, so its `today` equals
its `p&l`; one carried over from an earlier day is measured from the previous trading session's
closing-auction bar, read from `bars.db` through the same `/bridge/price/bars/closing` route
Performance uses — the percentage is then against that prior close, not the entry cost. It appears on
the same rows `p&l` does, but only on a sell that executed today — a round trip closed on an earlier
day says nothing about today. The figure is **withheld, never qualified**: a Position with no trusted
live price, or any carried-over row whose prior close is missing, leaves the cell empty rather than
showing a "last known" figure or falling back to the entry price.

The **stat strip leads with `today`, left of `realized`**: every visible chain's move since today
started, summed against what those positions and closed-today sells are measured from, with a
percentage. It is all-or-nothing like `unrealized` — one withheld row makes the whole figure `not
available`.
