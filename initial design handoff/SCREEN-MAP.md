# Screen map

Screen → what it reads → the states it must handle → where the reference lives in
`BotViewer.dc.html`. Read with `SPEC.md` (rules) and `TOKENS.md` (colors).

All MatriksOrder reads go through `bistApi/`, all price reads through `priceApi/`. The table
reads take `botId` as one id, an **array of ids**, or `"*"` — so a many-bot view is one call
per table, not one per bot per table. An **empty array is refused** (a caller who meant "all"
would otherwise get a silent empty answer), so an empty bot filter renders the empty state
instead of calling. `GetBotBudget` is the exception: single-bot only, live from the account.

Manual refresh is `RefreshData` — it returns `{}` at once and the outcome arrives on
`/api/events` (`refreshStarted` → `refreshFinished`; an unchanged `lastUpdateTime` means it
failed).

---

## Bots — `pages/bots`

| | |
|---|---|
| **Purpose** | The fleet at a glance, and the only place a bot is created, edited or deactivated. |
| **Reads** | `GetBots` (carries computed `complete`) · `GetAccounts` (account label + `owner`) · `GetBotBudget` per bot (`limit*`, `remainingBotBudget`, `portfolioValue`) · `GetActiveOrders` / `GetPositions` / `GetClosedTrades` for counts · `priceApi` quotes for unrealized |
| **Writes** | `ConfigureBot` (create, update, and `active: false`) |
| **Reference** | Bots page: cards for healthy / incomplete / deactivated, the stat strip, the "most dangerous control" card and its two confirmations |

States to build:
- **Loading** — card at final height, skeleton bars for counts and P&L. No reflow as data lands.
- **Healthy** — live spine, full counts.
- **Incomplete** — wait spine; says it is rejected from every order endpoint and its scheduled
  orders are skipped until the missing fields are set. Primary action: finish setup.
- **Deactivated** — dead spine. If it still holds positions, the card says it cannot buy, can
  still sell, and nobody is managing the exit. **Reactivate** opens a plain confirmation (counts,
  limits, and the note that skipped scheduled buys are not replayed) and then a result row.
- **Deactivated with no rows** — cannot happen: that bot was deleted.
- **Prices untrustworthy** — unrealized reads `stale` in `--mut` with the reason, not a number.
- **First run, no bots** — nothing in the content area (`SPEC.md` §5).
- **Filtered to nothing** — the reason, and a clear-filter action.

Forms (see `SPEC.md` §7 for the authoritative field list):
- **Add** — everything optional but `id`. Saving without an account is allowed and says what
  that produces.
- **Edit** — partial merge; `accountId`/`brokerageId` disabled with the reason while the bot has
  ActiveOrders / ScheduledOrders / Positions rows.
- **Finish setup** — the same form, opened on what is missing.
- **Deactivate** — reads row counts first, then one confirmation that says *deactivate* or
  *delete*, with the counts that decide it.

---

## The Book — `pages/book`

| | |
|---|---|
| **Purpose** | Every order, position and trade across bots and accounts, as chains. |
| **Reads** | `GetActiveOrders` (active **and** scheduled rows) · `GetPositions` · `GetClosedTrades` · `GetCanceledOrders` · `GetPendingOrderRequests` · `GetBots` · `GetAccounts` · `GetHolidays` (for date-range copy) · `priceApi` quotes for unrealized |
| **Writes** | `EditOrders` · `CancelOrders` · `SendOrders` (selling a position by hand, and resending a canceled order) · `CancelPendingOrderRequests`|
| **Live** | SSE `write` on ActiveOrders / ScheduledOrders / CanceledOrders / Positions / ClosedTrades / `PendingOrderRequests` (there the request arrives as the raw `requestBody` string) — filter by `botId` |
| **Reference** | The Book: scope toggles, filter popovers, chip row, stat strip, chain shapes for all four scopes, canceled tails, the chain dialog and all of its write paths |

Chain assembly: group by `chainId`, identify by `clientOrderId`, walk `retryOfClientOrderId`
and `parentClientOrderId` for the edges. Opener first, live legs next, canceled tail last.
A row with a `null` chain link renders as itself.

States to build:
- **Scopes** — additive; each has a header line stating what it contains and its aggregate.
  **None selected** is its own message, not an empty table.
- **Canceled legs** — hidden by default, one global toggle in the toolbar (the count *is* the
  control, and it carries no "show them" instruction), per-chain overrides on the red tail, and a
  label that reconciles both counts.
- **Pending baskets** — group at the top of Waiting; per-row selection; per-item result with
  `canceled` / `gone` / `wrongBot` rendered separately.
- **Needs a human** — banner above the filters, **never filtered**: positions with no closing
  order, account mismatches. Counts are clickable; the mismatch opens the stored `GetErrors` row
  verbatim.
