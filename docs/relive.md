# Relive Cycle

A Relive Cycle is a saved, ordered workflow of previously recorded calls that can be replayed
under control: which calls actually execute, whether each outbound child reaches the real
supplier (LIVE) or is answered by ALFRED from what was recorded (REPLAY), cycle-scoped variables
and rules, and a live execution timeline with differences against the original recording.
Everything it needs already exists elsewhere in ALFRED (recorded calls, parent/child correlation,
interception rules, resend, comparison/diff, WebSocket live updates) - this feature composes
those rather than duplicating them. Owned by `backend-relive` (leaf slice, see `docs/architecture.md`)
and the `/relive`, `/relive/:id` frontend routes.

## The call-rule model

A cycle is an ordered list of **steps** - one inbound step per correlated group (e.g. a browser
request into the app), each with zero or more **outbound children** (the app's own calls to
suppliers while handling it). Every step carries:

- `recording` (`FrozenCall`): the original call, frozen at add-time - method, url, headers, body,
  status, timestamp, duration. **Immutable.** Reset/rebuild always start from this, never from a
  live edit.
- `callRule` (`CycleRule`): ALFRED's existing rule document (match + actions), reused verbatim -
  the frontend renders it with the existing rule editor, the proxy evaluates it with the existing
  engine. This is the one thing that actually decides what happens to the call.

There is deliberately no separate `mode`/`ordinal`/`modified`/`checkpoint` field on a step - all
of those are **derived from `callRule`** by `shared/utils/relive-call-rule.ts` (`modeOf`,
`applyMode`, `checkpointOf`, `isModified`, `reachesHost`), so the frontend, the run engine and the
proxy can never disagree about what a step will do. `applyMode(rule, 'REPLAY'|'LIVE', recording)`
toggles/creates exactly three actions and never touches anything else the user added:

- **REPLAY**: `[user's request-edit actions…] → IF_REQUEST(MATCHES_RECORDED_CALL, else:
  MOCK_RESPONSE 502 {error}) → MOCK_RESPONSE(recording)`. The condition sits after the edit
  actions, so "does this differ from what was recorded" sees the *edited* request. Turning REPLAY
  off sets `enabled: false` on the mock rather than deleting it, so hand-edited mock data survives
  a later switch back.
- **LIVE**: `SEND_TO_HOST` (optionally with `REPLACE_RESPONSE` if the user wants to still fake the
  reply while genuinely contacting the supplier). `reachesHost()` walks `IF_REQUEST` branches too,
  so a rule that may forward on some branch still counts as reaching a real system for the safety
  UI (FR-015a).
- **Checkpoints**: `PAUSE_REQUEST`/`PAUSE_RESPONSE` actions, same as anywhere else in ALFRED -
  an inbound step's own checkpoint pauses in the run-view tab itself (nothing proxy-side to hold);
  an outbound child's checkpoint pauses in the proxy through the *existing* breakpoint/Paused-Calls
  pipeline, unchanged - `pauseAction()` always sets `onTimeout: 'abort'` regardless of Relive
  tagging, so there is no Relive-specific safety behavior to get wrong here, only labeling.

`MATCHES_RECORDED_CALL` (`docs/interception.md`) is a regular `IF_REQUEST` condition subject added
for this feature but usable anywhere: `{ answerId, ignore: [...] }` compares the request against a
recorded-request answer file byte for byte except the ignored paths/headers.

## Variable scopes

- `{{name}}` reads the shared global variable store, including its fallback value.
- `{{this.name}}` reads a value set or captured earlier in the same rule and call.
- `{{$.name}}` reads a variable defined in this Relive cycle or extracted during this run. Its
  current value is published with the run snapshot and is unavailable outside Relive.

Set Variable and Capture Variable actions in Relive call or cycle rules can choose **Relive**
scope. For example, capture `sessionId` from a login response, then use `{{$.sessionId}}` in a
later call of the same run. The action updates that run's variable timeline and does not change
the global variable store. These action names and step extraction names appear in suggestions
alongside variables from the Variables tab.

The rule editor suggests Relive variables only while editing a Relive cycle. The Variables tab
edits those definitions; the global variables drawer edits only shared variables.

A Relive-scope Set/Capture writes the value to the backend before the call goes on (so the other
proxy container sees it once the backend republishes the run), with a 1 s timeout: the one place a
proxied Relive call waits on the backend besides a pause. The same process keeps the value in a
local overlay at once, so later calls through that proxy never wait for the republish.

