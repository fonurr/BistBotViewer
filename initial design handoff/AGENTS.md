# BotViewer — start here

A React + TypeScript SPA for watching trading bots that run on **MatriksOrder**. Dark only,
English only. Real money is on the other side of every button in this app.

## Read in this order

1. **`SPEC.md`** — the rules: vocabulary, screens, write-path contract, unknown/degraded
   behaviour, copy rules, and the corrections that override the visual reference.
2. **`SCREEN-MAP.md`** — per screen: what it reads, what it writes, every state to build.
3. **`TOKENS.md`** — every color, space and type value, and what each status color *claims*.
4. **`BotViewer.dc.html`** — the visual reference. Open it in a browser and inspect it. It is
   a design artifact: read values and behaviour out of it, do not port its markup.
5. `MatriksOrder/API.md`, `DailyDataAggregator/API.md` — the servers. Field names and
   semantics from these always win over design intent. **They are not part of this package** —
   they are the servers' own repositories, and they must sit as siblings of this folder for the
   paths above to resolve. Never keep a copy alongside these docs: a stale `API.md` travelling
   with the design is the one thing that could outrank the real one. Find `MatriksOrder` and
   `DailyDataAggregator` projects in "../"

## The three documents are the contract. The reference is partial.

This matters more than anything else on this page. `SPEC.md`, `SCREEN-MAP.md` and `TOKENS.md`
specify the whole app. `BotViewer.dc.html` illustrates most of it and **not all of it** — design
stopped at a reference, not at a complete state inventory.

**A state with no picture is a state to build.** It was specified deliberately, and its absence
from the reference is not a decision to drop it. Where the reference is silent, the words in
`SCREEN-MAP.md` are the whole brief; build to them and ask if they are not enough.

The states known to be specified but not drawn, so you are not hunting for them:

- **The refresh control.** The header has a freshness line and a logs button and no refresh icon,
  so all of `SPEC.md` §1's refresh behaviour — icon spins, label reads `Loading…`, both disabled
  and dimmed, scroll position preserved — has no picture at all.
- **Degraded prices.** `feedState` reaches the header line and the Book's stream-down banner and
  nothing else. Every P&L figure in the reference is drawn as if the feed were live. `SPEC.md` §5
  and `TOKENS.md` rule 2 are the spec for what those figures do when it is not.
- **Write actions held while the stream is down.** The banner says they are held; the rows behind
  it still offer `edit`, `cancel`, `sell` and `fire now`. The banner is right.
- **The toast** for a row-level write taken outside the dialog, in all three outcomes.
- **Genuinely-empty states**: first run with no bots, a Book with nothing at all today, a
  Performance window with no closed trades. `SPEC.md` §5 says what they are: nothing in the
  content area.
- **Nothing left to sell** — sellable 0, the `sell` action *absent* rather than disabled.
- **Performance windows** as real controls, and the trading-day count that has to move with them.
- **Logs**: the type chips as a real filter, sortable and resizable columns, and the
  `AccountFeedSilent` escalation out of the drawer (`OrderAccountMismatch`'s escalation is drawn;
  its twin's is not).
- **Keyboard** beyond the symbols popover: Esc on dialogs and the drawer, focus trap and
  return-focus, Enter on a valid primary. `SPEC.md` §5's *Keyboard and viewport* is the spec.

Two more things about the reference itself. The three cards at the foot of the Book — *the state
law*, *rules that fade*, *why the accent is blue* — are design commentary, not product UI; do not
build them. And several toolbar controls are deliberately static props rather than working
filters; `SCREEN-MAP.md` says which.

## Non-negotiables

- Never modify anything under `MatriksOrder/` or `DailyDataAggregator/`.
- `bistApi/` is the only module that may talk to MatriksOrder. `priceApi/` is the only one that
  may talk to DailyDataAggregator.
- `pages/*` imports from `components/*`. Never the reverse.
- A README in every page module, in `components/`, and in each API boundary.
- No new colors, spacings, radii or font sizes. If `TOKENS.md` does not have it, ask.
- **A state we cannot confirm is never green.** This decides more UI than any other rule here.
- **A status cell carries a stored value from `SPEC.md` §2, in its display form.** `By user`, not
  `CanceledByUser`. `Partly filled`, not `PartiallyFilled`. There is no `Active`. Four words in
  that column are not statuses and are allowed — §2 names them and that list is closed.
- Never report a write as done when the reply did not say so. `CancelOrders` answers empty, so a
  live order's result is **`Accepted`**, never `Canceled`, and never green;
  `CancelPendingOrderRequests` answers per item and `gone` is a normal outcome.
- Do not invent copy for a state that is not specified. The words are part of the design — ask
  rather than improvise. `SPEC.md` §6 lists the ways this project's copy goes wrong; it is worth
  reading before writing a string, not after.
- **Nothing is waiting on the order router.** Every designed control maps onto endpoints that
  exist today. `fire now` is `CancelOrders` and then, only on a confirmed cancel, `SendOrders`
  with the same terms — never faked with a reschedule, and its cancel-landed/send-refused
  outcome is a state to build, not an edge case. A resend is a new order that draws as its own
  chain; that is the final answer, so do not link the two chains or word the copy as if a field
  were missing.
- Do not send/cancel/update an order for your tests,  it involves real money, you can check the
  api logs in ..\MatriksOrder\data\api-log.db if you have to

## Working order

Take one screen at a time with its `SCREEN-MAP.md` section. Build its states, including the
degraded ones, before moving on — the empty, stale and unknown cases are the design, not
polish. The Book is the largest and most load-bearing screen; the shared chain, order form,
confirm/result and filter-popover components come out of it, so build it before Performance.