- **No closing order (focused view)** — the banner's positions count is a filter. It resets the
  Book to `Waiting` + `Positions`, all bots, all accounts, no symbol, **every batch**, and lists
  only the offending chains: a held position with no active or scheduled sell, and a waiting buy
  whose exit is already canceled. Clicking the banner count again clears just that filter. Own heading, a `no closing order` chip that also clears it, and each
  chain labelled with its bot and batch date because the set spans both. Reads the same four
  order sources — the filter is client-side over already-loaded chains, so it must not depend on
  the batch range the user had.
- **A scheduled row's fire time** — shown in the *order time* column in `--st-wait`, never `—`;
  the status cell says `Scheduled · in 2h 14m` and never repeats the `{type, diff}` spec.
- **A market order with a captured price** — `orderPrice` recorded at the API call and never
  sent to Matriks: italic muted in the *order* column, and **no slip figure derived from it**.
- **Filtered to nothing** — the reason (which filter emptied it), and clear.
- **Nothing at all today** — nothing in the content area; no invitation, no illustration.
- **SSE down** — frozen-snapshot banner, timestamped; write actions held with the reason.
- **Prices untrustworthy** — unrealized in the strip and per row falls back to last known,
  labelled; the strip says the total is not defensible.
- **A chain with no exit** — the one thing rendered in dead colors inside an otherwise live
  chain.
- **A cancel in flight** (`cancelSource` set) — still at the exchange, not yet confirmed;
  actions disabled.
- **A scheduled sell that fired early** at the ceiling — it leaves `Scheduled` before its
  `scheduledTime`, so the row must not have promised the time.
- **Nothing left to sell** — sellable is 0 because the active and scheduled sells claim the
  whole position; the `sell` action is absent, and the chain view says what claims the shares.
- **A cancel in flight** — a live row with `cancelSource` set: `--st-wait` spine and the one
  permitted single-row tint, both facts in the status cell (`Partly filled · cancel in
  flight`), which side asked in words, `edit` and `cancel` **disabled with reasons** rather
  than absent, and a second line saying it can still fill and what the cancel can take of a
  partly filled order. It does **not** raise the sellable count (`SPEC.md` §4, §5).
- **Resend a canceled order** — the `resend` action on a canceled leg, its two-mode form
  (as it was / change it first), and the case where the action is **absent** because the stored
  quantity exceeds what the position leaves unclaimed. The result opens a **new chain**
  (`SPEC.md` §4).
- **Fire a scheduled order early** — `fire now` in `--st-warn` ink on a `Scheduled` row,
  straight to a confirm. There is no send-now endpoint: it is `CancelOrders` on the scheduled
  row and then, only on a confirmed cancel, `SendOrders` with the same terms resolved now. Two
  itemized calls and three results: **`Sent now`** (both landed, the new order shown with its own
  id and chain), **`Not fired`** (cancel refused, the send listed as `Not sent` in muted ink and
  the schedule still standing), and **`Half done`** (cancel landed, send refused — the scheduled
  row is gone, nothing replaced it, and the standard "nothing changed" reassurance is replaced).
  Blocked while SSE is down (`SPEC.md` §4).

Dialog steps: view → (form | confirm) → sending → result (`SPEC.md` §4). A write that needs
values gets a form step — **edit an order** (every field `EditOrders` accepts, plus fire time and
`cancelAtFloor` for scheduled rows), **sell by hand** (the sell side of `SendOrders` for one
stock, send now or scheduled) and **resend a canceled order** (as it was / change it first) —
while every cancel, and `fire now`, gets a confirm step that itemizes its calls in
order. Navigation is flat: every step's secondary button is **Close** and dismisses the dialog,
there is no Back, and the result step carries only **Done**. The sending step holds the affected
row at its old value with a spinner row beneath it; every result is per item, in one of four
faces — succeeded (with a flash on the changed rows), **accepted** (a cancel whose empty reply
confirms nothing, in `--st-wait`), refused (reverted, with the reason), no answer (the honest
unknown).

---

## Performance — `pages/performance`

| | |
|---|---|
| **Purpose** | What the fleet actually made, gross, over a window. |
| **Reads** | `GetClosedTrades` (realized, open/close prices, slippage) · `GetBots` (budget context) · `GetHolidays` (trading days in the window) · DailyDataAggregator `bars.db` for the hold comparison |
| **Writes** | none |
| **Reference** | Performance page: the subhead's gross statement, window controls, the daily series, win/loss split, exit timing, retry ledger, the *what this page cannot say* cards |

States to build:
- **Gross, always** — one prominent statement that no commission field exists in the schema,
  and no wording anywhere that implies net.
- **Windows** — today / week / range / all, static in the design. A range states the trading days
  it actually contains, read from `GetHolidays`; never assert a holiday you have not read.
- **No closed trades in the window** — nothing in the content area; the window statement above
  it is enough.
