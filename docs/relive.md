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
3. **`INFLIGHT`** (outbound fallback): the backend publishes `relive/inflight.json` - which
   project has an in-flight inbound call, and which run step it belongs to. An outbound call is
   attributed when its project has **exactly one** in-flight candidate; otherwise it is
   **`UNATTRIBUTED`** and the step's own pre-run choice applies (Block / Replay anyway / Send to
   the real system - default Block, FR-049a).

A call matching more than one run's criteria is `AMBIGUOUS` and blocked outright (FR-050a) rather
than guessed at.

**Guided driver**: inbound calls come from the user's own real browser, so there is no header to
trust. `proxy/relive.py`'s `apply_inbound` claims an untagged inbound call for a project only when
exactly one Guided run is active for it - the call is tagged `attribution: 'GUIDED', stepKey: null`
(still logged and broadcast over `/ws/relive` even though nothing is enforced on it rule-wise, so
the frontend has something to match). The frontend (`relive-run.service.ts`) matches each arriving
inbound call to the next expected top-level step by endpoint (method + host + pathname, the same
signature `relive-match.ts` pairs steps with): a match on a later step marks the ones in between
`SKIPPED`; no match at all is recorded as unexpected, the same bucket an unattributed Automatic
call falls into. Outbound children of a Guided step are attributed exactly like Automatic's own -
`INFLIGHT`/`OPERATION_ID` don't care which driver started the run.

## Evaluation tiers

A request attributed to a run is evaluated in three tiers, in this order (`docs/interception.md`
has the full write-up, since it's a general concept, not Relive-specific):

1. **STEP** - the matched child's own `callRule`.
2. **CYCLE** - the cycle's own rules, by `priority`/order.
3. **GLOBAL** - the participating global rules (none / all / selected, per the cycle's setting).

Each applied rule is recorded with its tier; the step drawer's "Rules & variables" tab shows them
in order (`proxy/relive.py`'s `_rule_applications`, reading the existing `MATCHED_KEY` metadata
`interception.py` already sets - no engine change needed to know which tier fired).

## The snapshot

`backend-relive`'s `RunSnapshotBuilder` turns a running cycle's `definition` into
`proxy/interception/relive/<runId>.json` (`specs/003-relive-cycle/contracts/proxy-snapshot.md`),
published the same atomic way as `rules.json`; both addons read it through a cached loader in
`interception.py` (mtime checked at most once a second). It carries: driver, the participating
projects, cycle/global-rule selection, current variable values (secrets marked separately so the
addon never needs to guess what to mask), and every step's `callRule` plus its recorded-request
answer file (for any `MATCHES_RECORDED_CALL` condition - if that file is missing or unreadable the
condition evaluates to "differs", never to a false match). The addon's only Relive-specific logic
left is attribution and step matching; everything else is the existing rule-evaluation engine.

## Run history and the Live calls log

A run keeps a full snapshot of the cycle `definition` it executed - editing the cycle afterward
never changes a past run's own view of itself. `StepResult`s (state, mode, attribution, actual
request/response, differences, rules applied, variables used/produced) accumulate per attempt.
The History tab (`relive-history` component) lists runs and can open one read-only in the same
timeline component the live run uses (`relive-run-timeline` is pure input/output - it never talks
to the run engine directly, so viewing a past run needs no separate component).

The **Live calls log** (`relive_live_calls` table, `LiveCallStorePort`) is a permanent record of
every call that actually reached a real system while a run was active - deliberately **never
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