## Attribution: how a call is known to belong to a run

Decided entirely inside the mitmproxy addons, at request time, with no backend round trip
(the same invariant as global interception rules). Three sources, tried in order, each recorded
on the call as `attribution`:

1. **`HEADER`** (inbound, Automatic driver): the backend tags every step it resends with
   `X-Alfred-Relive: <runId>/<stepKey>` (trusted only from the backend's own peer address, popped
   before the application ever sees it or the call is logged).
2. **`OPERATION_ID`** (outbound): the same resend also sets `X-Operation-Id: relive-<runId>-<stepKey>`;
   if the application forwards `X-Operation-Id` on its own outbound calls (a convention ALFRED
   already reads elsewhere), the forward proxy attributes the child exactly.
3. **`INFLIGHT`** (outbound fallback): the backend publishes `relive/inflight.json` - the
   **inbound** calls in flight (never outbound ones: a supplier call in flight would otherwise
   "own" a sibling made at the same time), each with its project, run and step. The deepest
   in-flight step of one run owns the call; a call with no candidate is **`UNATTRIBUTED`** and
   the step's own pre-run choice applies (Block / Replay anyway / Send to the real system -
   default Block, FR-049a).

The proxy re-lists `relive/` at most once a second, but a run id named by the header or by
`inflight.json` that it has not loaded yet forces one rescan at once: a run starts and sends its
first step within milliseconds, and its first supplier call must already see it.

**Which child a call is**: the in-flight step's outbound children are compared with the live
request. A stored `SEMANTIC_V1` fingerprint (SHA-256 of method, scheme, host, path, query, the
headers the application set, and the canonical JSON/SOAP body; `RequestFingerprint` in Java and
`semantic_fingerprint_v1` in Python must agree byte for byte) picks the child whose recording is
the same request, in recorded order for repeats. When no fingerprint matches - the inbound request
was edited, or a field changed - the next same-URL child not matched yet in this execution takes
the call (endpoint + order, FR-014a), and that child's call rule decides through its
"request differs" condition. Calls past the recorded count are unexpected.

A call matching more than one run's criteria is `AMBIGUOUS` and blocked outright (FR-050a) rather
than guessed at.

**Guided driver**: inbound calls come from the user's own real browser, so there is no header to
trust. `proxy/relive.py`'s `apply_inbound` claims an untagged inbound call for a project only when
exactly one Guided run is active for it, and matches it (`guided_step_for`) to the next enabled
top-level step with the same method and path - the snapshot carries each step's
`recordedRequest` for this. The matched step's call rule applies (inbound REPLAY, request edits,
pauses), and the in-flight entry names that step, so its supplier calls replay exactly as in
Automatic. The same step performed again within 5 s (double-click, refresh) is a repeat, not the
next step. An inbound call matching no step is the run's but unexpected; its supplier calls fall
to the cycle's unexpected-call policy. The browser follows the step the proxy chose.

## Evaluation tiers

