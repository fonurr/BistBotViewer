# Token map

Every value in the UI, what it resolves to, and where it is allowed. Two halves: what comes
from Nocturne, and the status set this project owns.

Dark only. There is no light theme and no toggle — Nocturne's whole treatment assumes the dark
ground, and a light variant is a redesign, not a token swap.

---

## 1. From Nocturne (import; nothing to decide)

Load the design system stylesheet and read these through `var(--*)`. Never hard-code a value
it already carries.

| Token | Value | Use |
|---|---|---|
| `--color-bg` | `#161826` | The page. The only background at rest. |
| `--color-text` | `#e9e9ed` | Body text, and the *filled* status (see below). |
| `--color-divider` | Nocturne neutral | Hairlines, control borders, popover edges. |
| `--color-neutral-100…900` | Nocturne ramp | Surfaces, skeleton bars (`800`/`900`), muted borders. |
| `--radius-sm / -md / -lg` | 8px scale | `sm` on rows and tails, `md` on cards/controls/dialogs. |
| `--space-2 … --space-8` | `5.6 / 8.4 / 11.2 / 16.8 / 22.4px` | Density 0.7× — dense on purpose. Row padding is `--space-2` (legs) and `--space-3` (openers). |
| `--font-heading` / `--font-body` | Inter / Inter | Headings never bolder than 500; hierarchy is size and space. |
| `--shadow-sm / -md / -lg` | Nocturne | `elev-sm` on bot cards, `elev-lg` on popovers and dialogs. Never stack shadows. |
| `.btn` `.btn-primary/-secondary/-ghost` | outlined | Primary is an **accent outline**, never a fill. |
| `.card` `.input` `.field` `.seg` `.tag` `.table` `.dialog` | Nocturne components | Use them; do not restyle raw HTML to imitate them. |

### Project accent — signal blue
Nocturne ships a blurple accent. This project uses blue, and that is a settled decision:

```
--color-accent      #5c9fd9      --color-accent-500  #5c9fd9
--color-accent-100  #f2f7fe      --color-accent-600  #4180b8
--color-accent-200  #dfedfc      --color-accent-700  #31628e
--color-accent-300  #c0dcf8      --color-accent-800  #274a67
--color-accent-400  #93c3f0      --color-accent-900  #1e3346
```

**The accent is wayfinding and emphasis only.** Current nav item, section kickers, focus ring,
selected filter chips, the bot grouping rule, primary button outlines. It is **never a status
and never a money sign** — nothing about the accent may imply an order is alive or a number is
good. Paragraph-size accent text uses `--color-accent-300`, not the base (contrast).

`:focus-visible` is a 2px accent outline at 2px offset, from Nocturne. Do not remove it, do not
replace it with the browser default.

