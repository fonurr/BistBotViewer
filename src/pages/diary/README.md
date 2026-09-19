# Diary

Everything MatriksOrder writes down that is **not an order**: the configurations a bot has been
through, the budget figures behind each of them, what the terminal reported an account was worth,
the cash that moved, and the errors the server recorded. One list, grouped by the day each entry
happened on.

The page is read-only. It holds no write path, no order form and no confirmation — every source
it reads is a record of something that already happened, and there is nothing here to act on. It
sits between Bots and The Book in the navigation.

## Reads

All five sources come from the **API**, never from a log database. `src/app/dataHooks.ts`
(`useDiaryData`) reads them through the `bistApi` boundary:

| source               | RPC                                      | window                          |
| -------------------- | ---------------------------------------- | ------------------------------- |
| bot history          | `GetBotHistory` (`botId: '*'`)           | whole table                     |
| bot snapshots        | `GetBotSnapshots` (`botId: '*'`)         | whole table                     |
| account snapshots    | `GetAccountSnapshots` (`accountId: '*'`) | whole table                     |
| account transactions | `GetAccountTransactions`                 | whole table                     |
| errors               | `GetErrors`                              | newest `DIARY_ERROR_LIMIT` rows |

The four snapshot and history reads are unwindowed on purpose: each gains a row when something
moves rather than on a clock, so upstream serves them whole and says it can afford to.

`GetErrors` is the exception. A request that names nothing gets the **last 24 hours**, which is
not a diary — so the read names a `limit`, which states its own window, and the newest rows come
back. When exactly that many arrive the cap, not the data, is what ended the list, and the type
filter says so in amber: an older day may hold errors the page never loaded. That is the
"a state that cannot be confirmed is never green" rule applied to reach.

None of the five reads is journaled. The event journal replays **order** rows, and nothing on
this page or anywhere else in the viewer writes a configuration, a snapshot or a transaction
while a read is in flight — every `ConfigureBot` is a person at a dialog on the Bots page.

The bot and account reads share the Book's own cache entries, so opening the Diary after the Book
adds four requests, not six.

## What counts as an entry

**An entry that cannot name its own instant is not an entry.** It is not counted, not filtered,
not drawn. The one case this really bites is a bot whose oldest configuration carries
`startTime: null` — the server never recorded when that configuration began, which reads as _not
known_, never as zero and never as the beginning of time. That creation is dropped rather than
filed under a day the page invented for it.

A `ConfigureBot` whose only difference from the configuration before it is a stamp is dropped for
the same reason inverted: there is nothing it can name that changed.

## The day an entry is filed under

The **event's own Istanbul calendar day**, and nothing else.

This is deliberately _not_ the Book's rule. A batch is a session, not a clock day, and the Book
and Performance both file a chain under the session its opening order belongs to — so an order
written at 19:00 is already the next session's. Nothing in the Diary is a chain, so nothing here
is owed a batch: a configuration change at 19:00 is an entry on that evening, where the same
instant on the Book would head the next day. The date filter's note says so, and the popover is
headed `event days` rather than `batch range` so the two words never get confused.

## Descriptions

Each description is built as **fragments**, not as a string, because a reader has to tell a field
name from the figure behind it at a glance. `src/domain/diary.ts` emits five inks and
`diary.css` colors them: `text` (prose, muted), `field` (accent), `value` (full-strength text),
and `added` / `removed` for array deltas, in the live and dead status inks.

What each kind says:

- **Bot history.** The bot's first configuration is `Bot created on <accountId · brokerageId>`
  (or `Bot created, account unset` for an incomplete bot — that is the fact, and an empty pair
  would not be). Every later one names **only what changed**, against the configuration before
  it: `limit: 100.000 → 150.000`, `Activated` / `Deactivated`, and for the two arrays
  `forbidden: added THYAO, removed GARAN` rather than the whole list again. A lifted TL cap is
  the word `lifted`, because `null` is a value on `limit` and `limitPerPosition` rather than a
  missing one — it says the percentage beside it is the bot's only cap on that axis. The stamps
  are left out (they are the row's own time) and `complete` with them (it is computed, not
  configured).
