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

## Staying logged in: cookies, tokens and values passed between steps

A recording carries the session of the day it was made: a `JSESSIONID` cookie, a bearer token, a CSRF
token, a created id. Replayed as recorded, the steps after Login send yesterday's values and the app
answers "please log in". Three things keep a run going (`shared/utils/relive-session.ts`):

- **Cookie jar** (Automatic runs, cycle setting `carryCookies`, on by default). Before each top-level step
  is sent, `ReliveRunService.prepareSession` rebuilds the jar from the steps already settled - every
  `Set-Cookie` their responses carried, per host - and rewrites the step's `Cookie` header: held cookies
  replace the recorded ones, cleared ones (`Max-Age=0`, past `Expires`) are dropped, new ones are added.
  Rebuilt from results, never kept in memory, so a reattached page or a resumed run sends the same. A
  Guided run is the user's own browser, which keeps its own cookies.
- **Value swaps.** A step extraction may remember the value its recording had (`ExtractRule.recordedValue`).
  When the run's variable holds another value, every later step sends it wherever the recorded one
  appears - URL, headers, raw body, also URL-encoded - with no edit to those steps. The step result
  records what was swapped and carried (`editsApplied.session`), shown in the run view's Variables box.
- **Replay match.** The proxy's `MATCHES_RECORDED_CALL` test puts swapped values back before comparing
  (snapshot `swaps`), and with `replayIgnoresCredentials` (on by default) leaves out `Authorization`: a
  REPLAY supplier call whose only change is the token the app obtained itself is still replayed, never
  "request differs". It is still answered by ALFRED, so nothing reaches the supplier. A swapped variable
  republishes the snapshot like a variable a rule references.

The Steps tab's **Session** card (`relive-session-panel`) lists the values the recording handed from one
step to a later one (`relive-chains.ts` `detectStepChains`: response cookies, headers, JSON and XML
leaves found again in a later top-level request, searched as text) and "Use" adds the extraction with
its `recordedValue`. Editing an extraction's source or path re-reads `recordedValue` from the recording.
Extractions read JSON, headers, cookies, XML/SOAP (`Body.LoginResponse.token`, prefixes ignored,
`@name` for an attribute) and a regex's first group (an HTML form's hidden CSRF field).

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

   With two runs of the same project in flight at once, an untagged outbound call has more than one
   owner and is blocked ("claimed by more than one run"), whatever its host - including traffic
   from the same machine that belongs to neither run. It is never answered for the wrong run.

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

Each applied rule is recorded with its tier; box 5 "Rules" of the step's result panel in the run
view shows them in order (`proxy/relive.py`'s `_rule_applications`, reading the existing `MATCHED_KEY` metadata
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

A call can be held twice: a released "pause before" carries on into the request-differs branch, and
when the request differs that branch's "Ask me" is a second hold (`PAUSED_AGAIN`). Both addons wait
on it like the first. It is never forwarded without a yes. Because a released pause carries on, the
Relive validation bridge allows a pause and a mock in one call rule, and one pause per phase
(the generic interception validator refuses both for ordinary rules, whose released pause forwards
the call).

In an **Automatic** run the tab holds an inbound step's own checkpoints (Replay, Edit & replay,
Continue), so the snapshot leaves the pauses out of a top-level step's call rule. In a **Guided** run
the user's browser sends the step, so the reverse proxy holds it.

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
snapshot small. The proxy reads and parses a changed snapshot in a worker thread
(`ReliveRuns.prepare`), never on mitmproxy's event loop. The addon's only Relive-specific
logic left is attribution and step matching; everything else is the existing rule-evaluation
engine.

### How a step is shown

There is no side drawer. Opening a step - in the Steps tab or in a run - shows the Live Calls
call card (`app-relive-step-call` around `app-call-card`), and Relive adds one panel inside the
card through its `callPanels` content slot, next to the card's own "Resent from…" and ⚡
intercepted panels. Both Relive panels reuse that family's frame (`.intercept-panel`), the
numbered strip (`app-call-step-strip`) and the Request / Response diff (`app-interception-panel`,
embedded):

