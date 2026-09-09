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
states the signed day distance from it (`+1`, `−3`) tucked against the seconds like an exponent —
`formatRowTimeParts` returns it as `dayOffset` — but at the hour's weight, not the seconds': it
says which day this is, not which order came first. The row carries
six time columns, read left to right as the order's life: `created` and `sent` are this server's
own `createdTime`/`sentTime`, `sched` is `scheduledTime` — when the order was **due** to go out —
`intent` is the instant that plan could first have traded, `order` is the exchange's `orderTime`
(the same word the price column carries, never confusable — one is a price, one a clock), and
`final` is `finalSeenTime`. `scheduledTime` is an order stamp that rides through every table, split
per side on a round trip (`openScheduledTime`/`closeScheduledTime`), so a filled position or a
closed trade that opened from a schedule still shows its fire time; only an order sent the moment
it was asked for leaves `sched` empty. A **scheduled row** has reached nothing past it: its time
sits in `sched` alone, and `sent`/`order` stay empty until it goes off.

`intent` is the exact instant the order was **first able** to trade: `scheduledTime`, or
`createdTime` when it was never a plan, run through MatriksOrder's "which session an order belongs
to" rule (`firstTradeInstant` in `domain/calendar.ts`), which folds an off-hours or pre-open stamp
forward to the next auction. Its date agrees with the batch rule, so the cell usually reads the
batch's own day and carries a day-offset only when the plan lands in a later session (an evening
buy's reversing sell dated to the next close). It is empty when the order carries neither stamp;
`orderTime`/`sentTime` are deliberately not fallbacks — `intent` is read off the plan, not off when
the order actually registered.

`created` and `sched` are the two clocks a reader rarely needs, so `.book-time-minor` draws the
whole cell at the seconds' strength. `sent` and `final` are drawn in dead-red (`.book-time-late`)
when they ran late. `sent` is late when it trailed **every** stamp it can be measured against
(`scheduledTime`, `createdTime`) by more than ten seconds. `final` is late, once the order had
registered (`orderTime` present, so the fill notice carries some lag), only when it trailed
**both** the order's `intent` and its own `sent` by more than two minutes. On a row that never
registered — a scheduled order skipped before it fired — `intent` is all there is, and ten seconds
past it is late. Every column carries its seconds: the minute is what a reader scans, so
`formatRowTimeParts` hands the seconds back separately and the cell draws them — their colon with
them — at about a quarter opacity.

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

While scrolling, the batch date and column band stay together below the main navigation,
with the current bot heading directly beneath them. Each heading stays within its own group,
so the next bot or batch takes its place. `BookGrid` measures the navigation and open batch
headers with `ResizeObserver` to keep these offsets aligned when their heights change;
CSS handles scrolling, including the desktop grid's horizontal alignment.
Collapsing a batch preserves its heading's viewport position before the next paint, so a
sticky heading stays where it was clicked. If the shorter page cannot reach that position,
scrolling stops at the nearest page edge; horizontal scrolling is preserved.

### The budget line

Both the batch heading and the bot heading carry the **buy budget of the chains under them** —
`· budget 118.250,00 (98,54%) · 116.430,50 (97,03%) · 120.000,00`, from `domain/budget.ts`. It sits
beside what the heading already says about the group, joined to it by the same middle dot, before the rule that closes the bot line,
rather than pinned to the far right: it is read in the same pass as the batch's date or the bot's
account, not hunted for at the other end of a 1440px row. Read left to right: what the shares actually acquired committed at the price
their order asked for, what those shares really cost, and the whole order at that same asked
price. The first two carry their share of the third, which is the only comparison the line is
for. It is computed from the chains **actually drawn**, so every filter and every scope toggle
decides what it counts.

- A resting **market** buy reserves 10% extra budget per share, so the first and third figures
  carry `× 1.1` where the buy was a market buy (`../MatriksOrder/API.md` — "Budget and limits").
  The second never does: once a buy fills there is nothing left to estimate.
- ⚠️ **An unknown order type is read as a market buy.** Neither `Positions` nor `ClosedTrades`
  stores the opening buy's `type`, so once a buy fills and its ActiveOrders row is gone, nothing
  left says how it was priced — only a buy whose own active or canceled row still states `limit`
  escapes the buffer. Reserving the 10% is the reading that cannot understate what the bot
  committed. **If MatriksOrder ever carries the buy's `type` onto those two tables, read it in
  `buyBudgetBuffer` instead of assuming.**
- A chain contributes **one** budget however many attempts it took. An automatic `Retry` keeps the
  chain's id and restates the same intent; it does not ask for a second budget. The attempt that
  filled is the one a Positions row names in `clientOrderId`; without one, the newest buy the
  chain owns is the live intent, since every earlier attempt is already dead.
- The acquired shares are taken from wherever they ended up: a position holds what is left of the
  opening buy and each round trip holds a slice already sold, so the two compose back into
  everything that buy ever filled. An active buy's own `filledQuantity` is only read when neither
  exists — while a position stands for the same order, counting both would buy the shares twice.
