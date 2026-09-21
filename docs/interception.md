# Traffic interception / fault injection

Alfred can change traffic on its way through, not just record it. A **rule** says which traffic to
affect; its **actions** say what to do — delay it, rewrite a header or a JSON field, block it,
answer it without contacting upstream, or **pause** it and hold the caller's connection open while
a human decides.

Off by default, and inert until both the master switch is on and at least one rule is enabled. With
no rules, Alfred behaves exactly as it did before this existed — see [Backward compatibility](#backward-compatibility).

## Where the work happens, and why

```
client → mitmproxy ──(rules evaluated HERE, locally)──→ upstream
   ▲          │                                            │
   │          └── webhook (fire-and-forget) ──→ backend ────┘
   └──────────────────────── response ◄────────────────────
```

**Rules are evaluated entirely inside the two mitmproxy addons**, against a JSON snapshot the
backend publishes. Nothing about a proxied request touches the database or the backend.

That is the single most important design decision here, and it follows from how Alfred already
works: the proxy's webhooks are deliberately fire-and-forget precisely so a slow or absent backend
can never affect proxying (see `proxy/log_and_route.py`'s module docstring). Evaluating rules
backend-side would put a JVM on the request path of every call and make a backend restart stall
live traffic. So the backend owns **authoring, validation, persistence and the paused-call
handoff** — and never evaluates a rule.

| Concern | Lives in |
|---|---|
| Matching, mutation, delays, mocks | `proxy/interception.py` |
| Holding a paused call, talking to backend | `proxy/breakpoints.py` |
| Rules CRUD, validation, storage, publishing | `backend/backend-interception` |
| Paused-call registry and decision rendezvous | `BreakpointService` |
| UI | `frontend/src/app/pages/interception/`, `components/rule-editor/`, `components/paused-calls/` |

## How rules reach the proxy

The backend writes `proxy/interception/rules.json` after every change (and once at startup). Both
proxy containers read it, cached by mtime, and re-read only when it changes.

This is the same mechanism `proxy/reverse-proxy-enabled.flag` already uses for the per-project
logging toggle (`FileLoggingToggleAdapter` ↔ `log_and_route_reverse.py`'s `_ToggleState`), carrying
a richer payload. It costs nothing per request, needs no new infrastructure, and keeps working
while the backend is down.

Two properties that are load-bearing:

- **The write is atomic** (temp file + move, `FileRulesPublisherAdapter`). A reader that caught the
  file half-written would get a JSON error, and the loader's correct response to a corrupt file is
  to disable interception — so an in-place write would make every save a brief outage of the whole
  feature.
- **The mount is the directory, not the file.** A move replaces the inode, and a single-file bind
  mount stays pinned to the old one, so updates would silently stop arriving.

Only **enabled** rules are published: forty stored rules of which two are on cost two match
attempts per call, not forty.

## Matchers

Every field is optional; an absent field matches anything, so an empty match applies to **all**
traffic. The UI states a rule's match back in plain language for exactly this reason.

| Field | Meaning |
|---|---|
| `source` | `outbound` (to suppliers), `inbound` (into a project Alfred fronts), or `both` |
| `serviceNames` | Any of these configured projects from `internal_call_services`; empty means any |
| `methods` | `["POST", "PUT"]`; empty means any |
| `host` | Exact, or one leading wildcard label: `*.sabre.com` |
| `pathContains` | Substring |
| `pathRegex` | Compiled **once at rule load**, never per request |

`source` and `serviceNames` are the Alfred-specific ones and the reason this is not a generic
proxy rule: both addons already know, structurally rather than by guessing, which direction a flow
is going and which project it belongs to (from the port it arrived on).

`serviceNames` is a LIST - any of the named projects matches, and an empty list means any project
at all. The editor picks from `GET /internal-calls/services` rather than accepting free text: a
rule scoped to a misspelled or since-renamed project matches nothing, and nothing about the
silence says why. The pre-list `serviceName` field is still read on the way in (both by the
backend record and by `interception.py`'s `Match`), because the rules file on disk can be older
than the container reading it, and silently widening a project-scoped rule to all traffic is the
worst direction for that mistake to go.

**Deliberately not implemented:** header, body and query matchers (they invite an expression
grammar) and response-status matching (it cannot work in the request phase, where the decision to
intercept has to be made). See [Adding a matcher](#adding-a-matcher).

## Actions

A rule is a pipeline: **request actions → the host → response actions**. The editor draws it that
way, because whether a call reaches the host decides whether the response half runs at all.

| Request phase | Response phase |
|---|---|
| `DELAY_REQUEST` | `DELAY_RESPONSE` |
| `SET_REQUEST_HEADER` / `REMOVE_REQUEST_HEADER` | `SET_RESPONSE_HEADER` / `REMOVE_RESPONSE_HEADER` |
| `SET_QUERY_PARAM` / `REMOVE_QUERY_PARAM` | `SET_RESPONSE_STATUS` |
| `SET_REQUEST_JSON_FIELD` | `SET_RESPONSE_JSON_FIELD` |
| `SEND_TO_HOST` | `SET_RESPONSE_BODY`, `REPLACE_RESPONSE` |
| `SIMULATE_FAILURE`, `MOCK_RESPONSE` | |
| `PAUSE_REQUEST` | `PAUSE_RESPONSE` |
| `IF_REQUEST` | `IF_RESPONSE` |

`ABORT_REQUEST` still runs for rules that already use it, but the editor no longer offers it - it
is exactly `SIMULATE_FAILURE` with `CONNECTION_RESET`. `ActionType.isSelectable()` is what hides
it, so the rule keeps working and only the picker moved on.

### Where the explanations live

Every action card and every condition row carries an **ⓘ**. It opens the help for *that* control:
what it does, worked examples against a realistic supplier payload, and the one thing that
catches people out - all from `shared/utils/interception-help.ts`, as data rather than prose in a
template.

The panel closes with the control restated by the same `describeAction` / `describeCondition` the
call log uses, so the editor and the log never describe the same thing two different ways.

`interception-help.spec.ts` walks `ActionType`, the subjects and the operators and **fails if any
of them has no entry** - help that covers most of a vocabulary is worse than none, because the gap
is invisible until somebody clicks the one control nobody wrote about. It also enforces a minimum
length, which is what caught three entries that merely restated their own label.

### Conditions — look at the call, then decide

`IF_REQUEST` / `IF_RESPONSE` are actions like any other, sitting in the same list and moved the
same way. Each holds **branches**, tried in order: the **first match wins** and nothing after it
runs, with an optional `otherwise`. That makes `else if` a list rather than a tree.

```json
{ "type": "IF_REQUEST",
  "branches": [
    { "combine": "ALL",
      "conditions": [{ "subject": "REQUEST_HEADER", "name": "x-api-key", "operator": "NOT_EXISTS" }],
      "actions": [{ "type": "MOCK_RESPONSE", "status": 401, "body": "…" }] }
  ],
  "otherwise": [{ "type": "SEND_TO_HOST" }] }
```

**Subjects:** `REQUEST_HEADER`, `REQUEST_BODY`, `REQUEST_JSON_FIELD`, `QUERY_PARAM`, `URL`,
`METHOD`, and in the response half also `RESPONSE_STATUS`, `RESPONSE_HEADER`, `RESPONSE_BODY`,
`RESPONSE_JSON_FIELD`. A response subject in an `IF_REQUEST` is **refused at save time** — there
is no response yet, so the branch could only ever be false. The reverse is allowed and is one of
the main reasons to have conditions at all: *"we sent X and got back Y"*.

**Operators:** `EXISTS`, `NOT_EXISTS`, `EQUALS`, `NOT_EQUALS`, `CONTAINS`, `NOT_CONTAINS`,
`MATCHES`, `NOT_MATCHES`, `AT_LEAST`, `AT_MOST`. Comparison ignores case unless
`caseSensitive` is set, and every regex is **compiled once at rule load**, never per call.

Three semantics worth knowing, because they are the ones that surprise people:

- **An absent subject is never equal to, does not contain and does not match anything** — so
  `NOT_EQUALS` against a header that was never sent is **true**. `EXISTS` / `NOT_EXISTS` exist so
  you can say "this is missing" outright rather than inferring it from a negative.
- **A `[*]` path resolves to several values.** A positive operator holds if ANY of them satisfies
  it; its negative holds only if NONE does. That is the only pairing under which a condition and
  its negation cannot both be true.
- **An unknown subject or operator never matches.** A branch that runs because a typo was ignored
  is worse than one that never runs.

**Nesting stops at two levels**, enforced by the validator and by what the editor offers. The
engine would happily go deeper; a human working out why a booking failed would not.

**A terminal inside a branch does not conflict with one in another branch.** Branches are
alternatives, never a sequence, so a rule that mocks in one arm and resets the connection in
another is coherent where two terminals in a row would not be. It also means the editor still
says the host is reachable: that branch may not be taken.

**The branch that ran is recorded**, with the conditions that chose it:

```
IF_REQUEST    branch 1 matched: request header x-api-key not exists
MOCK_RESPONSE 401, upstream never contacted
```

A rule that can take three paths is only useful if the log says which one it took. The same
secret-masking applies as everywhere else - a condition on `authorization` records
`(value not logged)`, never the value, because this text is echoed verbatim into every export.

### Failures that are not a status code

`SIMULATE_FAILURE` carries a `FailureMode`. One action with a choice rather than six actions,
because they are alternatives - you pick what goes wrong, you do not compose them.

| Mode | What the caller actually gets | Verified |
|---|---|---|
| `CONNECTION_RESET` | Reset before forwarding; no HTTP response at all | curl exit 52 |
| `HANG_THEN_DROP` | Held `durationMs`, then killed - a supplier that goes quiet | exit 52 after exactly 3s |
| `HANG_UNTIL_CALLER_GIVES_UP` | Held until the client's own timeout fires | exit 28 (client timeout) |
| `EMPTY_REPLY` | `200` with zero bytes | `status=200 size=0` |
| `TRUNCATED_BODY` | Half the body, under a `Content-Length` promising all of it | exit 18, 25 of 51 bytes |
| `GATEWAY_ERROR` | `502`/`503`/`504` with a gateway-shaped body, host never called | `504` + body |

**What is deliberately absent: DNS and TLS failures.** The caller is connected to Alfred, not to
the supplier, and its handshake with Alfred succeeded long before any rule was evaluated - the
connection those failures would have to break is one that demonstrably works. Offering them would
be a lie in a dropdown. Everything reachable from here arrives as a reset or a timeout; what
genuinely differs is when and how the connection dies, which is what the modes above vary.

An unrecognised mode is **skipped and recorded as skipped**, never treated as a reset: turning a
typo into "kill the connection" is the worst available reading of it.

`failure_plan()` in `interception.py` turns a mode into `{sleep, kill, response}`, and the addons
own the two lines that touch mitmproxy. That split is why the engine's tests run without
mitmproxy installed, and why both directions cannot drift.

### Send it to the host, then decide

`MOCK_RESPONSE` and `REPLACE_RESPONSE` look similar and are opposites in the one way that matters:

| | Host contacted? | Use it when |
|---|---|---|
| `MOCK_RESPONSE` | **No** — ~8 ms, nothing leaves Alfred | The supplier must not see the call at all |
| `REPLACE_RESPONSE` | **Yes** — the real call happens, is timed and logged | You want the real exchange on record but the caller to see something else |

Measured on the same endpoint: the mock answered in 11 ms, the replacement in 138 ms because the
supplier really was called.

`SEND_TO_HOST` states "actually call the real thing". Forwarding is already the default, so on its
own it makes a rule read as a pipeline — but it also **latches**: once it has run, a
`MOCK_RESPONSE` or `ABORT_REQUEST` from any *later* rule is refused for that call. That is how a
narrow exception is written against a broad mocking rule without carving a hole in the broad rule:

```
priority 10  match path contains /health   → SEND_TO_HOST
priority 50  match host example.com        → MOCK_RESPONSE 503
```

Verified live: `/other` came back mocked in 11 ms, `/health` reached the real host in 124 ms.

It does **not** revive a call an *earlier* rule already short-circuited — that one is already
decided by the time this rule is reached, which is what `priority` is for. Validation rejects a
rule that both sends to the host and short-circuits.

**Changing a status also fixes the reason phrase.** mitmproxy keeps whatever the upstream sent, so
setting only the code produces replies like `503 Temporary Redirect` — the number and the words
beside it disagreeing, in a tool whose entire job is saying what actually happened. An unrecognised
code gets an empty phrase rather than a wrong one.

### Delays must never block

mitmproxy runs **one asyncio event loop for every connection it is proxying**. A `time.sleep()` in
a hook freezes every unrelated call in flight for the duration. Delays are therefore returned from
the engine as a number and awaited with `asyncio.sleep()` in an `async def` hook.

`test_interception.py`'s `ConcurrencyTest` pins this, and it was verified live: four concurrent
requests through a 3,000 ms delay rule each completed in ~3.13 s, not 12 s.

The engine itself **never sleeps** — `test_delay_is_returned_not_slept` asserts that too, so the
property survives someone "simplifying" the verdict away.

### Delay is not the same as a timeout

Three distinct faults, three actions:

| Action | What the client sees | Tests |
|---|---|---|
| `DELAY_REQUEST` | Slow but successful | Read timeout, spinners, retry, circuit breaker |
| `ABORT_REQUEST` | Connection killed immediately | Connection failure, error handling |
| *(not built)* `HANG_REQUEST` | Nothing, ever | True socket timeout, cancellation |

`HANG_REQUEST` is deliberately left out: holding connections open indefinitely needs a cap and a
reaper of its own, and it is the least common of the three.

### JSON field paths

A deliberate **subset** of JSONPath, implemented in pure Python: dotted segments, `[0]` indexes,
`[*]` for every element.

```
currency
itinerary.seatsRemaining
segments[0].cabin
segments[*].cabin
```

Full JSONPath would mean a dependency, and the proxy runs a stock `mitmproxy/mitmproxy` image with
bind-mounted scripts and no pip step — owning a custom image is a bigger decision than this needs.
`RuleValidator.isValidPath` and `interception.py`'s `_parse_path` accept the same grammar and are
kept in step by `RuleValidatorTest.acceptsTheDottedPathSubsetTheEngineImplements`.

A body with no matching path is returned **byte-identical**, never re-serialised — so a 5.9 MB
payload that no rule actually changed is not reformatted for nothing.

## Breakpoints — pausing a call

`PAUSE_RESPONSE` forwards the request, waits for the real upstream answer, then holds it while you
decide. `PAUSE_REQUEST` holds before forwarding. Either way the caller's socket stays open.

```
proxy                                  backend                      frontend
  |-- POST /interception/paused ------->|                               |
  |                                     |-- WebSocket "paused" -------->|
  |-- GET .../decision?waitMs= -------->|  (long poll, held open)  user edits + releases
  |<------------- decision -------------|<--- POST .../decision --------|
  |   apply + continue                  |                               |
```

Long-polling rather than a listener on the proxy side: the addon process has no HTTP server, and
giving it one means a port and a new attack surface on every request path. Only a paused flow ever
polls, so nothing costs anything when nothing is paused.

**This is the one place the proxy waits on the backend, and that is the feature, not a cost** — the
user asked for the call to stop. The properties that still hold: only paused flows wait, waiting
never blocks another connection (the poll runs in the loop's executor), and **a call can never wait
forever**.

### The timeout is a grace period to NOTICE, not a deadline to DECIDE

Press **Take control** on a paused call and the countdown stops. From then on the call waits for an
explicit decision — send, send edited, or abort — however long that takes.

This distinction is the whole point. A 30-second timer is the right amount of time for somebody to
notice a call is waiting; it is nowhere near enough to read a 200 KB response and work out what to
change. Without this, editing a large body is a race against a clock, and losing the race releases
the call out from under you mid-keystroke.

Any edit claims the call automatically — typing into the body or the status is proof enough that
somebody is at the screen, so you never have to remember to press the button first.

Mechanically: the backend marks the call held and hands the waiting proxy a `{"action":"hold"}`
**immediately**, rather than letting it find out on its next poll. Until the proxy knows, it is
still counting down against its own deadline, and that gap is exactly where a call would be
released while somebody was typing into it. A held call is skipped by the expiry sweep, and the UI
switches from amber counting down to cyan counting up, because a held call is not urgent — nothing
is expiring.

**There is still an outer backstop.** "Until you decide" is the behaviour, but a browser tab closed
on a held call would otherwise pin a real client socket open with nobody left to answer it. Both
sides enforce the same one-hour ceiling (`alfred.interception.max-held-ms` /
`INTERCEPTION_MAX_HELD_SECONDS`) — far beyond any interactive session, and stated in the UI rather
than hidden.

Verified live: a rule with a **10-second** timeout, control taken at 4 s, decided at **28 s**. The
caller received the edited `418` after 28.8 s. Without taking control it would have been released
unchanged at 10 s.

### A breakpoint nobody notices still has a timeout and a default action

A paused call nobody answers would hold a real client socket open indefinitely. So:

- The rule carries `timeoutSeconds` (1–300) and `onTimeout` (`release` / `abort`); validation
  rejects a pause without one.
- The **proxy** enforces it — the authority, because it owns the socket.
- `BreakpointService.expire()` sweeps the registry a second later, so the inspector stops offering a
  decision about a caller that has already moved on. A stale row is worse than a missing one.
- If the backend is unreachable, the proxy applies `onTimeout` immediately rather than holding for
  nothing.

### Editing a paused call

Status, body **and headers** are all editable while a call is held, plus a paste-everything box
for a change too structural to make row by row.

**The body arrives pretty-printed**, JSON or XML, with line numbers, a Find box and an
Inspect mode that is literally the call cards' `JsonFlatViewComponent` - same tokenizer, same
highlighting. Format/Minify are there for both formats; a body that is neither is left exactly
as it came.

Crucially, **formatting is not an edit**. `normalizeBody` compares the two sides in normalised
form, so re-indenting a payload to read it leaves the call untouched and "Send unchanged" still
puts the supplier's original bytes on the wire. Once a value really changes, what is on screen is
what is sent - whitespace included, which for a *signed* SOAP envelope is the difference between
a valid signature and a broken one. The footer says which of the two you are about to do.

A release carries **only what changed**. Headers are a patch: a null VALUE removes that header, an
absent key leaves it alone (`apply_decision`). Sending the whole set would rewrite forty headers
to change one, and would stop "send unchanged" being byte-identical to never having paused.
"Replace everything at once" is the deliberate exception - anything its JSON omits is *removed*,
which the control says out loud.

A removed header stays on screen struck through rather than vanishing, so "did I delete
content-type, or was it never there" stays answerable while a real socket is held open.

**The edit that claims the call must survive the claim.** Editing takes control, taking control
re-fetches the list, and the same call comes back as a new object - so an effect keyed on object
identity threw away the very first edit every time, and only a second one survived. It is keyed
on `callId` now, with a regression test that fails if that is undone.

### Following a call through its whole cycle

A card outlives the half it was paused on. Releasing a request used to delete the row instantly,
so you never saw what came back — the one thing you paused the call to find out.

| Stage | Holds a caller? | Countdown? | In the tab badge? |
|---|---|---|---|
| `holding` | yes | yes, until you take control | **yes** |
| `in-flight` | no — it is on its way upstream | no | no |
| `finished` | no | no | no |

**Only `holding` counts.** `pausedCount` is the number of open client sockets, not the length of
the list. One number covering all three would have the badge shouting about calls nobody is
waiting on, and a badge that cries wolf is a badge you learn to ignore.

**Keeping the card is unconditional. Stopping twice is a checkbox.** Not closing the moment you
press Send is the behaviour that was asked for, so it is not behind a toggle. *Stop again when the
answer arrives* adds `follow: true` to the decision; the proxy remembers it on the flow
(`note_decision`) and pauses the response half itself (`follow_pause`) with the rule's own
timeout. No rule declared that pause — a person did, at the moment they released the request.
Validation still forbids one RULE holding both halves, which is a static contradiction; stopping
twice in sequence because somebody asked each time is a different thing.

**A card is left only by a decision a person made.** `PauseDecision.isFromUser()` — a timeout, an
unreachable backend or a dead registration deletes the row exactly as before. A rule that pauses
everything times out dozens of calls on busy traffic, and a card for each would bury the one being
worked on under the ones nobody ever saw. "Release all unchanged" also leaves nothing behind:
clearing the screen is what that button is for.

**Ordering within `decide()` is load-bearing.** The proxy posts `/resolved` the instant it stops
waiting, on another thread, and `resolved()` still deletes a row that is `holding`. So the stage
is advanced *before* the decision is handed over; otherwise there is a window in which the proxy's
own `/resolved` deletes the card being created. If the handoff then finds nobody parked, the row
is restored exactly as it was rather than left claiming a release that never happened.

The finished card shows **the request as Alfred actually sent it and the response the caller
actually received**, plus a per-half summary of what you changed — **header names only, never
values**, the same rule the redaction records follow. Both halves render through the call cards'
own tokenizer, so reading one gets the same colouring, line numbers and search as editing one.

Backstops: an `in-flight` card whose answer never arrives is marked `never-came-back` after the
same hour-long ceiling (a killed flow is caught earlier, by the `error` hook, as `failed`); and
finished cards are capped at 20, oldest dropped. Losing them all on a reload is correct for the
same reason the registry is in memory — and the call itself is in the call log regardless.

Verified live: a request paused, released edited with *stop again* ticked, the same card came back
on its response half holding again with `requestEdit: "header x-alfred-follow, body"`, released at
418, and the caller received `{"alfred":"followed the whole cycle"}` after 10.8s. Unticked, the
same rule filled the response into the card and finished it in 235 ms without stopping. Closing a
card that still holds a caller is refused with **409** — dismissing it would orphan a live socket.

### The paused registry is in-memory on purpose

A paused call is a live socket on a machine that is still running. Recovering one from disk after a
restart would offer a decision about traffic whose caller timed out long ago, and whose proxy has
already applied its own timeout. Losing the registry on restart is the correct behaviour, not data
loss.

### Both versions are kept

When a half is released **edited**, the call log records both ends of the change — see
[Before and after](#before-and-after) below, which is the same mechanism a rule's edit goes
through. Without it, editing a response quietly turns Alfred's log into fiction, which is the one
thing a traffic logger must never do.

Verified live: caller saw `599` / `EDITED-BY-ALFRED`, the log recorded `finalResponse.status: 599`
alongside `originalResponse.status: 307`.

## Turning one action off without deleting it

Every `RuleAction` carries `enabled` (default true — this is a field you turn *off*, not on, so
every rule saved before it existed keeps working). A disabled action stays in the rule, still
fully editable, and is still validated on its own fields — it must be well-formed the moment
somebody switches it back on. What it does *not* do is run: `proxy/interception.py`'s
`_prepare_actions` drops it at rule-load time, the same place a malformed action is already
dropped, so nothing downstream has to know disabling exists at all.

**Disabling an `IF_REQUEST`/`IF_RESPONSE` disables its whole subtree** — its branches are never
even parsed, so there is nothing nested left to separately skip. A nested action's *own* `enabled`
field is untouched by an ancestor being switched off, though: the rule editor dims it to say "not
running right now," not "reset," so whatever you set it to survives for whenever the condition
comes back on.

The mutual-exclusion checks in `RuleValidator` — two terminal actions, a terminal and a pause —
**only count enabled actions.** This is the reason the feature exists: without it, disabling one
of two conflicting actions to try the other would still be refused for a conflict that, with one
of them off, no longer exists. `pauses(rule)`/`terminal(rule)` on the frontend's rule list follow
the same rule, so the **"holds the caller"** banner only fires for a pause that is actually live.

Verified live: a rule with a disabled `ABORT_REQUEST` next to an enabled `MOCK_RESPONSE` — which
would have been rejected as two terminal actions — saved cleanly, and the caller received the
mocked `418` rather than being aborted. A disabled `IF_REQUEST` with both a matching branch and an
`ELSE` produced neither the branch's header nor the else's, on real traffic through the proxy.

## Dragging an action between scopes

Every action list in a rule — both pipeline lanes, every branch's `then`, every `ELSE` — is a
connected Angular CDK drop target at once, so an action can move from top-level into a condition,
out of one, or from one branch straight into another. A drag handle (⠿), not the whole card: the
card already holds buttons and typed fields, and making the entire surface a drag source is
exactly what fought text selection in the interception diff panel two features earlier.

A move is always expressed as **removing the action from its own path, then inserting it at the
destination** — the same operation whether the two ends are the same list (a reorder) or different
ones (a move across scopes). Two things this uncovered:

- **Removing an earlier top-level action shifts every later one down by one.** The destination's
  list-path id is rendered against the tree as it stood before the drop, so dragging a top-level
  action into a *later* top-level action's own branch left the destination pointing at the wrong
  index after the removal — found by a test, not a click.
- **The id encoding for a list path joined indices with `-`, and the ELSE index IS `-1`** — so
  `[0, -1]` and `[0, 0, 1]` both produced `"0--1"`, an ambiguous string. It joins with `,` instead.

`cdkDropListEnterPredicate` rejects a drop before it happens rather than after saving fails: a
scope only accepts an action of its own phase, and no deeper than the two levels of nesting the
backend allows — the same `nestableTypes` check the "+" buttons already use for adding a *new*
action. It does not recheck the depth of what is *inside* a dragged conditional; that rare edge
case is left to the save-time validator, which is authoritative regardless.

Verified: 15 tests exercise every scope combination (reorder, top-level into a branch, a branch
back to top-level, branch to branch, into the ELSE) and the phase/depth predicate, catching both
bugs above before they reached a browser. Live in the running app, every drop list renders with
the correct connected id (`top:request`, `top:response`, `list:1,0`, `list:1,-1`, …) and every
draggable card has its handle attached.

### Three more bugs, all of which made the drag *look* like it did nothing

**The cards were never actually in a drop list at all.** Every action card was rendered from one
`<ng-template #actionCard>` declared at the root of the rule editor and stamped out with
`*ngTemplateOutlet`. An embedded view resolves DI against the place its template was **declared**,
not the place it was inserted — and CDK wires a drag to its list purely through DI (`CdkDrag`
injects `CDK_DROP_LIST` and calls `addItem()` on it; there is no content query). Declared at the
root, the template had no `cdkDropList` ancestor, so every card silently became a CDK **free
drag**: it followed the pointer, stayed wherever it was released, produced no placeholder, shoved
no siblings aside, and never fired `cdkDropListDropped`. Measured live: `dropContainer` null and
the lane's list holding 0 items. Fixed by making the card a real component
(`RuleActionCardComponent`) with `cdkDrag` applied at the **usage site**, lexically inside each
list — the same shape the session-cycle call list has always used (`<app-call-card cdkDrag>` with
its handle inside the card's own template). A component's view resolves DI up through its host, so
the handle still finds its drag. Post-fix: `dropContainer` = `top:response`, list item count 1,
handle count 1.

**A nested `then` list could never be dropped into.** CDK measures each drop list once, when the
drag starts, then hit-tests the pointer against that stored rectangle. A condition's `then` list
lives inside a condition card, which is itself an item of the lane being sorted — so the moment
CDK shuffled the lane to open a gap, it slid the condition card and the drop zone inside it away
from the rectangle CDK had stored. CDK then hit-tested the stale position, found the "+ Add"
buttons sitting there, and refused to enter. Measured: pointer dead centre in the zone,
`enterPredicate` true, `_canReceive` still false because `elementFromPoint` returned a button.
Fixed by re-measuring every drop zone in the dialog on `cdkDragMoved` (`onDragMoved`). Verified
live afterwards, both directions: top level → branch, and branch → back out to the lane.

**The dialog centred itself with `transform: translate(-50%, -50%)`**, unlike every other dialog
here, which centres with flexbox on `.dialog-backdrop`. A `transform` makes that element the
*containing block* for any `position: fixed` descendant (CSS spec), and CDK's dragged-card preview
is `position: fixed` on the assumption that means the viewport. Centred with `inset: 0; margin:
auto;` instead.

Verified live with a real pointer-event sequence rather than by inspection: mid-drag there is one
preview, one placeholder, and the other cards translate out of the way to open the gap; on drop
the event reports `previousIndex → currentIndex`, the underlying `actions()` really reorders, and
no element is left holding a stray `transform`. One trap worth knowing if you ever script this:
CDK discards a `mousedown` whose `buttons` is 0, or whose `detail`/`screenX`/`screenY` are all 0,
as a screen-reader synthetic click — a hand-rolled `new MouseEvent('mousedown')` hits both and the
drag silently never starts.

## Rule precedence

All matching rules apply, **ascending by `priority`**, ties broken by stored order (what the UI
lists). A rule does not consume a call — "delay this supplier" and "tag every call from this
project" are two independent intentions about the same request.

- **Delays sum** across rules. A later rule silently cancelling an earlier one's delay is the
  surprising reading; the total is clamped at `MAX_DELAY_MS` (120 s).
- `ABORT_REQUEST` and `MOCK_RESPONSE` **end the request phase** — there is no upstream request left
  for a later rule to modify.
- `stopProcessing` on a rule halts evaluation after it.
- A rule that throws is **skipped, never fatal**. Proxying must survive a bad rule.

Validation rejects contradictions up front: two terminal actions in one rule, a terminal action
combined with a pause, or two pauses.

## Moving rules around — export, duplicate, import

A rule is a piece of work: a match, a condition tree, a set of actions. It used to exist only
inside one deployment's database.

**The export unit is `InterceptionRuleDraft` — exactly what `POST /rules` accepts.** That is the
load-bearing choice: importing is *creating*, so the whole existing `RuleValidator` runs against
an imported rule with no second code path to drift from it. A rules file is executable — it can
hold callers open, abort connections and rewrite bodies on live traffic — and it must not reach
the engine by a route the editor does not also use.

```json
{ "alfredInterceptionRules": 1, "exportedAt": "…", "rules": [ … ] }
```

- **No `id`, `createdAt` or `updatedAt`.** Carrying an id raises "does importing overwrite the rule
  with that id?", and both answers are bad: yes silently destroys work, no makes the field a lie.
- `alfredInterceptionRules` is version **and** fingerprint. A calls export is also a `.json`;
  feeding one to this importer says so by name rather than half-working through the wrong shape.
- **The master switch is never in the file.** It is a property of a deployment, not of a rule, and
  no file should be able to turn interception on.
- `enabled` **is** written, so the file is a faithful record. Forcing it off is the *importer's*
  job — the file describes, the import is safe.

### Duplicate

Copies the rule under `… (copy)` / `(copy 2)` (counted, so copying a copy continues the series
rather than nesting), keeps its priority so it lands next to the original, **keeps its enabled
state**, and opens the editor on the copy — nobody duplicates a rule to keep two identical ones.
Note the consequence on a rule that delays or pauses: two enabled copies act twice, which is why
the list marks a pausing rule `holds the caller`.

### Import

`POST /interception/rules/import` takes `{rules[], enable}` and is a batch for a reason that is not
convenience: each individual create persists, republishes the whole snapshot to the proxy and
pushes a WebSocket event that makes every open page refetch the list. A twenty-rule file would do
all three twenty times. This does them **once**.

- **Everything arrives disabled** unless `enable` is explicitly true, and the dialog's checkbox is
  off by default. A `PAUSE_REQUEST` rule arriving enabled could be holding a real caller a second
  after the click — the one outcome you cannot undo by reading it first.
- **Imported rules go after everything already here**, renumbered from the highest existing
  priority upwards, keeping their order from the file. The file's priorities were relative to the
  deployment it came from; interleaving them would silently change when existing rules run.
- **A bad rule does not cancel the good ones.** Each is validated on its own and the result names
  every rejection with the validator's own words (`{index, name, status, id?, problems[]}`).
  Discarding nine working rules over a tenth is the worse failure — and so is a quiet partial
  import, which is why nothing is summarised to a count.
- **No merge by id or by name.** Import always creates. Replacing a rule is import-then-delete:
  two visible steps beat one invisible one.

The dialog previews the file **before** anything is created — match, actions, and which rules can
hold a caller, called out above the list rather than found by scrolling.

Verified live: a real rule exported and re-imported came back identical on name, description,
match, actions and `stopProcessing` with a fresh id; a file of three rules (one valid, one
duplicate-of-existing, one malformed) imported 2 and rejected 1 with both of its problems listed;
imported rules landed at priority 110/120, disabled, while the proxy snapshot still contained only
the one enabled rule. Duplicating an enabled rule produced an enabled `(copy 2)` — `(copy)` being
taken — next to its original.

> Found while testing this live: a rule in the file with no `match` at all threw out of
> `describeMatch` inside the preview's computed, and the throw took the *entire dialog's*
> rendering with it — a blank panel at exactly the moment you need to read an untrusted file. The
> preview now treats every field as missing-until-proven-present.

## API

| Method | Path | |
|---|---|---|
| `GET` / `POST` | `/interception/rules` | list / create |
| `GET` / `PUT` / `DELETE` | `/interception/rules/{id}` | |
| `POST` | `/interception/rules/{id}/enabled` | |
| `POST` | `/interception/rules/reorder` | renumbers priorities from an id order |
| `POST` | `/interception/rules/import` | creates every rule in a file that can be created; reports on each |
| `GET` / `POST` | `/interception/enabled` | the master switch |
| `GET` | `/interception/action-types` | what the UI's action picker is built from |
| `POST` | `/interception/paused` | proxy registers a held call |
| `GET` | `/interception/paused` | frontend lists them |
| `GET` | `/interception/paused/{id}/decision?waitMs=` | proxy long-polls; `204` = nothing yet |
| `POST` | `/interception/paused/{id}/control` | stop the countdown, hold until decided |
| `POST` | `/interception/paused/{id}/decision` | the user's decision |
| `POST` | `/interception/paused/release-all` | let everything go, untouched |
| `POST` | `/interception/paused/{id}/resolved` | proxy stopped waiting (drops the row only if still `holding`) |
| `POST` | `/interception/paused/{id}/completed` | proxy reports the end of a followed cycle |
| `DELETE` | `/interception/paused/{id}` | close one card; **409** while it still holds a caller |
| `POST` | `/interception/paused/close-finished` | close every finished card |

A rejected rule returns **400 with every problem at once** (`{error, problems[]}`), not the first —
a rule form has many fields and fixing them one round trip at a time is the frustrating version.

WebSocket `/ws/interception` carries two payload-free events, `interception-rules-changed` and
`interception-paused-changed`. They are distinct because a busy breakpoint pushes several a second,
and treating those as a rules change would refetch the rule list constantly for a list that has not
changed.

## Logging integration

An interception record rides on the **existing** completion webhook as `interception`, and is
stored as one nullable JSON column on `call_metadata`. It therefore inherits the call's id, session
id and operation id for free — a parallel event stream would have to be joined back to the traffic
it describes.

**A record never stores a secret.** `detail` names *what* changed, never the value: a rule that
rewrote `authorization` records the header name only. Enforced at the source
(`interception.py`'s `SENSITIVE_HEADERS`), and it matters because this text is echoed verbatim into
every `.md`/`.html` export — the same constraint `redaction.model.ts` documents.

`interception` is **null** for every call no rule touched, so an ordinary call's stored shape is
unchanged by this feature existing.

### Before and after

A record carries up to four snapshots — `originalRequest`/`finalRequest` and
`originalResponse`/`finalResponse` — each a `{status, reason, method, url, headers, body}`. They
are what the UI's before/after panel diffs.

**No action captures them.** The engine snapshots a half once, the moment a rule first matches and
before any action has run, snapshots it again when the phase is completely finished — rules,
delay, breakpoint, hand edit — and records both ends only if the two differ
(`Verdict.observe_*` / `Verdict.finalize_*`). Three consequences are the point of doing it this
way:

- **A new action gets before/after for free.** Whatever it mutates on the flow, the closing
  snapshot sees. The earlier design had each action announce its own intent, which worked and
  meant every future action had to remember to, with a silently missing before/after as the
  penalty for forgetting. It also cost a real bug: the response-phase verdict's snapshots were
  dropped by the addon, so *no* response action ever produced a before/after.
- **An action that changes nothing records nothing.** A delay, or a header set to the value it
  already had, stores no snapshots — so an export does not double in size for a call nobody
  really touched.
- **A mocked response is one-sided, not a diff.** No upstream answer was ever seen, so
  `originalResponse` is absent and only `finalResponse` is written; the UI says the host was never
  contacted rather than pretending it answered and we changed the answer. Stated structurally —
  "a response exists at the end of the request phase" — so anything else that answers early is
  reported the same way without naming `MOCK_RESPONSE`.

The **request** half cannot use the call log as its "after": the log is written at `prepare` time,
before the request is forwarded and therefore before a breakpoint lets anyone edit it. Keeping
both ends in the record makes it self-contained and independent of when the log was written.

Cost: one body string and one header dict, only on a call a rule already matched. Traffic no rule
matches never reaches the snapshot.

### Reading the panel — pretty-printed, coloured, searchable, copyable

`toLines` used to reformat **JSON only** (`trimmed.startsWith('{')`), so a one-value change inside
a SOAP envelope was two vast, visually identical lines and you diffed it by eye. Both sides now go
through `formatBody`, which handles JSON *and* XML, and each line carries the same tokens the call
cards render — so an envelope in this panel looks exactly like the one on the card above it.

- **One kind for both sides** (`sharedBodyKind`, preferring the newer half). If each side chose its
  own formatter, a JSON body replaced by an HTML error page would also report every line of the
  JSON as reformatted. A side that cannot be formatted as that kind is left raw.
- **Tokens are attached to lines by index**, from a separate split of the same string. If the two
  splits ever disagree on line count the tokens are dropped for that side — colours one line out
  of step with the text they colour is worse on a diff than no colours, and silently so. Guarded
  by a test that reassembles every coloured line back to its own text.
- **Search covers the headers and the body of the view on screen**, numbered in reading order, and
  is scoped by the toolbar's `in: All · Headers · Body`. Request versus response needs no control:
  each half already has its own panel instance. The renumbering happens *after* the two sides are
  interleaved — each is tokenized separately and would otherwise start its own count at zero, so
  "3 of 7" would point at two different places.
- **Copy is per section**: `copy: Request|Response|Diff · Headers · Body`. The first button is
  named after what it takes, which is how "copy the request only" is expressed. It includes the
  status change, because on most of these panels that is the headline; a single *section* is
  copied without the surrounding labels, since copying just a body is almost always in order to
  replay it. The button that copied is the one that confirms.

### Diffing a large body without giving up and marking it all changed

`diffLines`' LCS table is O(n·m), so it is bounded (`MAX_DIFF_LINES`) — past the bound the old code
gave up entirely and returned the *whole* before side marked removed, then the *whole* after side
marked added, concatenated. That fallback is truthful (nothing it claims changed is wrong) but
useless the moment it fires on a real edit: **one field changed in a 3,684-line intercepted
response rendered the entire body, twice over, as one giant deletion followed by one giant
addition** — because the untouched body was well past the bound, and the bound's fallback has no
concept of "mostly the same."

The fix is to never hand the O(n·m) part more than it needs. Real edits — one JSON value, one
renamed key, one header — change a handful of lines inside a body that is otherwise
byte-identical top and bottom. `diffLines` now strips the **common prefix and common suffix**
before touching the LCS table at all, so "diff two 3,684-line arrays" becomes "diff the one or two
lines around the actual edit." The expensive bound still exists and still fires — honestly and
correctly — when the *middle* itself is too big to diff cheaply, which only happens when most of
the body genuinely did change; that case has no better answer than "show it all," and now it is
the true answer instead of the size bound's forced one.

Verified against the exact real call this was found on — a 1,228-journey `FlightSearch/Search`
response, 215 KB original vs 254 KB final, one field edited by hand in the paused-calls inspector.
Before the fix the panel reported roughly 7,368 lines (the whole body, twice). After: **3,685
lines, 3,683 same, 1 removed, 1 added** — the removed/added pair being exactly the field that was
actually edited (a segment key renamed from `QRs7?QRs6` to `QRs7s`), nothing else in the body
touched. Confirmed via the panel's own Copy Body button against the live record, not a synthetic
fixture.

### Windowing it

The panel built **every line of both halves** into a 340px box that shows about eighteen — and
since each line became one DOM node per *token*, a large response cost tens of thousands of nodes
to display a couple of dozen rows. A call can have both panels expanded, paying it twice.

It windows past `PANEL_WINDOW_THRESHOLD` (600 lines), lower than the flat view's 2,000 because
this box is a fifth the height and there are two of them. The mechanism is the flat view's minus
its offset table: every row here is the same height (no comment cards, no composer), so the
arithmetic is a multiplication. `ROW_HEIGHT_PX` is pinned in CSS *and* in the component — change
one and you must change the other.

Two consequences that are easy to get wrong:

- **Highlighting had to become lazy as well.** Windowing the DOM alone would not have helped: the
  search built highlight tokens for every line on every keystroke. Counting stays a full pass
  (one `indexOf` per line — the total must be truthful), and only the visible rows have their
  tokens built, each told the global number of its first match.
- **Jump-to-match cannot query the DOM.** It used to find `mark.hl.active` and scroll to it; once
  a row may never have been built that returns nothing. It resolves match number → line → offset
  instead (`lineOfMatch`). The flat view carries a comment recording the same lesson.

The old `MAX_COLOURED_LINES` cap is gone with it: it existed because colour costs a node per token
*and the panel rendered everything*, and windowing removes the second half of that.

Measured live on a 4,507-line / 90 KB intercepted response: **27 rows built, 181 DOM nodes added,
76 ms to expand**; typing in the find box cost **11–18 ms per keystroke** while correctly reporting
**500 matches**, of which 2 were rendered. Scrolling 40,000 px moved the window without growing the
DOM (979 nodes before and after); jumping to match 401 of 500 scrolled to a row that had never
been built and put it on screen. Copy still works off the full data, not the rendered rows — the
body button produced all 4,507 lines.

> The `lineOfMatch` binary search shipped with only an upper bound, so a match number belonging to
> the *headers* — which are numbered before the body — resolved to body line 0 and scrolled for a
> match that was never there. Caught by a test written for the offset case.

**A second bug shipped with the windowing itself: scrolling never stopped where you released it.**
The top spacer's height changes on every `scroll` event — it is `range().start * ROW_HEIGHT_PX`,
recomputed from the new `scrollTop` — and that resize happens *above* the current viewport, which
is exactly what CSS scroll anchoring watches for. The browser nudges `scrollTop` to keep the
visible rows from jumping; that nudge resizes the spacer again; which gets compensated again — a
feedback loop with no natural floor, accelerating because each correction is bigger than the last.

Measured live: a 5-tick wheel scroll (a plain ~500 px nudge, confirmed by disabling anchoring and
re-measuring the identical gesture) opened the loop and landed at `scrollTop` 85,310 — effectively
the very bottom of an 85,600 px body — in well under a second, with no further input. The
pre-existing flat view, windowed the same way, did **not** reproduce this under the identical
gesture; the difference was never isolated, but the fix needed no theory about why one was
affected and the other wasn't. `overflow-anchor: none` on `.intercept-body` opts the scroller out
of the anchoring node search entirely — the standard fix for a virtualized list with spacers on
both ends — and the same gesture now settles at exactly 500, then 1,500 after a further 10 ticks,
proportional and stable. A Karma test can't drive a real wheel gesture to re-run the loop, so the
regression guard only asserts the computed style, which at least catches the fix being reverted.

Verified live through the proxy: a JSON response edited by a rule rendered 16 pretty-printed lines
with 22 coloured spans resolving to the theme's own `--tok-*` (key `rgb(196,181,253)` =
`#c4b5fd`); searching `a` found 22 matches across 10 in the headers and 12 in the body under one
continuous numbering, stepping and wrapping correctly with exactly one active mark; Copy produced
the status line, marked headers and marked body. The same rule returning a SOAP envelope rendered
10 indented lines with 24 tag / 6 attribute / 8 value spans — one enormous line before this.

> A pre-existing test leak surfaced while writing this: `clipboard.spec.ts` replaced the global
> `navigator.clipboard` and never restored it, so whichever spec Karma happened to run next
> inherited it — failing intermittently on nothing but spec order. It restores it now.

## Safety

- **Off by default.** A feature that can change live traffic is never on because nobody said
  otherwise.
- **Master switch** separate from each rule's own `enabled`, so "turn all off" does not lose which
  rules you had on.
- The UI banner is **always rendered**, not only when active — a warning that appears only when the
  answer is "yes" trains people not to look for it.
- The **paused count sits in the tab bar**, visible from every screen. If a rule is holding
  somebody's connection open you need to know that from wherever you are standing.
- Rules that can pause are called out separately in the banner and marked `holds the caller` in the
  list.

## Backward compatibility

**An older proxy reading a newer rules file skips a conditional entirely** - unknown action types
are already skipped rather than guessed at. So during a partial deploy (backend updated, proxy
container not yet restarted) a conditional rule does nothing, rather than doing something wrong.
Note that the proxy caches the module at import: editing `interception.py` needs a container
restart, not just a file change.


With no rules file, an empty rules list, or the master switch off, both addons return an inert
verdict after one dict lookup. Nothing else changes: same forwarding, same two-phase logging, same
ids, same API shapes, same frontend.

Pinned by `test_interception.py`'s `test_missing_rules_file_is_inert_not_an_error`,
`test_master_switch_off_disables_every_rule` and `test_corrupt_rules_file_disables_rather_than_crashes`,
and by `aCallNoRuleTouchedCarriesNoInterceptionRecordAtAll`.

## Tests

| Where | What |
|---|---|
| `proxy/test_interception.py` | 52 tests: matching, every action, the SEND_TO_HOST latch, JSON paths, decisions, **concurrency** |
| `backend-interception` | 61 tests: validation, service, breakpoint rendezvous, take-control, expiry, publishing |
| `backend-calls` | interception persists and round-trips; an untouched call stores nothing |
| `frontend` | model helpers, state service, the paused inspector's decision payloads and take-control |

Run the proxy engine's tests with:

```bash
cd proxy && python -m unittest test_interception -v
```

## Extending

### Adding an action

1. Add the constant to `ActionType` (Java) — the enum **is** the wire format, so the name must match
   what the engine looks for. Put it in the right `Phase`: that is what decides which lane of the
   editor's pipeline it appears in. (`MOCK_RESPONSE` is a REQUEST-phase action despite its name.)
2. Add its required-field check to `RuleValidator.validateAction`.
3. Handle it in `interception.py`'s `_apply_request_action` or `_apply_response_action`, and add it
   to `REQUEST_ACTIONS` / `RESPONSE_ACTIONS`.
4. Add a label to `ACTION_LABELS` and a field row to `rule-editor.component.html`.
5. Add defaults to `defaultsFor()` so a freshly added action is already valid.
6. If it needs a condition, nothing to do - conditions are generic and work with any action of
   the right phase.
7. If it takes a status, use `StatusPickerComponent`, never a number input - the thing a user
   knows is "service unavailable", not that it is 503.
8. Add it to `EveryActionIsCoveredTest.SAMPLES` in `proxy/test_interception.py` — that suite walks
   `REQUEST_ACTIONS`/`RESPONSE_ACTIONS` themselves, so this is a failing build, not a checklist
   item you can miss.

The action picker reads `/interception/action-types`, so nothing needs a hardcoded list.

**Do not write any before/after code.** Capture is generic — see
[Before and after](#before-and-after). If the action mutates the flow, both ends are recorded; if
it does not, nothing is, and it belongs in that test's `NO_CHANGE` map with the reason.

### Adding a matcher

1. Add the field to `RuleMatch` (Java) and `interception.py`'s `Match.__init__`.
2. Add the check to `Match.matches`, **ordered by cost** — the cheap comparisons run first so a
   non-matching rule costs almost nothing.
3. Precompute anything expensive (like a compiled regex) in `__init__`, never per request.
4. Add the field to the editor and to `describeMatch`.

## Intentionally left for later

- **`HANG_REQUEST`** — see above.
- **Header / body / query matchers**, and response-status matching.
- **Full JSONPath**, which needs a custom proxy image.
- **"Try it"** — firing a test request from the rule editor and building actions from the real
  response, and **"save these edits as a rule"** from the paused inspector. Both are mocked in
  `mockups/interception-mock.html`; neither is built.
- **Per-rule hit counts** in the UI. The proxy reports a rule firing on the call webhook rather than
  writing back into the rules store on every request, so the counts have to be derived from logged
  calls.
- **`backend-internal-calls`** stores no interception record yet — inbound rules *apply* correctly,
  but the record does not appear on an inbound call's log entry. That slice has no SQLite adapter
  and its own flat-file shape; outbound (`backend-calls`) is complete.