- **`app-relive-step-panel`** (Steps tab, "How this step runs") - 1 Recorded call (label,
  optional), 2 Mode, 3 Your edits (`app-body-editor`), 4 Variables (who saves what this step
  uses), 5 Call rule (the Interception page's `app-rule-editor` in `inline` mode: no match or
  name section, its footer applies the rule to this step), 6 Answer (ALFRED's mock), 7 Values
  (saved values previewed against the recording, the field browser `app-json-browse`, and the
  checks - see below). The diff is the recording against what this step sends / answers.
- **`app-relive-result-panel`** (run view, "Relived from the recording") - the same strip for one
  attempt plus box 8 Values (each saved value and check result). The card is the call the run
  logged, so its ⚡ panel and error banner work as for any call; the diff is the recording
  against this run. Ignore / count a differing field from the Response box.

### Step checks

A step's "Check the response" is groups of rule conditions (`shared/utils/relive-checks.ts`),
edited with the rule editor's own row (`app-condition-row`, inside `app-relive-checks-editor`).
Each group is one IF block - its conditions joined **all of** (AND) or **any of** (OR) - and every
group must pass. What a miss means belongs to the group, with one default per step: **fail** marks
the step failed and holds the run there even when the cycle says "continue on failure" (an
optional step is only marked failed), **warn** leaves the step's state alone, shows a warning pill
and carries on.

Checks are evaluated by the **proxy**, with the same `Condition` class every rule uses - never a
browser copy. The backend's `POST /relive-cycles/checks/evaluate` sends the groups and an answer
through the forward proxy to the reserved host `alfred-checks.internal`, which the addon answers
itself (`interception.evaluate_check_groups` / `answer_check_request`) and never forwards or logs.
The editor uses it for the "On the recording" line under each row (refreshed shortly after an
edit), and a run uses it on the answer each step got (`ReliveRunService.withChecks`); the result
is stored on the step result (`assertions`, `kind: 'checks'`) with what each condition found.

Checks are stored in the step's `assertions` field, which the backend treats as opaque. A step
saved before checks existed holds the older `Assertion[]` there; `stepChecks` reads it as one
all-of group with fail on a miss (GT n becomes at least n+1, LATENCY becomes Response time), so
an old cycle behaves as before until it is edited. Resend scenarios keep their own simpler
assertions and editor.

Mode, pauses, the edited request and ALFRED's answer are all actions of the one call rule; boxes
2, 3 and 6 are shortcuts that edit them, so box 5 always shows the whole rule.

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

The run's execution log (`Run.log`, FR-038) is append-only and written from two places: the run page writes a `SENT`/`ERROR` line when a step settles, and the proxy observer writes `FORWARDED_LIVE`/`REPLAYED`/`BLOCKED` (plus `REQUEST_CHANGED`/`RULE_APPLIED`) for the call itself. Lines are stored in arrival order, not time order. The run view never shows them raw: `buildRunLog` (`shared/utils/relive-run-log.ts`) sorts them by time and merges each step attempt into one row, with its other lines as events under it. It nests outbound child steps under the parent attempt they ran in. The `relive-run-log` component renders those rows with filters (problems, rules, variables, holds) and search. The grouping parses the backend's message formats (`ReliveRunsService.stepLog`/`logCall`), so a change to those formats needs the parser and its spec changed too. A line it cannot parse is still shown as a plain event.

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
  decided the (possibly edit-modified) request differs from what was recorded. Open the step in
  the run view: its result panel's Response box and Request / Response diff show what differed, or its `ignore` list if the difference is expected
  noise (e.g. a timestamp field).
- **An outbound call the run should own shows as unattributed** - `OPERATION_ID` only works if the
  application forwards `X-Operation-Id`; without that, `INFLIGHT` needs the project to have
  *exactly one* in-flight inbound call. Two concurrent inbound calls into the same project during
  a run make every one of their children unattributable by design (FR-049a's per-step choice is
  the escape hatch, not a proxy-side guess).
- **A call that should be blocked went to the real supplier, or vice versa** - check the
  evaluation tier that actually fired (the run view's result panel, box 5 "Rules"); a CYCLE or GLOBAL rule
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

## Where a run's calls live

Every call a run makes - the steps it sends, the app's supplier calls (LIVE or REPLAY), calls it
blocked - is kept in a **session cycle of the run's own** (`SessionCycle.reliveRunId`,
`backend-session-cycles`' `ReliveRunCyclesService`), not in Live Calls and not in whatever session
cycle happens to be recording:

- **Capture.** The capture adapters route a call whose `relive` tag names a run (`runId`, or
  `ambiguousRunIds`) only into that run's cycle, created by the run's first call; every other call
  goes to the RECORDING cycles as before. A run cycle is always PAUSED and never records.
- **Live Calls** asks for `relive=exclude` (both call lists take `relive`: blank, every call;
  `exclude`; or a run id), and drops a pushed run call. Its "show them here too" switch turns that
  off for the visit. The calls are still in the call logs - the run engine reads them there (step
  call cards, child matching, the Live calls log) - so only the listing hides them.
- **History** gives each run a "Calls" button that opens the run's cycle in place, inside the History
  tab (`?calls=<runId>` reopens it): the session-cycle view itself, embedded
  (`SessionCycleDetailComponent` with `cycleId` + `embedded`), so every feature of a session cycle
  works - views, search, spacers, comments, exports, resend - minus recording, importing and adding
  calls from elsewhere. `POST /session-cycles/relive-runs/{runId}` opens it; for a run from before
  run cycles existed it creates the cycle and copies in every call of the run still in the logs.
- **Not listed** on the Session Cycles page (`GET /session-cycles` leaves run cycles out).
- **Deleted with the run** - history delete, the newest-runs limit, a transient cycle's cleanup, or
  deleting the Relive cycle - through `RelatedCallsPort.deleteRunCycles` (backend-app's relivebridge).

## History: the run matrix and comparing two runs

The History tab (`relive-history`, T134, design in `specs/003-relive-cycle/run-compare-mock.html`
option C) answers two questions on one screen:

- **Since when?** A matrix of every step (rows, children under their parent) across the newest
  runs (columns, newest on the left; 6 at first, "Show older runs" for more of the 50 kept). A cell
  is the step's outcome (✓ passed, ≠ differences, ✗ failed, – not run) or, with "Time vs usual",
  its time against the median of the other runs shown. "What stands out" names it per step: first
  failure in N runs, failing for the last N runs, fixed in the newest run, changes on and off (a
  flaky answer or an unignored noise field), N× slower in the newest run, not run in the newest run.
  Each column head keeps the run's own actions: Open, compare with the previous run or with the
  recording, export, stop, delete, and the bulk-select checkbox.
- **What exactly changed?** The two runs picked as **A** (before) and **B** (after) - the A / B
  buttons on a column, or click / shift-click its date; the newest run against the one before it
  by default - are compared directly under the matrix (`relive-run-compare`). A cell picks its run
  as B and the run before it as A (unless it is already A or B) and opens that step there.

A can also be **the recording**: every step as it was recorded, the same thing each step's own
differences compare against, now for the whole run in one view.

The comparison opens with a verdict line ("B is worse: 1 new failure (Pax details), 1 answer
changed"), count tiles that filter the step table (new failures, fixed, answers changed, ran in one
only, slower / faster by more than 25% and 50 ms, same), and a table that shows changed steps only
by default. A step expands to the response fields that changed (A value | B value, each with
"Ignore in cycle", which adds a cycle noise rule to the draft), what the step sent differently (the
variables it used, then request fields those variables do not explain), the rules applied in each
run, Request / Response A vs B in the interception panel's diff, and "Open in run A / B" - the run's
timeline, on that step. Below the table: every value each run captured, side by side.

Grading reuses the run's own difference machinery (`relive-canonical-body.ts`, `relive-noise.ts`):
the cycle's current noise rules plus the step's apply, so a timestamp or a session id does not make
every step "changed"; "Show noise fields" brings those back, greyed, with why each is noise. The
model is pure functions in `shared/utils/relive-run-compare.ts` over what `getRun` already returns
(definition, step results, variable timeline) - no backend data of its own. The comparison exports
as Markdown / HTML / JSON (`relive-run-export.ts`): every step with both full response bodies,
never truncated; Markdown and HTML mask secrets, JSON keeps both step results unmasked.

## Exports: run report and run comparison

A run (History column menu → Export) and a comparison (Export on the comparison) download as
.html, .md or .json (design: `specs/003-relive-cycle/export-mock.html`). Each document is written
for a reader who was not there - a colleague, a supplier, an AI agent asked to find the bug:

1. **An answer first**: one verdict line ("Failed at step 3, POST /price: the host answered 502; the
   recording was 200. 4 of 8 steps passed…" / "B is worse: …") and the counts.
2. **About this document**: plain prose generated from the run - what Relive and a run are, which
   application and suppliers the cycle covers, what happened and why, how to read the rest. The
   same text in every format; in .json it is `about`, the first key after `format`, so an agent
   reads it before any data.
3. **Needs attention** (run) / **Steps** with a verdict each (comparison).
4. **One card per step**, numbered 1, 2, 2.1 (a supplier call made by step 2)…: why it failed or
   differed, status and time recorded vs this run, rules, variables, the differences from the
   recording (noise flagged, never counted), then the request sent, the response received and the
   recorded request/response - every body in full, pretty-printed, folded in .html/.md.
5. **Values captured** (who saved each value, which steps used it), the **run log**, and a
   **glossary** of the terms only ALFRED uses.

The model lives in `shared/utils/relive-run-report.ts` (`buildRunReport`, `buildCompareReport`);
`relive-run-export.ts` renders it. The .html is one self-contained page (slate palette of the
other exports, sticky contents, filter chips, copy buttons, prints cleanly); the .md is
GitHub-flavoured with `<details>` folds. Every fold starts closed - differences, requests, responses. A value too long for its table cell shows a preview there; its whole value opens in a full-width row under it, one under the other by default, with a switch for one side only or a line diff (the interception panel's own `diffLines`). In .md that value is written out in full under the table. Bodies and headers keep a medium height (420 px / 220 px) and scroll inside, so a step with a big answer stays one screen; printing drops the cap. .html and .md mask secret values; the .json
(`alfred.relive.run-report/v1`, `alfred.relive.run-comparison/v1`) keeps them, embeds JSON bodies
as JSON, and keeps each step's stored checks, request-changed decision, pauses and unexpected calls.
Exports never truncate call data - guarded by `relive-run-export.spec.ts`.