- Whether the position is open or closed changes nothing. Only a buy that **cannot be priced** —
  no `orderPrice`, or a scheduled buy not yet sized — does, and then the whole line reads
  `budget not available` in amber rather than a total that silently drops a chain, the same
  all-or-nothing rule unrealized P&L follows.

The grid reads in **four bands**, split by a hairline: what the order asked for and what it got
(`symbol` through `fill`), the two views of P&L (`p&l`, `today`), the clocks (`created` through
`final`), and the verdict (`status`, `act`). Each hairline is a **column of its own** —
`.book-divider`, one 1px rule in a 5px column — and not a border on the cell beside it, because
the row centers its cells and a border would stand only as tall as that one cell's text. Standing
the full height of a row instead, consecutive rows draw one unbroken rule that breaks exactly
where the chains, the scope headings and the batches already break, so the split follows the
grouping on the page rather than cutting a second grid across it. The dividers are
`aria-hidden`, like the status spine: a reader crossing one would only hear an empty cell between
two it does need, so the grid still exposes seventeen column headers. Every BIST ticker is five
letters, so `--book-symbol-col` is sized for one and no wider; what that frees goes to `status`,
which is the grid's only flexible track — `minmax(0, 1fr)`, so a long status wraps inside its
cell rather than widening the column past the header band and pushing the two grids out of step.

Row vocabulary follows the visual reference: an opener carries its symbol alone and a leg carries
nothing in that column — the opener above already said the symbol and the hairline says where the
chain ends, so a leg only speaks its symbol to a screen reader. A **sell row leaves the qty column
empty** when its size is the buy's whole size — an `auto` sell, or one whose quantity equals the
chain's opening buy; only a partial sell writes a number there. **No id is printed in the grid.**
Both the chain id and every order's client-order id are read in the chain dialog, opened from the
symbol, and there they are given in full rather than abbreviated to a tail. The
**The two reference-price columns are a faint gloss and the fill is not**: `@created/slip` is
`orderPrice` (the setting the row was created with, a market order's captured price still in
italic) and `@sent/slip` is `marketPrice` (the tape the order was decided against), while `fill`
is the figure the `p&l` beside it is read off — so the fill column keeps the row's ink and weight
and both reference columns step back to muted ink held at `opacity: 0.25`. Each reference column
carries **its own slip** beside the price, in parentheses at the kicker size — well under the row,
so it annotates the price rather than competing with it:
`@created/slip` shows `(averagePrice − orderPrice) / orderPrice` (empty for a market order, whose
captured price was never sent) and `@sent/slip` shows `(averagePrice − marketPrice) / marketPrice`
— **drawn for a market order too**, since that is the one slippage a market order really has. The
sign is the direction the price moved, never whether it helped; neither is ever inked. `marketPrice`
is an **observation**, not an intent and not a fill; it is written once at the order's birth and
never revised (an edit leaves it alone), and carried unchanged onto whatever the order becomes,
which is why a position and a closed leg show one too — a round trip splits it per side
(`openMarketPrice`/`closeMarketPrice`). The `@sent/slip` cell stays **empty** wherever the server
had no price to stand behind: a scheduled row (nothing decided yet), a symbol its price producer
was down for or does not track, an order placed outside this server, and every row written before
the field existed. Nothing older is substituted for it. The
status cell states its qualifier **inline** in muted ink after a middle dot — `New · resting 22m
· 40 of 150 filled`, `Position · held 3d 2h`, `By user · canceled in the MatriksIQ terminal`.
Where the server named an `origin` — `Retry`, `TakeProfit`, `StopLoss`, `User`, `External` — that
leads the **whole cell**, muted, ahead of the verdict word itself (`Retry · count: 0 · Filled`,
`TakeProfit · limit: ceilingAtClosingDay · New`), in the same `key · pairs` shape a reason takes;
`RowVerdict` draws it as its own field, not the first qualifier clause, and the ordinary bot order
names none so its cell opens on the verdict. (The chain dialog's leg rows keep the verdict in a
fixed narrow column, so there the origin leads the note line beside it instead — same order,
different row.) After the verdict come the qualifiers: on a canceled
row the server's own `reason` and then the verbatim wire `explanation` — every part that is
stored, joined by middle dots. The
`x of y filled` clause is drawn **only for a genuine partial fill** (some filled, not all): a
resting order with nothing filled says as much by resting, and a filled one is not waiting. A
resting time is read off `orderTime`, the exchange's own registration stamp, never off the final-seen
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

`BookFilters` owns the batch-range control, additive scopes, and the bot, account, symbol,
origin, canceled-status, source, and reason controls — the batch range leads the toolbar row, then
the scopes, then the popover triggers in that order. The
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

