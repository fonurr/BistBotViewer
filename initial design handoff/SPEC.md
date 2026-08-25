# BotViewer — build spec

A viewer UI for trading bots running on **MatriksOrder**. One human watches several bots
trade real money on BIST and has to be able to answer, in seconds: what is about to happen,
what is already held, what died, and what needs me.

**Authority order.** Where these disagree, the higher one wins:

1. This spec, `SCREEN-MAP.md`, `TOKENS.md` (the agreed design).
2. `MatriksOrder/API.md` and `DailyDataAggregator/API.md` (the reality — field names,
   semantics and error types are never overridden by design intent).
3. The original requirement notes, in `uploads/` (`comtemplation of pages.md`,
   `contemplation of rules, components and technicals.md`, `main rules.md`). The rest of
   `uploads/` is screenshots from the design conversation and carries no authority.

`BotViewer.dc.html` is the **visual reference**: real values, real states, every screen and
dialog. Open it and inspect it. It is a design artifact, not a source of code — do not port
its markup. Where it conflicts with this spec, this spec wins (known cases are listed under
[Corrections](#corrections-to-the-visual-reference)).

Never modify anything in `MatriksOrder/` or `DailyDataAggregator/`.

---

## 1. Stack and structure

- React + TypeScript, single-page app, **dark only** (no theme toggle — see `TOKENS.md`).
- Everything in English: code, UI, comments.
- One folder/module per page. `pages/*` may import from `components/*`; **`components/*` may
  never import from `pages/*`**.
- **`bistApi/`** is the only place that may talk to MatriksOrder. No fetch to it anywhere else.
- **`priceApi/`** is the only place that may talk to DailyDataAggregator. Same rule.
- A README in each page module, in `components/`, in each API boundary, and at the top level.
  `AGENTS.md` at the root is the entry point.
- Central **non-persistent** store. Lazy load: fetch what the active page needs; do not
  refetch on navigation if the data is already held.

### Refresh
- Live channel is the SSE stream (`GET /api/events`). `write` events are a **global
  broadcast — filter by `botId`** before applying.
- Manual refresh exists. While refreshing: the refresh icon spins, the "last updated" label
  reads `Loading…`, both are disabled and dimmed. **Scroll position is preserved** across the
  update — the user must not lose their place.
- `refreshFinished` with an unchanged `lastUpdateTime` means the refresh **failed**; the
  server retries by itself. Do not report success.
- Poll prices at most once a minute, and only while something is open (a position, or a
  partially filled order).

---

## 2. Vocabulary (fixed — use these words in code and UI)

| Term | Means |
|---|---|
| **Chain** | The whole life of one position, grouped by `chainId`. Opening buy, its retries, the position, the sells that close it, the round trip, the canceled legs. One grouping, no matching on symbol or time. |
| **Waiting order** | Anything that can still execute: an order live at the exchange (`PendingNew`, `New`, `PartiallyFilled`), a `Scheduled` row the server holds, or a pending request. |
| **Position** | Bought, not yet fully sold. |
| **Trade** | Closed round trip (`ClosedTrades`). |
| **Batch** | Chains whose **opening** day is the same. Closing day is irrelevant. |
| **Pending request** | A `SendOrders` body the server took over and has not replayed. **Not an order** — nothing is sized, nothing is sent. |
| **Complete bot** | `algoritmId`, `accountId`, `brokerageId`, `emails` all set. `GetBots` returns a computed `complete` boolean — use it, don't recompute. |

**Group on `chainId`, identify on `clientOrderId`.** With retries the chain root is a dead
attempt, and a Positions row's `clientOrderId` is the attempt that actually filled.
`EditOrders`/`CancelOrders` take `orderIds`, and an `orderId` **is** a `clientOrderId`.

### Status vocabulary

The stored values, and the only words the UI may put in a status cell. Invented statuses are a
bug: there is no `Active` and no `ScheduledBatch`. `Expired` and `Filled` are **not** inventions —
both are in `API.md`'s status list, and both are in the table below.

| Stored | Display | Means |
|---|---|---|
| `PendingNew`, `New` | `New` | Sent, and still whole. Without a `matriksOrderId` it is **not editable until a refresh confirms it**; with one it is resting and acknowledged at the exchange (`TOKENS.md` inks those two differently — wait, then live). The display word is `New` in both cases, and **never `Active`**. |
| `PartiallyFilled` | `Partly filled` | Some quantity done, the rest resting. |
| `Filled` | `Filled` | Done in full. A leg word — the chain's own row carries the round trip. |
| `Scheduled` | `Scheduled` | Held by this server, nothing on the wire. Always editable, including its fire time. |
| `Unconfirmed` | `Unconfirmed` | A **verdict**, not a fresh order: it appeared in no list across ≥2 refreshes after the next work day's 09:10. We will never know whether it reached the exchange. |
| `CanceledByBot` | `By bot` | A bot asked for the cancel. |
| `CanceledByUser` | `By user` | Canceled in the MatriksIQ terminal — from outside this app. |
| `CanceledByServer` | `By server` | The server tore it down itself (a cascade, or a buy remainder given up so a due sell could close the fills). |
| `Canceled` | `Canceled` | Nobody asked: Matriks or the brokerage ended it. |
| `Expired` | `Expired` | It lapsed. Arrives in the canceled list alongside the cancellations. |
| `Rejected` | `Rejected` | The exchange refused it. |
| `Skipped` | `Skipped` | Its own guard refused it at fire: the symbol is already held, or there is no position to sell. Never retried. |
| `SkippedForNow` | `SkippedForNow` | The bot was missing, half-configured or deactivated at fire. **Retried** — the guard may pass later. |

A **pending request** has no status at all. Render it as queued, never as an order.
`cancelSource` (`bot`/`user`/`server`) on a live row means **a cancel is in flight for it** —
see §5.

**Four words in the status column are not statuses, and are allowed.** A Positions row reads
`Position`, a ClosedTrades row reads `Closed`, a pending request reads `Queued`, and a result
panel's accepted-but-unconfirmed cancel reads `Accepted` (§4). Those rows have no order status to
print — the word names what kind of row it is. Everything else in a status cell is a value from
the table above, in its **display** form: the Book prints `By user`, not `CanceledByUser`.

### Retries — who gets a second chance

The server retries; the UI only reports. `retryCount` counts consecutive failures on the chain
and **resets to 0 as soon as Matriks accepts an order**, so it is not a lifetime total. At most
three attempts.

- A **sell the exchange canceled during the session** is put back at once: one asked for as
  `market` returns as a **limit at the last traded price**; one
  asked for as `limit` is scheduled for **19:00** (`whenType: "AfterHours"`). Neither counts
  against the limit.
- **Rejected** orders, `SkippedForNow`, expired sells, sells canceled outside the session and
  `Unconfirmed` sells become scheduled retries (`whenType: "Retry"`).
- **A buy that was canceled, expired or never answered is never retried.** So a chain shows
  several buys only when a *scheduled* buy was skipped `SkippedForNow` and re-armed. If you
  find yourself drawing a retried buy after an exchange death, the data does not say that.
- A retried buy takes its reversing sells with it; `parentClientOrderId` is re-pointed.

**`null` link means unknown, never "no chain".** Render an unlinked order as itself. Never
infer a link the server declined to state.

---

## 3. Screens

Three top-level pages, flat nav, no breadcrumbs: **Bots**, **The Book**, **Performance**,
plus a **Logs** drawer that opens over any of them. `SCREEN-MAP.md` has the per-screen
endpoint and state matrix.

Why this differs from the original page list (Main / Bot Details / Closed Trades / Canceled
Buy Orders / Performance / Errors): that split scattered one question across four pages.
A position, the orders waiting to close it, and the canceled attempts before it are *the same
chain at different moments* — so they live in one place, behind scope toggles, and the pages
that existed only to show one slice are gone.

### The Book
The main surface. Every chain, four scope toggles: **Waiting · Positions · Trades · Canceled**.
Scopes are additive checkboxes, not tabs; none selected is a real state with a real message.

- Every scope renders the **same chain shape**: opener row on top, live legs beneath it,
  canceled legs collapsed into a red tail at the bottom of the chain.
- Canceled legs are hidden by default, revealed by one global toggle in the toolbar, with a
  per-chain override (`show` / `hide` on the red tail, which carries its own count).
  **The global toggle *is* the count** — the underlined line (`19 canceled orders hidden · 3
  shown by hand`) is itself the control, and it **states the count and nothing else**: no
  trailing "— show them". A line that is underlined, colored and clickable does not need to
  narrate its own click, and the instruction aged badly the moment the count grew. Dead ink
  while they are hidden, muted once they are shown. Toggle and per-chain overrides reconcile in
  that label: how many are hidden, how many a hand opened, how many chains a hand closed.
- **A canceled tail's note earns its place or it goes.** `none offers resend: each asks for 120
  and only 30 shares are unclaimed` is a fact the rows cannot show, so it stays. `its
  replacement filled — this chain is closed and holds nothing` and `3 canceled orders — every
  order this chain ever had` restate what the rows above already say, so they are gone. The tail
  keeps its count and its `hide`; prose only where the rows are silent.
- **The tail's own line states what the cancellation left behind, and it is condition-bound.**
  The warning — *"if this buy fills, nothing is set to close it"* — belongs only to a chain that
  **still has an active or scheduled buy** and, after the cancellation, **no active or scheduled
  sell** to close it. It must never appear on a closed chain: a chain that already bought and
  sold holds nothing, so its tail states the harmless fact instead (the replacement filled, the
  chain is closed and holds nothing). Same rule for a canceled chain that never opened a
  position — nothing is at risk, so nothing is warned about.
- Grouping, in this order, only where possible: **date** (date header) → **bot** (accent
  vertical rule + bot label) → **batch** (batch rule). Skip a level when a sort makes it
  impossible rather than faking it.
- **No sorting.** The Book's order is the grouping above; there is no column sort and none is
  planned. Do not add one.
- **No paging and no truncation.** Every chain in scope renders at once — no "+N more chains"
  row, no progressive disclosure. The filters and the scope toggles are how the list is made
  smaller.
- **The column set, left to right:** symbol · qty · side / type · order · fill · slip · p&l ·
  ord time · ack time · status · act. Headers are single-line — `ord time` is abbreviated
  because `order time` wrapped at its column width, and a wrapped header pushes the whole row
  band taller for no gain. **An empty cell is empty**, not an em dash (`TOKENS.md`). **qty sits left of side / type** — how much is the
  question asked first, and the side word is inked, so it reads as the start of the sentence the
  price columns finish. Every leg of every chain uses this one grid, so a price
  stays in its column down the whole page.
  - **side** is inked: `buy` in `--side-buy`, `sell` in `--side-sell` (`TOKENS.md`). The type
    word beside it stays plain text — the side is the fact worth finding at a glance.
  - **slip** is a percentage, signed, and only where it is derivable: `(averagePrice −
    orderPrice) / orderPrice`. **The sign is the direction the price moved, not whether it
    helped** — a buy filled above its order price is **positive**, a sell filled below its order
    price is **negative**, and both signs occur on both sides. Never flip it per side to mean
    "adverse", and never ink it green or red: whether a move helped depends on the side, so the
    cell stays `--color-text` and the reader supplies the judgement. A `null` order price
    (priceless market sell, manual close) shows nothing, never a zero. **A price captured at the
    API call but never sent is not an order price** — it does not produce a slip figure either.
    The strip's *avg slip* is the same figure averaged over the filtered set, so it mixes
    directions and stays near zero; on Performance it is split entry/exit × limit/market, which
    is where the number means something.
  - **order** is `orderPrice`. A market order may still carry a price captured **at the moment
    of the API call** — preserved in the record, never sent to Matriks. Show it in **italic
    muted** ink, the same treatment as an `auto` quantity (`TOKENS.md`), so it reads as a fact
    the record kept rather than an instruction the exchange saw. No captured price means `—`.
  - **p&l** carries the absolute figure with **its percentage in parentheses** beside it, in the
    same ink and a smaller size — realized for a closed chain, unrealized for a held position,
    and nothing at all for a row that has not traded. The percentage is against that chain's own
    cost basis, never against the portfolio.
  - **Both time columns show the clock only when the day is the row's own batch date** — the
    batch heading above already states it, so `15.08 09:41` inside the 15.08 batch reads
    `09:41`. A leg stamped on a later day keeps its date (`17.08 14:31`), which is then the
    fact worth seeing. Never repeat a time in the status cell that a column already carries.
  - **A scheduled row shows the time it is set to fire** in the *order time* column, in the
    scheduled amber (`--st-wait`), not `—`: the row has no exchange stamp yet, and when it goes
    is the only time that matters about it. The status cell then says `Scheduled · in 2h 14m`
    and stops there — **the fire-time spec (`BeforeClose −30m`) is not repeated on order rows**,
    on that one or any other; it belongs to the bot record and to the edit form.
  - **order time** is `orderTime` (`openOrderTime` / `closeOrderTime` on a ClosedTrades row —
    take the one that matches the leg's side). It is the **exchange's** clock: when the order was
    registered there. It stays `null` until a refresh confirms the order, and also whenever the
    wire's `TradeDate` falls outside ±2 days of the server date — render `—`, never a
    substitute.
  - **ack time** is `executeTime` (`openExecuteTime` / `closeExecuteTime`) for a fill and
    `cancelTime` for a death — whichever the row has; both are stamped when **this server
    learned** of it, not when it happened at the exchange. The column is called *ack* for that
    reason: it is an upper bound, and the lag is unbounded (a fill broadcast pulls the next pass
    5s out, but a silent terminal can leave it to the routine 15-minute pass). Never derive
    time-to-fill, latency, an intraday bar or a fill-time market price from it, and never label
    it "filled at".
- **Bot names carry the bot's description as a tooltip** — the `description` field from
  `GetBots`, verbatim, on the bot label in the Book's grouping rule and on the Bots page. No
  truncation and no invented summary; a bot with no description gets no tooltip.
- Summary strip over the **filtered** set: visible chains/orders, realized, unrealized, total,
  committed, average slippage.
- Filters: scopes, multi-bot, multi-account, symbols, start/end **batch** date. **The default range is everything** —
  the Book opens unfiltered and narrowing it is the deliberate act, so any range but everything
  shows as a chip. Filters change the strip and the chain list. **Filters never touch the "needs a human" banner** — a position with no exit
  needs one whether its bot is in view or not. **The banner's counts are clickable**:
  `2 positions with no closing order` **is a toggle** — clicking it again clears the
  `no closing order` filter and leaves every other filter alone. On it resets the Book to `Waiting` +
  `Positions`, all bots, all accounts, no symbol, every batch, and then lists only the chains
  that are the problem: a held position with no active or scheduled sell, and a waiting buy whose
  exit is already canceled. It ignores the batch range deliberately (a position with nothing to
  close it does not stop mattering because its batch scrolled out of the window), shows as a
  `no closing order` chip like any other filter, and clears from that chip. Each chain in the
  list carries its own bot and batch date, because the set spans both.
  `1 account mismatch` opens a dialog showing the stored `GetErrors` row verbatim — `id`,
  `time`, `type`, `accountId`, `brokerageId`, `information`, `context` — and says plainly that
  the viewer cannot tell which account really holds the shares, so the terminal has to be
  checked before acting on the position.
- Pending requests are a group at the **top of Waiting** — they are baskets, not orders, and
  have no chain until they fire.

### Bots
One card per bot: identity (id, `algoritmId`, account, owner from `GetAccounts`), description,
counts, realized and unrealized P&L, and the actions. Card state colors follow `TOKENS.md`:
deactivated → dead, incomplete → wait, otherwise → live.

- Counts read `Buys: open/scheduled` and `Positions: open/openSells/scheduledSells`, colored
  per token (open = live, scheduled = wait, position count = fill).
- Toolbar: **Active** and **Inactive** are independent checkboxes, both selectable at once,
  Active on by default. There is no "All" option — both checked *is* all. The toolbar's account
  dropdown and bot search are static in the design; build them on the Book's popover pattern.
- **Lazy load without reflow**: the card reserves its final height and shows skeleton bars
  while counts and P&L arrive. Nothing below a card may jump as data lands.
- An **incomplete** bot says what that costs, in words: rejected from every order endpoint,
  scheduled orders skipped, until the missing fields are set.
- A **deactivated bot that still holds positions** must say the dangerous part: it cannot buy,
  it can still sell, and nobody is managing the exit.
- **Reactivate** is a plain confirmation, not a warning: it starts buying again from the next
  batch, its open positions are unaffected (it could always sell), and its limits and forbidden
  stocks are whatever they were. State the one non-obvious thing — scheduled buys skipped while
  it was off are not replayed; only rows the server still holds as `SkippedForNow` get another
  attempt. If the bot is still missing a field it comes back **incomplete** and buys nothing.

### Performance
Closed round trips only, and every figure is **gross** — there is no commission field in the
schema. That is said **once, in the subhead** (`closed round trips only, gross`) and explained
in the standing *what this page cannot say* card at the foot of the page. It does **not** get a
banner: a warning strip that never changes is furniture within a day, and it was pushing the
figures below the fold.
- **A bot card's `Performance` button opens this page scoped to that bot** — sitting between
  `Open book` and `Edit`, and offered on a deactivated bot too (its closed trades still exist).
  Scoped means *recomputed*, not highlighted: the subhead names the bot, the bots filter reads
  `1 bot` with a clearable chip beside it, and **every figure on the page is that bot's** —
  strip, curve (including its axis, which is re-scaled and may run negative), exit timing, retry
  ledger and slippage. The two **comparison tables — by bot and by symbol — disappear** while a
  single bot is selected: by bot exists to rank bots against each other, and by symbol reads
  across every name the fleet traded. Neither is worth reproducing for one bot in this reference,
  and a fleet table left standing under a bot's own header is a straight contradiction — trips
  and P&L that cannot belong to it. If either is later wanted per bot, it has to be recomputed,
  not relabelled.
- **bars.db has gaps, and the page says which figures they cost.** The counterfactuals — what the
  closing auction would have paid, what holding the name would have made — need a bar that may
  not exist: the producer only writes while the session runs, so a day it never ran has no bars
  at all, and an auction nobody traded can be missing for a single symbol. Those trades are
  **excluded and counted**, never treated as zero: the exit-timing card carries a third row in
  `--st-warn` (`6 · no closing auction bar in bars.db — not compared`) and states its net *over
  the 52 it could price*; the by-symbol table shows `no bars` in the held column, a hatched
  ratio bar, and the reason in the row. A total that quietly averaged the gaps in as neutral
  would be the one number on this page nobody could reproduce.

Daily performance in both **TL and percentage** (weighted averages for percentages, totals for
absolutes), realized over time as a line, winning/losing counts, budget context, hold
comparison against `bars.db`. Windows: today / week / range / all — static in the design; build
them as ordinary filters.

Never assert a holiday or a session count you have not read from `GetHolidays`. A date range
states the trading days it actually contains.

### Logs (drawer, not a page)
`GetErrors`, newest first, one row per line, all fields, resizable columns, sortable, filtered
by type and date range. Paging is `limit` + `beforeId` (the **last row's id**), repeating the
other filters unchanged on every call — never a time cursor.

The three tabs — Errors, Wire log, API log — each carry **their own day range**, remembered
separately, defaulting to **today → today**, and bounded by the first and last day that log
actually holds (retention differs per log, so the bounds do too). Paging works **inside** that
range and never widens it. `SCREEN-MAP.md` has the full rule.

`OrderAccountMismatch` is the one error that always needs a person: an order this server sent
has started appearing under a *different* account, and nothing reconciles while that is true.
Surface it on the Book's banner, not only in the drawer.

---

## 4. Write paths

Every write follows the same steps, in the chain dialog: **view → (form | confirm) → sending →
result**. A write that needs values from the user gets a **form** step (editing an order,
selling by hand); a write that only needs assent gets a **confirm** step (any cancel).

1. **View** — the chain, its legs, and what each one is. Actions sit on the legs they affect.
2. **Form** — every field the API allows for that call, with the arithmetic that bounds it
   stated underneath in words. The primary button is blocked, with the reason in place, while
   any field is invalid; nothing is validated only on submit.
   **Confirm** — one step. It itemizes the calls **in the order they will be made**, in words,
   with the numbers that matter. Destructive actions never fire on the first click, and never
   ask the user to retype anything either.
3. **Sending** — while the server has not answered: the affected row is shown **at its previous
   value, dimmed and untouchable**, and directly beneath it a new row with a spinner naming the
   action and the call being made. Nothing is drawn optimistically — no row ever shows a state
   the server has not confirmed.
4. **Result** — a panel **inside the dialog, before it closes**, one row per item with its own
   outcome. Never a bare success toast: these calls are per-item and one item can fail alone.
   Three faces, and all three must exist:
   - **Succeeded** — the new state, and the changed rows **flash once** in the Book behind the
     dialog so the user can see what moved.
   - **Refused** — back to exactly the previous state, with the reason, and "nothing reached the
     exchange" when that is true. When an action that makes several calls failed halfway, say
     which call landed and what that leaves — cancelling a chain whose first cancel landed and
     whose second was refused leaves the position with one exit fewer than the user asked for,
     and the panel must say which one survived.
   - **No answer** — the honest unknown. The request went out, nothing came back, and whether
     the exchange has it cannot be known. Do not re-send (a second cancel is harmless, a second
     order is not); the next refresh decides it, and the row stays marked until then.

   Outside the dialog — a row-level action taken straight from the Book — the same three
   outcomes appear as a toast; a refusal or an unknown is dismissible only by the user.

**Dialog navigation is flat.** Every step's secondary button is **Close**, which dismisses the
dialog outright; there is no Back and no step-to-step history. A form or confirm reached from a
row action is a destination, not a detour — leaving it means leaving the dialog. The result step
carries a single **Done**.

Rules that come from the API and are not negotiable:

- `CancelOrders` answers **empty**. The refresh that follows is what confirms it — say so
  rather than claiming success the reply did not contain.
- `CancelPendingOrderRequests` answers **per id**: `canceled` | `gone` | `wrongBot`. Render
  `gone` as its own outcome. `canceled` is exact — a request reported canceled never reached
  the exchange. `gone` cannot distinguish "already fired" from "never existed"; if the row was
  on screen a moment ago, it fired, and its orders are now in `GetActiveOrders` under their own
  ids. Say that.
- **Selling by hand** (the row action reads `sell`, and so does the dialog's primary): this is
  the sell side of `SendOrders` for **one stock**, one call, and it is offered **only while
  there is something left to sell**. Sellable = position quantity − Σ(active sell quantity) −
  Σ(scheduled sell quantity), where a **scheduled sell with no quantity claims the whole
  position** and takes sellable to 0. **A sell with a cancel in flight is still an active sell
  and still subtracts** — shares come back only when the cancel is *confirmed*, never when it is
  asked, so a cancel does not raise this count and the number must not move optimistically.
  **When the closing orders already account for the whole
  position — Σ(active + scheduled sells) = position quantity — sellable is 0 and the action is
  absent.** At 0 the action is not shown at all — the chain view says
  what claims the shares and that editing one of those orders is how you free some. The form
  carries `type` (limit | market), `price` (mandatory for a limit sell; optional for a market
  sell, which then stores `orderPrice: null` and yields no slippage later), `quantity`
  (defaulted to sellable, and blocked above it), and a
  **send now / schedule it** choice — scheduling adds the `closeTime` spec `{day, type, diff?}`.
  The four request-level `budget*` caps are buy-only: never send them on a sell, and say once
  that a sell is bounded by the position instead. Several sells are allowed within that
  arithmetic.
- Trades and canceled orders are **not editable**. Active and scheduled orders are editable
  as far as the API allows, and cancelable. **Every field `EditOrders` accepts is in the form** —
  the row action is called `edit`, never "resize": for an **active** order that is `price`,
  `quantity` and `type` (limit ↔ market); a **scheduled** order adds its fire
  time (`{day, type, diff?}`) and, on a scheduled **buy**, `cancelAtFloor`. `direction` and
  `symbol` must match the stored order, so they are context in the form's header, not fields.
  One call carries the lot; a determined quantity of 0 fails the whole request (an edit has no
  partial skips).
- **An edit is judged with the order excluded from its own limit.** A sell may grow up to the
  position minus what the *other* sells claim; a buy is bounded by the bot's limits, not by a
  position, with its own committed amount excluded. State the resulting ceiling in the form.
- A sell above the held quantity is rejected by the router before it reaches the exchange —
  block it in the form and say why.
- **An order the exchange has not acknowledged cannot be edited** (no `matriksOrderId` yet).
  Offer no edit affordance on it; say it becomes editable after the next refresh. Scheduled
  rows have no exchange side and are always editable.
- **Rescheduling** a scheduled order is a `time` object `{day, type, diff?}` **inside the stock
  entry** — not `openTime`/`closeTime`, not at the top level; other placements are rejected.
  Only valid on a scheduled orderId, must resolve in the future, and may not put a reversing
  sell at or before its opening buy.
- **`timeInForce` is not in this app.** It is optional in the API, no bot varies it, and a
  control nobody moves is a control that gets moved by accident. **No form offers it and no
  request sends it** — SendOrders defaults it to Day server-side, and an omitted `timeInForce`
  on an edit keeps whatever the order was stored with. Do not surface it in a read-only stored
  spec either (the resend panel shows quantity, price and fire time, and stops).
- Omitting `quantity` on a scheduled sell means **sell whatever the position holds at fire**.
  That is the "unbounded" sell the close flow warns about; an explicit quantity is validated
  against projected availability.
- **Canceling a scheduled buy also cancels its linked reversing sell.** Say so in the
  confirmation — the user is ending two rows, one of which they never see as theirs.
- A canceled **active** order only appears in `GetCanceledOrders` **after the next refresh**; a
  canceled **scheduled** order moves there immediately. The result panel must not claim the
  first has landed.
- A **market buy reserves 10% extra** per share (`price × 1.1`) while it rests, so committed
  money is not `quantity × price` for market buys.
- "Committed" is **derived**, not a field: `limit − remainingBotBudget` from `GetBotBudget`,
  which is **single-bot only** — ask for it per bot, when you need it.
- The table reads refuse an **empty `botId` array**. When the bot filter selects nothing, render
  the empty state; never call with `[]`.

### Deactivating a bot — the most dangerous control in the app
`active: false` **deletes** a bot with no ClosedTrades / ActiveOrders / ScheduledOrders /
Positions rows (its CanceledOrders rows go with it); otherwise it **deactivates**. One field,
two outcomes.

So there is no checkbox. The control reads the bot's state first, and the confirmation says
which of the two it is about to do, in words, with the row counts that decide it. Delete says
there is no undo and that the name becomes free again. Deactivate says the bot can still sell
and that its open positions now belong to a human.

### Resending a canceled order
A canceled order can be sent again. The row action reads **`resend`** and it is offered on the
canceled leg itself, never on the chain.

**When the action exists at all.** A resend is a fresh `SendOrders`, so it is bounded by whatever
bounds a new order of that side:

- A canceled **sell** is resendable only while the position can still cover it:
  `sellable = position quantity − Σ(active sell quantity) − Σ(scheduled sell quantity)`, the same
  arithmetic as selling by hand, with a quantity-less scheduled sell claiming the whole position
  and a sell with a cancel in flight still claiming its own.
  **If the canceled sell's quantity exceeds sellable, the action is not rendered** — not disabled,
  not greyed: absent, because there is no quantity at which that stored order can go out again.
  The chain's canceled tail says why in one line (*"none offers resend: each asks for 120 and only
  30 shares are unclaimed"*), so the absence is explained where it happens.
- A canceled **buy** is bounded by the bot's budget rather than a position, so the action is
  offered and the *form* is where the arithmetic bites: the resend is blocked, with the figure in
  place, when `quantity × price` (`× 1,1` for a market buy) exceeds `remainingBotBudget`, or
  when it exceeds the effective per-position cap.
- Never on a **trade**, and never on a canceled leg whose chain is mid-write.

**The form.** Two modes on one segmented control:

- **Resend as it was** — the stored spec, shown read-only above the control: quantity, price,
  its fire time, and whether it carried a reversing sell. Nothing to fill in.
- **Change it first** — `type`, price, quantity, a **send now / schedule it**
  choice with the `{day, type, diff?}` spec, and — for a buy — a checkbox for the linked
  reversing sell (`closeTime`). An empty quantity on a buy is legal and means *sized from the
  budget at send*; say so rather than blocking it.

**Two rules the copy must carry, both of them consequences of the API:**

1. **A past fire time cannot be resent verbatim.** Every computed time must be in the future, so
   *as it was* means the same spec **re-armed for today**. State the resolved day and time.
2. **A resend is a new order, not a continuation.** It is minted with its own `clientOrderId`,
   and `SendOrders` has no field that says *this replaces …600065* — so it opens a **new chain**
   and the canceled one stays closed. Never draw the resend inside the old chain, and never imply
   the old order came back to life. **Two chains is the answer, not a gap.** The linkage was
   considered and dropped: no server field is being waited on, so do not tie the two chains
   visually, do not draw an edge between them, and do not word the copy as if something is
   missing. The canceled leg says it was resent; the new chain stands on its own.

The reversing sell, when kept, is created by the router as part of the same call — one item in the
confirm step, marked as the router's, with the note that it is erased on its own if the buy ends
canceled without opening a position.

**What a cancel's result step may claim.** `CancelOrders` answers empty, so the result step says
the cancel was *accepted*, never that the order is gone. **The item's own word is `Accepted`, in
`--st-wait`** — a fifth face beside landed / refused / unknown / `Not sent`, because green is
reserved for what the reply confirmed (`TOKENS.md` rules 1 and 6). The row it came from goes
straight into cancel-in-flight (§5) and stays there until a refresh confirms it — so the result
must not announce freed shares, a closed chain, or a new sellable count, and must not promise a
flash on rows that have not moved. The one thing it may state is what the row is now waiting for.
A **scheduled** row is the exception: it was never on the wire, so its cancel is `Removed`,
confirmed, and green.

### Firing a scheduled order early
A scheduled row carries **`fire now`** beside `edit` and `cancel`. There is no send-now endpoint
and none is being asked for: **`fire now` is a cancel followed by a fresh order.** `CancelOrders`
on the scheduled row, and — only if that is confirmed — `SendOrders` for the same symbol, side,
type, price and quantity, sent immediately. The fire time is the one thing that does not carry
over, which is the whole point of the control.

- **Ink, not a box:** `--st-warn` ghost at weight 500 (`TOKENS.md`) — the loudest a row action
  gets, because replacing a decided fire time with a human's is the kind of act that should be
  hard to miss and impossible to hit by accident.
- It gets a **confirm** step, never a form: there is nothing to fill in. The confirm **itemizes
  both calls in the order they will be made** (§4), states how early it goes, and states that
  quantity and price resolve **now** rather than at the scheduled instant.
- **The second call is conditional on the first.** A refused cancel means nothing moved and the
  scheduled time still stands — say exactly that, and do not send. Only a confirmed cancel
  releases the send. That result lists the send as **`Not sent`** in muted ink, never as a
  failure: it was never attempted.
- **The halfway failure is real, accepted, and never hidden.** The cancel can land and the send
  can then be refused — session closed, budget, a guard, a price band. The scheduled order is then
  gone and nothing replaced it. The result panel says which call landed, that the scheduled row is
  not coming back, and what the chain is left holding; a position that loses its only exit this
  way appears under *needs a human* like any other. This is an accepted cost of the control, not a
  bug to design around.
- **The new order is a new order.** Its own `clientOrderId`, its own chain, drawn as its own chain
  — the same rule as a resend. The scheduled row ends as an ordinary cancellation and sits in the
  canceled tail, where its note says it was refired by hand.
- Do not fake *now* by rescheduling to a near-future `BeforeClose`: that lies in the record, races
  the dispatcher, and cannot express *now*.
- Offered only on `Scheduled` rows, and never while the SSE stream is down.

---

## 5. Unknown, degraded and stale

The rule the whole design rests on: **a state we cannot confirm is never green.**

- An order we sent but cannot confirm (`Unconfirmed`, no exchange id yet) is `--st-wait`, and
  the row says what is unknown about it.
- A write whose outcome we do not know — timeout, no reply, an envelope we cannot read — is
  `--st-warn`, is never reported as done, and tells the user the one useful thing: whether it
  may have reached the exchange.
- **SSE down**: everything on screen is the last snapshot, timestamped and frozen. Say so, and
  hold write actions while the stream is out — a cancel sent now lands against a book nobody
  can see, and its reply arrives with nothing to reconcile against.
- **One freshness indicator in the header, never two.** A single line carries the refresh state
  — `updated 2 min ago` (live), `prices 12 min old` (stale), `stream down · reconnecting`
  (down) — and the feed condition is said *by that line*, not by a second badge beside it. The
  "last known" labelling on the P&L cells (below) does the rest. A separate "price feed off"
  chip repeated the age line and is cut.
- **Prices** (DailyDataAggregator): `feed != "live"` → **trust no price**. Unrealized P&L is
  not rendered as a number; show last known, labelled, in muted type. `feed == "live"` → `son`
  is the valid market price *whatever its age* — a four-hour `trade_age_ms` on an illiquid
  stock is normal. `trade_age_ms` is a **liquidity** signal, not a freshness one: never render
  it as "stale". Any age field `null` means "don't know".
- The quote carries three ages and they are not interchangeable: `quote_age_ms` is **contact**
  age (Matriks pushes a price without a trade, so it always looks fresh — never show it as
  freshness), `price_change_age_ms` is when the value last moved, `trade_age_ms` is when a real
  trade last happened. Read `feed`, weigh `trade_age_ms`, use `son`.
- **A cancel in flight** (`cancelSource` set on a live row) is `--st-wait`: the order is still
  at the exchange and the cancel is not confirmed. It is the only single row in the table that
  carries a tint (`--st-wait-t`) and a second line, because it is the only row whose state will
  change on its own while you watch it (`TOKENS.md`, rule 4).
  - **The status cell names both facts, in order:** the live status it still has, then the cancel
    — `Partly filled · cancel in flight` (the **display** word, per §2), then muted, which side
    asked. Never replace the
    status with the cancel: the order has not stopped being live.
  - **Who asked, in words, not the field value:** `bot` → *asked by the bot*, `server` →
    *asked by the server*, `user` → *asked by a person, in the terminal* (it came from outside
    this app — see §2). The row it will become is the matching `CanceledBy…` status.
  - **Both actions are disabled, not absent** — the distinction matters and is deliberate: an
    absent action means *there is no version of this that could work* (a `sell` with nothing
    sellable, a `resend` the position cannot cover); a disabled one means *not until this
    resolves*. `edit` cannot go out against an order with a cancel pending, and `cancel` is
    already asked. Each carries its one-line reason.
  - **Never strike the row through and never grey it as dead.** It can still fill, and on a
    partial fill the second line says what the cancel can actually take: the resting remainder,
    not the whole order.
  - **The cancel we did not send is weaker evidence than the one we did.** A `user` cancel is
    attributed when it appears on the wire, so we know it was *asked*, not that it landed. Say
    that rather than implying we are tracking it.
- **A scheduled sell dated today can fire early**, on its own, when the stock closes a minute at
  the daily ceiling. Never present a scheduled time as a promise; it only ever moves earlier.
- **Holidays**: `type: "full"` is closed all day, `"half"` is the morning only and moves the
  close to 12:30 (the open does not move). An empty calendar means holidays are **unknown**,
  not that every day trades — so a window never asserts a session count it cannot support.
- `AccountFeedSilent` is the dangerous quiet failure: lists look healthy while fills and
  cancels happen unseen. It must interrupt, not sit in a log.
- Empty states divide in two. **A filter that emptied the view** and **no scope selected** carry
  the reason and a way out — a blank table there is a bug. **Genuinely no data** — first run
  with no bots, a bot whose book is empty today — shows **nothing in the content area**: no
  illustration, no invitation, no explanatory panel. The header and toolbar are enough.
- Slippage is not derivable where an order price is `null` (priceless market sells, manual
  closes). Show nothing there — never a zero.

### Keyboard and viewport

- **Esc** closes the topmost layer — a popover first, then a dialog. A dialog in its **sending**
  step does not close on Esc: the call is in flight and the outcome has to be read. Inside the
  symbols popover Esc clears a typed query before it closes the popover.
- The **symbols filter is a type-to-narrow list**: the popover opens focused on a free-text
  field, the list narrows as the user types (prefix matches first, then substring, all
  case-insensitive), and **Enter toggles the first match** — selecting it if it was off,
  deselecting it if it was on — while leaving the query in place so the next Enter is a
  deliberate second act. Mouse clicking any tag toggles it the same way. The first match carries
  an accent ring while a query is present so the Enter target is never a guess. No match says so
  and says why: the list only holds symbols the loaded batches traded.
- Focus moves into a dialog when it opens and returns to the trigger when it closes; Tab is
  trapped while it is open. `:focus-visible` is Nocturne's accent ring, never removed.
- No other keyboard shortcuts. Do not invent single-key accelerators anywhere near a write.
  Enter inside a filter field is not a write and is allowed.
- **Assume a wide viewport.** The Book's fixed column grid is built for a desktop trading
  screen; there is no narrow layout and none is planned. Below its natural width the page may
  scroll horizontally — do not reflow the grid into cards.

---

## 6. Copy rules

Half of this design is the words. They are part of the spec.

- Say what will happen, in the user's terms, with the number that decides it. "Sellable by hand:
  30 of 120 — the resting limit sell claims 60, the scheduled market sell 30."
- Name the consequence the user would not think of: budget returning, a position left with no
  exit, a freed bot name.
- Never dress a failure as a success, and never a partial as a whole.
- No exclamation marks, no reassurance, no apology. Lowercase kickers, sentence case
  elsewhere. Turkish number format (`38,16`, `9.315`), tabular figures, `dd.MM.yy` dates.
- Money always carries its sign and its currency context; percentages state what they are of.
  **Currency context is stated once per section, not once per figure** \u2014 a strip whose kickers are
  `realized` / `unrealized` / `committed` is in TL because the page is, and repeating `TL` on forty
  aligned figures costs the column its readability. Say the unit where it could be mistaken (a
  form field, a limit, a mixed table), and nowhere else.

### Failure modes to check, and the rules they produced

These are the ways this project's copy actually goes wrong. Each was found in the reference and
fixed; the rule is what stops it coming back.

- **A shared line that asserts a fact must be checked against every branch that shows it.** Two
  branches broke this. The `fire now` *Half done* result carried the standard *the rows behind this
  dialog never changed*, which is a lie when the cancel landed. A **cancel refused because the
  order filled a moment earlier** carried the same line, and the position had just grown. If a
  reassurance is shared, every branch has to earn it or override it.
- **"Nothing reached the exchange" is a claim, not a sign-off.** Say it only where the request
  never left, or left and was refused before the exchange saw it. An edit the exchange rejected on
  its price band *did* reach the exchange; a resend a local guard refused never left this server;
  a cancel of a scheduled row was never at the exchange at all. Four branches, four sentences.
- **A result may not name a state the reply did not carry.** `CancelOrders` answers empty, so a
  live order's outcome is `Accepted`, not `Canceled`, and not in green (\u00a74).
- **A promise about the interface behind the dialog is a fact about that interface.** *The changed
  rows flash once* may only be said when a row changed. An accepted cancel changes nothing yet, so
  it says what the row is waiting for instead.
- **Only the stored values from \u00a72, in their display form.** No `Active`, no raw
  `CanceledByUser`, no `PartiallyFilled` where `Partly filled` is the display word \u2014 and the four
  row-kind words in \u00a72 are the complete list of exceptions.
- **An error type is spelled the way the server spells it.** The log said `FeedSilent`; the type is
  `AccountFeedSilent`. A type name a developer cannot grep for is worse than no name.
- **A count is said once, by the control that owns it.** The by-hand override count belongs to the
  canceled toggle's label and nowhere else.
- **An instruction where a fact would do.** The canceled-legs count *is* the control and carries no
  *show them*. An empty log range states the nearest day that holds a row rather than telling the
  reader to widen the range \u2014 the fact is the same length and answers the next question too.
- **A green word on an unconfirmed state.** The rule the whole design rests on (\u00a75, `TOKENS.md`).
- **No sympathy for an outcome.** *This is the one outcome nobody likes* was editorial. The `no
  answer` panel states what happened, what is unknown, and what not to do. Sympathy is a species
  of apology.
- **The word `net` is reserved on Performance.** Every figure there is gross, so `net` as a label
  reads as net-of-commission however it was meant. The exit-timing and retry cards total their
  comparison under **`total`**; the only place `net` may appear is a sentence that says what it is
  net *of*.

---

## 7. The bot record

The one form behind Add / Edit / Finish setup. Fields are exactly `ConfigureBot`'s, and the
reference implements them:

| Field | Default | Notes |
|---|---|---|
| `id` | — | **Required**, and the only required field. The key every other endpoint takes; **immutable** after create (read-only on Edit). |
| `algoritmId` | unset | Spelled this way in the API. Part of the completeness test. |
| `accountId`, `brokerageId` | unset | Both or neither. Part of the completeness test. |
| `limit` | 100000 TL | Caps active orders **plus** open positions together. |
| `limitPercentage` | 100 | Share of portfolio value the bot may use. |
| `limitPerPosition` | 20000 TL | Max TL per stock. |
| `limitPercentagePerPosition` | 100 | Also caps per-stock size. |
| `emails[]` | unset | Owner notification addresses. Part of the completeness test (an empty array counts as set). |
| `forbiddenStocks[]` | `[]` | Never bought **and never sold**. |
| `active` | true | **Not in the form** — owned by the Deactivate control (§4). |
| `description` | `null` | Display-only, may be multiline, never affects logic. |

Rules the form must keep:

- **Partial merge** on update: only fields present in the body change. Fields may be
  **omitted but never blanked** — an empty `algoritmId`/`accountId`/`brokerageId` is rejected.
- **Complete** = `algoritmId` + `accountId` + `brokerageId` + `emails` all set. Saving
  incomplete is allowed and the form says what it costs: rejected from every order endpoint,
  scheduled orders skipped, quietly, until they are set. Half an account is blocked.
- **`accountId`/`brokerageId` are locked while the bot has** ActiveOrders, ScheduledOrders or
  Positions rows — the server rejects the change rather than moving rows. Render them
  read-only with that reason; never let the user type into a field that will fail.
- Effective per-stock cap is `min(limitPerPosition, portfolioValue × limitPercentagePerPosition/100)`
  — the form states this, because neither number alone predicts the order size.
- A `limit` below what the bot has already committed is blocked, with the committed figure.
- Lowering a limit never pulls a live order; it only stops the next one. Say so.
- **`forbiddenStocks` is editable in the form, as chips.** Each listed symbol is a chip with a
  `×` that removes it; a small free-text field at the end of the row adds one — **Enter or the
  `add SYMBOL` button beside it**, uppercased on the way in. `ConfigureBot` does not validate
  symbols, so the form does not either: anything typed is accepted, and the only guard is against
  a duplicate (say *`AKBNK` is already on the list* rather than showing it twice).
- **The list is sent whole, not merged element-wise.** Partial merge applies to *fields*: an
  omitted `forbiddenStocks` keeps the stored array, but a present one **replaces** it. So the
  chips in the row are the whole list after saving, and the form says that in as many words —
  removing a chip is a real removal, not a local hide.
- `forbiddenStocks` market value is deducted from portfolio value before every percentage
  calculation, so money parked in a never-traded holding cannot inflate the budget.
- **Forbidding a symbol the account already holds is the case worth a sentence.** The skip is
  both directions, so the bot can no longer *sell* that position either: closing it becomes a
  human's job, and its value leaves the budget base at the same moment. When the list intersects
  the bot's holdings, the form names the symbols and says exactly that, in `--st-warn`. It is not
  blocked — it is a legitimate thing to want — but it is never silent.

**Not bot fields, and never to be reintroduced:** `owner` (it is `GetAccounts.owner` —
read-only, often empty, edited by hand outside this app) and "max open positions" (no such
field exists; position count is capped only through the TL and percentage limits).