- **Slippage not derivable** — where an order price is `null`, show nothing (not zero).
- **Scoped to one bot** — entered from a bot card's `Performance` button (`pfBot`). Subhead names
  the bot, the bots pill reads `1 bot` with a clearable chip, every figure and the curve's axis
  recompute for that bot, and the **by bot** and **by symbol** tables are hidden — both are
  cross-comparisons. Clearing the chip returns to fleet.
- **bars.db gap** — a counterfactual with no bar (producer never ran that day, or an auction
  nobody traded). Excluded from the net and **counted in `--st-warn`**: a third row on the
  exit-timing card, `no bars` + hatched bar + reason in the by-symbol table. Never averaged in
  as zero.
- **One bot vs fleet** — percentages weighted, absolutes totalled.

---

## Logs — `components/logs` (drawer over any page)

| | |
|---|---|
| **Purpose** | What went wrong, consulted while looking at something else. |
| **Reads** | `GetErrors` — `type`, `since` (inclusive), `until` (exclusive), `limit`, `beforeId`. No filter at all = last 24h; naming any one of them means you set the window |
| **Reference** | The Logs drawer in the reference |

- Table, newest first, one line per row, all fields, resizable columns, sortable.
- **Day range, per log.** Each of the three tabs (Errors, Wire log, API log) carries its **own**
  from/to day and remembers it while the drawer is open — switching tabs never carries a range
  across. **The default is today → today** on all three. The pickers are **bounded by the first
  and last day the log actually holds** (`min`/`max` on both inputs), which differs per log
  because retention does: `GetErrors` keeps 90 days, `wire-log.db` rolls weekly, `api-log.db`
  keeps a fortnight. The popover states that extent in words, offers **Today**, **Last 7 days**
  and **everything**, and when one end crosses the other the other end moves with it and the
  popover says so. A range with no rows says so and says why — it never shows an empty table
  alone.
- Paging: `limit` + last row's `id` as `beforeId`, other filters repeated unchanged, until a
  short or empty page. Never a time cursor — two errors can share a millisecond. **Paging never
  widens the day range**: the Older control asks for the next page *within* the chosen days,
  says how many rows that is, and is disabled with "every row in these days is loaded" once the
  range is exhausted. The count line reads `N of M in <range> · newest first`.
- Type chips count **within the current range**, not over the whole log.
- Types: `MatriksConnectionError`, `MatriksFieldNotFound`, `Unspecified`, `BarsDataError`,
  `AccountNotFound`, `AccountInformationUnavailable`, `AccountFeedSilent`,
  `OrderAccountMismatch`.
- Two types must escalate out of the drawer: **`OrderAccountMismatch`** (an order now appears
  under a different account; nothing reconciles while that is true) and **`AccountFeedSilent`**
  (lists look healthy while fills and cancels happen unseen).

---

## Shared components

| Component | Rules |
|---|---|
| **Top-right status** | Last updated: `Less than a minute ago` / `X minutes/hours/days ago` / `Loading…`, self-updating; refresh icon; logs icon. Feed state drives live / stale / down (`TOKENS.md`). |
| **Chain** | The one shape all four scopes render. Opener, legs, canceled tail. Fixed column grid — prices stay in one column down the page. |
| **Order leg** | 3px status spine, status word, its own actions (`edit` / `cancel`; `sell` on a position row; `fire now` on a scheduled row; `resend` on a canceled leg that can still go out). Trades carry none. Actions are ghost buttons in row ink — never a bordered or filled chip inside the grid. |
| **Chip list field** | The pattern behind `forbiddenStocks`: chips with `×` to remove, a narrow free-text field at the end to add (Enter or an `add SYMBOL` button), uppercased, duplicates refused with a line rather than a second chip, and the note that the list is saved whole. |
| **Order form** | The shared shell for a write that needs values: every field the call accepts, the bounding arithmetic in words beneath, primary blocked with the reason in place while anything is invalid. Used by edit and by sell. |
| **Filter popover** | Trigger shows the current selection; popover carries the one fact that prevents a wrong reading; click-away closes. The symbols one is **type-to-narrow**: autofocused free-text field, list narrows as you type, Enter toggles the ringed first match, mouse toggles any tag (`SPEC.md` §5). |
| **Stat strip** | Aggregates the filtered set, and nothing else — the by-hand override count belongs to the canceled toggle's own label, said once. `avg slip` mixes buy and sell directions, so it sits near zero; the split that means something is on Performance. |
| **Confirm / result** | The shared shell for every write: itemized calls, a sending step that never draws an unconfirmed state, per-item outcomes in five faces — landed, **accepted** (`--st-wait`: a cancel whose empty reply confirms nothing), refused, unknown, and `Not sent` in muted ink for a call a failed predecessor stopped. |
| **Toast** | Only for row-level writes taken outside the dialog. Same three outcomes; a refusal or unknown waits for the user to dismiss it. |
| **Skeleton** | Reserves final height. Used wherever a count or P&L arrives late. |