The **batch range** is `components/DateRangeFilter`, and Performance draws the same control, so a
range means the same set of sessions on both pages. The Book opens on **every loaded batch**, every
scope switched on — which is what the page is for. The batch heading collapse is what keeps that
quick across a year of them: only the newest batch is drawn expanded and the rest wait behind
their chevron. That newest batch is `sessionBatchDate` of the moment, not today's date: on a
Saturday it is Monday's session, because Friday's orders written past the close are already filed
under it. A scheduled order is filed further out still, under the session it is aimed at; it is
inside the default range but not the batch that opens itself. The control also waits for every read
to land before settling, since the nine of them return independently and the default is taken
once. The canceled toggle starts where switching the never-opened scope on would put it, because
that scope draws nothing but canceled legs and would otherwise open on a row of collapsed stubs.

Because the range is always set, the `filtered` row carries a chip for it only where it is
narrower than the loaded batches, and that chip names the days it kept. Anything that means to
widen the range — that chip, the empty-Book reason, the needs-a-human toggle that clears the
rest — states the widest range outright rather than unsetting it; that is the same set the control
settles on by default, named rather than left null.

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
why — why one ended (`BuyGuard`, `Expired`) on a canceled leg, why a cancel is in flight for a live
order, and why an exit sale exists (`TakeProfit`, `StopLoss`) on a live order or the sell that
closed a round trip. The last is read off `origin`, which is where the server moved that answer;
an automatic retry also rides in on `origin` but is **printed, not filtered** — the Book leads the
status cell with its origin key, it does not tick it. `reason` is never prose, so it is ticked and printed verbatim,
exactly as it arrives; a position row is given none, because nothing states why a holding exists
beyond the buy that opened it. Unlike the status filter
above it reads **every** row, not only the canceled ones: a chain qualifies where any of its rows —
live, scheduled, canceled, or the sell that closed a trade — carries a ticked reason, and is then
drawn whole. Its list is built from the whole loaded book, never follows the other filters, and each
option counts the chains it would keep rather than the rows. It carries the same off switch and for
the same reason: a chain the server recorded nothing about cannot match, so switching it on narrows
the Book even with every reason ticked, and a queued basket — which owns no order yet — drops with
it. Off pins the selection back to every reason. Where no loaded row carries one, the control is not
drawn.

Every row that carries a reason **prints it**, in the status cell's own qualifier line, after the
verdict word: on a canceled leg the server's own `reason` leads that line in body ink, before the
verbatim wire `explanation`. A cancel in flight names who asked and then why. An exit sale's
target is the row's `origin` rather than a `reason`, so it prints where every origin does — muted
and ahead of the verdict word — on a live or scheduled order and on the closed round trip's
`Filled` leg, never on the `Closed` one, which carries the hold instead. The filter ticks
whichever word the row shows. `reasonData` (and `originData`) — the data behind the key, for the
keys that carry any — hangs off it on the same middle dot, `BuyGuard · upperLimit: 119.34`, with a
colon joining a key to its value and a comma between pairs, since the dots are already spent. Key
**and value both print exactly as the server sent them** — the number is not run through the
page's Turkish figure form, because these are raw server fields (a retry `count`, a default's name
like `lowerLimit: floor`), not figures the page owns. A value of a shape the contract does not
describe is left out rather than guessed at.

**`source` sits beside the status, not in that line at all** — `By user by User`, joined with "by"
and drawn in the status's own hue by `RowVerdict`, because who ended an order is the
other half of the verdict rather than a qualifier of it. Only a stored death names one: nothing says
who is behind a live order, and a row without one simply shows its status. The contract calls the
field `source`; on a Book row that name is already the row's origin table, so the row carries it as
`statusSource`. A cancel still in flight is a separate question — the order has not ended — so it
keeps its own muted `asked by the server` clause and is not folded in here.

The **source filter** is the reason filter's twin over that field: `Broker`, `Bot`, `Server`,
`User`, `External`, ticked in the server's own key form, counting the chains each would keep, off by
default behind the same switch, and not drawn at all where no loaded row names a hand.

The **origin filter**, to its left, is the same control over `origin` — where the order _came from_,
the question `source` (who _ended_ it) is not. `reason` above already borrows an exit sale's target
(`TakeProfit`, `StopLoss`) off this field; the origin filter ticks the whole set the server writes —
`User` for a person at this interface, `External` for one placed in a brokerage terminal, `Retry`
for one the server stood back up, and those two exit-sale keys — while the ordinary bot order, which
names no origin, is not listed. It reads every row, canceled or live, a chain qualifying where any
of its rows names a ticked origin and then drawn whole. Built from the whole loaded book, never
following the other filters, counting chains not rows, off by default behind the same switch — a
chain built only of ordinary bot orders drops out even with every origin ticked — and not drawn
where no loaded row names one.

That line carries **three inks, loudest first** (`BookRowDetailTone`, drawn by `RowDetail` for both
the grid and the chain dialog). What the server decided — the reason and its numbers — is a fact of
the row and stays in body ink. What this page worked out about the row — `resting 22m`, `no exchange
id`, who asked for a cancel — is muted. Matriks' own words, quoted verbatim in
`explanation`, ride behind at the same half strength as the seconds on a time cell, so a reason is
never read past to reach an explanation. The `origin` key the order came in on is muted too, but it
is drawn by `RowVerdict` ahead of the verdict word rather than in this line — the server's word,
but a source and not a verdict.
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