- **Bot snapshots.** Every figure that is not zero, as `field: value`. A size of nothing is not
  news; what a reader is after is which of them the bot was carrying. `remaining` keeps its sign,
  because a negative one says the bot is over its limit.
- **Account snapshots.** The same rule, plus: a `null` is left out too. The field set varies per
  brokerage and an entry the terminal did not send is a null, never a zero — and neither a null
  nor a zero is something that moved.
- **Account transactions.** `1.250,75 TL withdrawn` / `… deposited`. The sign is the whole fact,
  so it is said in words and the figure is printed unsigned.
- **Errors.** The stored `type` alone. The text behind one belongs in the log drawer, which is
  where a reader goes once the Diary has told them an error of that type happened at that minute.

The description column never repeats what the two columns left of it already print: no entry
restates its own time, its bot id or its account pair.

## Filters

The toolbar is the Book's, reused rather than re-invented — `DateRangeFilter` and
`MultiSelectFilter` from `src/components/`.

- **Event days.** The shared `DateRangeFilter`, headed `event days`. Only a day the loaded
  entries fall on can be picked; the steppers walk those days and the calendar disables the rest.
- **Type.** The five kinds, all ticked by default, with `all` and `none`. Each counts the entries
  it would contribute **under the rest of the toolbar** — so the count moves with the bot,
  account and date filters but not with its own ticks.
- **Bots.** The Book's control, with its `none` / `active` / `inactive` picks, behind a `filter`
  switch — the one the Book's time and status filters carry. **Off by default**, and off is not
  "every bot" but the axis not being asked.
- **Accounts.** The same control behind the same switch, also off by default.
- **Sort.** One button, not two: the order has exactly two states and only one can be in force,
  so the control names the one it is in (`Newest first` by default) and swaps on press. The
  up/down arrows beside it say that pressing re-sorts rather than filters.

### What each entity filter governs

Each sits behind its own `filter` switch, and each governs what it can name and nothing else.

**Off — the default — the axis is not asked at all** and every entry passes it. That is why it is
the default: switching it on is itself a narrowing, the way the Book's status, source, origin,
reason, time and slippage filters are, so "off" cannot honestly mean "every option".

On, an entry has to name a ticked subject:

- an entry **about a bot** must have that bot ticked;
- an entry **about an account** must have that account ticked;
- an entry that names neither — an error the server could not attribute, and for the bot axis an
  account snapshot or a cash movement too — is not about anything the filter asked for, so it
  **drops out even with every option ticked**.

So an error has to be about that bot or that account to survive a switched-on filter. With both
switches off, as the page opens, nothing is narrowed and every error is drawn.

A bot entry also carries an account, and it is the account the bot was bound to **at that
instant**, resolved from its own configuration timeline. A budget is charged against an account,
so a snapshot is filed under the one the bot was on then, not the one it sits on now. Narrowing
to one account therefore narrows that account's bots with it.

Inside a switched-on filter, `null` is _every_ option, which is not the same set as all of them
ticked: a viewer that gains a bot keeps meaning every bot until somebody narrows it. That is the
same reading the Book's filters carry. Switching either filter on or off puts its selection back
to **none**, so a reader switching it on ticks the bots they came for rather than unticking the
rest first — again the Book's rule, and the disabled boxes behind an off switch show exactly what
it would come back on with.

The type counts follow both switches, so a kind's count is what it would contribute under the
rest of the toolbar as it actually stands.

## The list

Days collapse. The **first** day in the current order opens itself and the rest wait behind their
chevron, which is what keeps the page quick across a year of them — the Book's arrangement, and
`opened` / `closed` are kept apart for the same reason it keeps them apart, so the default
follows the first day whatever the filters and the sort make it. Collapsing re-anchors the
heading before paint so the page does not jump under the reader.

Three columns: the clock (seconds at full strength, the millisecond fraction dimmed behind them,
as the log drawer draws it), the bot or account, and the description. The first two take exactly
what they need and **everything left over goes to the description** — some of them carry a whole
configuration change, and a fixed width would wrap every one of them.

Empty stays empty. An error the server could not attribute names nobody, and its subject cell is
blank rather than carrying a dash.