**Button weight is set by where the action lives, not by how much it matters.** Inside a row or a
leg every action is `.btn-ghost` — a bordered button in a table row draws a box around a word and
the grid stops reading as a grid. An urgent row action carries **status ink** instead of a border
(`sell` on a position with no exit is ghost in `--st-dead`; `fire now` on a scheduled order is
ghost in `--st-warn`, the hue reserved for *we do not know* because sending a schedule early
replaces a decided time with a human's). No tint, no border, no fill — a filled chip in a grid
row breaks the column reading exactly the way a border does. Loudness in a row comes from hue
and weight only. The accent-outlined `.btn-primary` is
reserved for the one committing action in a dialog's action bar, at most one per bar.

---

## 2. Ours — the status set

Nocturne is a mono system: accent plus neutrals, no green/amber/red ramps. These six are
inventions on top of it, and in this app a color is **an assertion about someone's money**. Each
one is pinned to a claim. A component may not use one for a different claim because it looks
right.

| Token | Value | The claim it makes |
|---|---|---|
| `--st-live` | `#59c98f` | **At the exchange right now**, or a number that is up. Confirmed, live, working. |
| `--st-wait` | `#d9b063` | **Nothing has been sent yet**, or it is sent but unconfirmed. Scheduled, batched, queued, in flight. |
| `--st-dead` | `#f0918a` | **Gone**, or a number that is down. Canceled, rejected, expired, deleted. |
| `--st-warn` | `#e8a56b` | **We do not know.** Unknown outcome, untrustworthy price, mismatch, needs a human. |
| `--st-fill` | `#e9e9ed` (= text) | **Really held.** A filled position — the plainest, most solid thing on screen. |
| `--st-done` | `text @ 34%` | **Settled and historical.** Closed trades, finished chains. |

Tints, for grouped blocks and row backgrounds only:

```
--st-live-t   live @ 13%      --st-wait-t   wait @ 13%      --st-dead-t   dead @ 12%
```
`--st-warn` tints inline at 9–12% via `color-mix`. `--mut` is `text @ 70%` — secondary text,
never a status.

### API status → token

| Source | Token |
|---|---|
| `PendingNew`, `New` (sent, no exchange id yet) | `--st-wait` |
| `New` / `PartiallyFilled` **with** an exchange id — resting and acknowledged | `--st-live` |
| `Filled` leg inside an open chain | `--st-done` |
| `Scheduled` (held by the server, nothing on the wire) | `--st-wait` |
| `PendingOrderRequests` row (nothing sized, nothing sent) | `--st-wait` |
| Live row with `cancelSource` set (a cancel is in flight) | `--st-wait` |
| Positions row | `--st-fill` |
| ClosedTrades row | `--st-done` |
| `CanceledByBot` / `CanceledByUser` / `CanceledByServer` / `Canceled` / `Expired` / `Rejected` / `Skipped` / `SkippedForNow` | `--st-dead` |
| A cancel a reply could not confirm — the `Accepted` face in a result panel | `--st-wait` |
| `Unconfirmed` (the verdict: we will never know) | `--st-warn` |
| Write outcome unknown (timeout, unreadable reply) | `--st-warn` |
| `gone` from `CancelPendingOrderRequests` | `--st-warn` |
| `feed != "live"`, or any price we will not stand behind | `--st-warn` |
| `OrderAccountMismatch`, `AccountFeedSilent`, `AccountNotFound` | `--st-warn`, escalating to `--st-dead` in the banner when a position is exposed |
| Bot: deactivated / incomplete / healthy | `--st-dead` / `--st-wait` / `--st-live` |

There is no token for `Active` or `ScheduledBatch` because those statuses do not exist. `Expired`
and `Filled` do exist and are in the table above. See `SPEC.md` §2 for the stored values and their
display words — the Book prints the **display** word (`By user`, `Partly filled`), never the
stored one.

### Rules that decide the hard cases

1. **Never green for unconfirmed.** If the exchange has not acknowledged it — no
   `matriksOrderId` — it is `--st-wait`, however likely it is to be fine.
2. **P&L sign colors are conditional on trust.** `--st-live` / `--st-dead` on a number only
   while the price behind it is trustworthy (`feed == "live"`). Otherwise the number is `--mut`
   with an explicit label — never a colored number we cannot defend.
3. **`--st-warn` outranks the others.** A row that is both scheduled and unreconcilable reads
   warn: not knowing is the more important fact.
4. **Status lives on the 3px left spine.** Tint backgrounds only for grouped blocks (a canceled
   tail, a pending basket, a callout). Do not tint every row — the table stops being readable.
   **One single row is tinted, and only one:** a live row with a cancel in flight, in
   `--st-wait-t`, because it is the only row in the table whose state changes on its own while
   you watch it and the only one that needs a second line to be honest. If a second single-row
   tint ever seems necessary, the answer is a spine and a word, not another fill.
5. **`--st-fill` is deliberately colorless.** A holding is a fact, not a signal. Do not
   "improve" it to green.
6. Success in a result panel is `--st-live`; anything less than success is never `--st-live`.
   **A cancel is less than success until a refresh confirms it** — `CancelOrders` answers empty, so
   its item reads `Accepted` in `--st-wait`, matching the cancel-in-flight row it creates. Only a
   *scheduled* cancel is green, because nothing was ever on the wire for it to be unsure about.
7. **A signed number is only inked when the sign has one meaning.** P&L up is good, so it takes
   `--st-live` / `--st-dead`. **Slip does not** — a price that moved up helped a seller and cost
   a buyer, so the slip cell stays `--color-text` at every value and the sign says only which
   way the price went. The same restraint applies to any figure whose reading depends on the
   side.
8. **A scheduled row's fire time is `--st-wait`, in the *order time* column.** It is the one
   time the row has, and it has not happened yet — amber, like every other not-yet-sent fact.
9. **A figure we could not compute is `--st-warn`, and it is counted.** Missing source data (a
   bars.db day the producer never wrote, an auction nobody traded) gets its own row or cell in
   warn ink, with the count and the reason — never folded into the total as a zero, and never
   silently dropped so the totals stop adding up.

---

## 3. Numbers and figures

- `font-variant-numeric: tabular-nums` on every container that holds figures — columns must
  align down the page.
- Turkish format: `.` thousands, `,` decimals (`38,16`, `9.315`, `+31.204,80`). Dates
  `dd.MM.yy`. Times `HH:mm`.
- Signed money always carries its sign (`+412`, `−1.428,00`) using the true minus `−`.
- **A value that does not exist in a table cell leaves the cell empty.** No em dash, no `0`, no
  `-`. The grid keeps the cell (the column has to stay a column), and the whitespace says the
  same thing an em dash said with less ink — across a page of chains, a hundred dashes read as a
  pattern that means nothing. In **prose and summaries** the em dash stays (`price — → 0,95`),
  because a sentence needs the placeholder a column does not. Never `0`: zero is a measurement
  and this is not one.
- Percentages state what they are of; percentages use weighted averages, absolutes use totals.
- **A value the record kept but never sent is italic `--mut`** — an `auto` quantity waiting to
  be sized, and the price a market order captured at the API call. Same ink as an em dash, so it
  never reads as an instruction the exchange saw, but present, because it is what the record
  holds. Nothing derived is computed from it.
- **A time repeats nowhere.** When a column carries it, the status cell does not, and when the
  batch heading states the day, the time columns show `HH:mm` alone.

## 4. Type scale in use

| Role | Size / weight |
|---|---|
| Page title (`h4`) | Nocturne heading, weight 500 |
| Big number | 19–22px / 500 |
| Card title (bot name) | 20px / 500 |
| Row text | 13px; nested legs 12.5px |
| Meta, secondary | 11.5–12.5px in `--mut` |
| Kicker | 10px, uppercase, `letter-spacing: .1em`, `--mut` (or `--color-accent-300` when it labels the live thing) |
| Tag | 9.5–10.5px uppercase |

Minimum body size in this app is 11.5px and it is only for meta text. Nothing smaller.