A request attributed to a run is evaluated in three tiers, in this order (`docs/interception.md`
has the full write-up, since it's a general concept, not Relive-specific):

1. **STEP** - the matched child's own `callRule`.
2. **CYCLE** - the cycle's own rules, by `priority`/order.
3. **GLOBAL** - the participating global rules (none / all / selected, per the cycle's setting).

Each applied rule is recorded with its tier; the step drawer's "Rules & variables" tab shows them
in order (`proxy/relive.py`'s `_rule_applications`, reading the existing `MATCHED_KEY` metadata
`interception.py` already sets - no engine change needed to know which tier fired).

## Held calls

A call rule's pause stops it part way. **Releasing it carries on with the rest of the rule** - the
engine resumes after the paused action - so a REPLAY child held at a "pause before" checkpoint is
still answered by its mock, never sent to the supplier. The run view decides held calls itself:

- **Request changed** (the "Ask me" pause in the request-differs branch, `at: CHANGED`): Replay
  recorded answer, Edit answer & replay, Send to real (second confirmation), Mock a failure. No
  decision is always the failure mock.
- **Pause before** (`at: BEFORE`): Continue, Skip (fails the call). No decision continues.
- **Pause after** (`at: AFTER`): Continue, Edit answer. No decision releases the answer.

The run's choice travels on the paused-call decision as `relive: REPLAY | ANSWER | FAIL |
SEND_REAL` (`relive.settle_request_pause`).

## Leases

The page driving a run holds its lease over `/ws/relive` and releases it (`{"type":"release"}`)
when the run ends or the page stops driving it. A run whose last holder is gone for 15 s is
interrupted; a run that already ended is never ended again.

## The snapshot

`backend-relive`'s `RunSnapshotBuilder` turns a running cycle's `definition` into
`proxy/interception/relive/<runId>.json` (`specs/003-relive-cycle/contracts/proxy-snapshot.md`),
published the same atomic way as `rules.json`; both addons read it through a cached loader in
`interception.py` (mtime checked at most once a second). It carries: driver, the participating
projects, cycle/global-rule selection, current variable values (secrets marked separately so the
addon never needs to guess what to mask), and every step's `callRule` and `mode` plus its
recorded-request answer file (for any `MATCHES_RECORDED_CALL` condition - if that file is missing
or unreadable the condition evaluates to "differs", never to a false match). Answer files are
named from the run, the step and the recorded request, so republishing writes nothing new. A mock
body over 64 KB is written as a stored answer and referenced with `ANSWER_WITH_FILE`, keeping the
snapshot - which the proxy parses on its event loop - small. The addon's only Relive-specific
logic left is attribution and step matching; everything else is the existing rule-evaluation
engine.

## Run history and the Live calls log

A run keeps a full snapshot of the cycle `definition` it executed - editing the cycle afterward
never changes a past run's own view of itself. `StepResult`s (state, mode, attribution, actual
request/response, differences, rules applied, variables used/produced) accumulate per attempt.
"Rules applied" is reported by the proxy when the call is prepared. It includes rules in tiers the
request phase never reached because a mock or a pause ended it. Those rules are listed only when
they have a response action, which still changes the answer.
The History tab (`relive-history` component) lists runs and can open one read-only in the same
timeline component the live run uses (`relive-run-timeline` is pure input/output - it never talks
to the run engine directly, so viewing a past run needs no separate component).

The **Live calls log** (`relive_live_calls` table, `LiveCallStorePort`) is a permanent record of
every call that actually reached a real system while a run was active (the proxy reports
`reached_upstream` with each run call's completion, after any pause was decided) - deliberately **never
pruned automatically** (FR-015b): each row is a real, already-paid-for supplier answer, and
silently deleting one would force a second real call just to see it again. Deleted only by the
user. "Use as recording" (`LiveCallsController`/`LiveCallsService`) replaces a step's frozen
recording (and its call rule's `MOCK_RESPONSE`, if it has one) with what the supplier actually
returned - through the same versioned cycle update every rebuild-style change uses (reason
`USE_LIVE_CALL`), so it's undoable via `versions/{v}/restore`.

## Troubleshooting

- **A REPLAY step answered 502 with `{"error": "..."}`** - its `MATCHES_RECORDED_CALL` condition
  decided the (possibly edit-modified) request differs from what was recorded. Check the step
  drawer's Compare tab for the actual diff, or its `ignore` list if the difference is expected
  noise (e.g. a timestamp field).
- **An outbound call the run should own shows as unattributed** - `OPERATION_ID` only works if the
  application forwards `X-Operation-Id`; without that, `INFLIGHT` needs the project to have
  *exactly one* in-flight inbound call. Two concurrent inbound calls into the same project during
  a run make every one of their children unattributable by design (FR-049a's per-step choice is
  the escape hatch, not a proxy-side guess).
- **A call that should be blocked went to the real supplier, or vice versa** - check the
  evaluation tier that actually fired (step drawer, "Rules & variables"); a CYCLE or GLOBAL rule
  can still act on a call after the STEP tier's own `callRule` already decided LIVE/REPLAY, since
  all three tiers apply independently (a REPLAY answer at tier 1 ends the request, so tier 3 can
  never reach a live supplier a step already replayed - but a LIVE step's headers/body can still be
  rewritten by a later tier).
- **A Guided run's inbound calls never show up in the timeline** - confirm it's still the *sole*
  active Guided run for that project; a second one makes every arrival ambiguous by the same rule
  that protects Automatic runs, and neither claims it.
- **The Live calls log keeps growing** - it's not pruned automatically. Delete individual rows, or
  use the bulk-delete offered once the log passes the configured size warning
  (`alfred.relive.live-calls.warn-bytes`, default 200 MB).
