# Feature Specification: Relive Cycle

**Feature Branch**: `003-relive-cycle`
**Created**: 2026-09-27
**Status**: Draft
**Input**: User description: "Add a major feature to ALFRED called Relive Cycle: build and run a controlled, ordered replay of previously recorded calls, with per-call LIVE/REPLAY control (including each outbound child of an inbound call), cycle-scoped variables with extraction, cycle-scoped and selectable global rules, per-call overrides, a live execution timeline with differences against the recording, safety against accidental external calls, and a run history - composed from ALFRED's existing recording, correlation, interception, resend, scenario and diff capabilities rather than duplicating them. A working `mock.html` prototype is a mandatory approval gate during planning."

## Overview

ALFRED records inbound calls into an application and the outbound calls that application makes, and already
correlates them into parent/child trees (an inbound Search and the supplier calls it caused). It can already
resend a recorded call, chain resends with extracted values and assertions (saved **Scenarios** with run
history), intercept and rewrite traffic with global rules (mock, fail, delay, pause, answer with a recorded
call), and show before/after differences.

A **Relive Cycle** brings those together into one guided workflow: pick recorded calls, arrange them into an
ordered workflow, decide - call by call, and child by child - what really executes and what ALFRED plays back
from the recording, then run it and watch each step complete, fail, or come back different from what was
recorded. It is a debugging and reproduction tool: "replay what happened yesterday, but with Supplier B live
and everything else frozen", without editing a single recorded call.

Terminology used below:

- **Recorded call**: a call ALFRED captured (Live Calls or a session cycle). Immutable.
- **Relive Cycle** (or "cycle" in this document): a saved, named, ordered workflow built from recorded calls.
  Not to be confused with existing **session cycles**, which are recordings; a session cycle is one natural
  source of calls for a Relive Cycle.
- **Step**: one entry of a Relive Cycle - a reference to a recorded call plus its replay-only configuration.
  A step for an inbound call carries its outbound children as child steps.
- **LIVE**: the step's traffic really reaches the real system (the application, or a real supplier).
- **REPLAY**: ALFRED answers in place of the real system, from the recording or a configured response; the
  real system is not contacted.
- **Run**: one execution of a Relive Cycle, kept separately from its definition.

## Clarifications

### Session 2026-09-27

- Q: How should Relive Cycle relate to the existing saved Scenarios? → A: Keep both. Relive Cycle is a new
  section that reuses Scenarios' parts (extraction, assertions, run storage); Scenarios stay as they are for
  quick resend chains.
- Q: On a shared ALFRED server, which traffic may a run's REPLAY answers and cycle rules affect? → A: Only
  traffic ALFRED can attribute to that run. For matching calls ALFRED cannot attribute (the application did
  not carry the run's tag through), the user decides before the run starts - per call, from the pre-run
  summary - whether such a call is blocked, replayed anyway, or sent to the real system, because the user
  knows which calls belong to their workflow.
- Q: How many runs may execute at the same time? → A: Unlimited concurrent runs, of the same or different
  cycles; runs must stay isolated from each other and from other traffic.
- Q: During a run, who triggers the inbound calls? → A: Both, chosen per run: **Automatic** (ALFRED sends
  each inbound step itself, in order) or **Guided** (the user drives the real application UI; ALFRED
  matches each arriving inbound call to the next expected step, ticks it off, and serves REPLAY answers).
- Q: How does ALFRED decide a live outbound request is "the same" as a REPLAY child's recorded call? → A:
  Default is endpoint + order (same method and URL pattern, in order within the parent step). Each child has
  a button that opens ALFRED's rule/interception editor pre-filled with that default match; the user can
  loosen or tighten it there. The edited match is saved as a rule scoped to that one call, and may use cycle
  variables.
- Q: A call works but its result differs from the recording (Price 450 → 455, 200 OK both times) - what is
  the step's outcome? → A: Yellow, "Completed with differences"; the run continues. A step is Failed (red)
  only on real breakage (transport error, timeout, no answer, 5xx, or a change of status class such as 2xx →
  4xx) or a failed user-added assertion.
- Q: Values that change on every run (tokens, ids, timestamps, Date headers) - how are they kept from turning
  every step yellow? → A: ALFRED ignores obvious noise on its own, and the user can additionally mark any
  field as noise ("Ignore this field"), for the step or for the whole cycle.
- Q: Run history keeps full requests/responses - what happens to secrets (Authorization headers, cookies,
  passwords, secret variables)? → A: Stored in full but masked by default everywhere (history, details,
  exports) until the user reveals them, using ALFRED's existing redaction rules.
- Q: How are calls picked into a cycle? → A: Through ALFRED's existing call picker ("Pick from anywhere":
  browse Live Calls and session cycles, pick with the floating pick bar, return), plus "Add to Relive cycle…" on
  calls and multi-selections elsewhere in ALFRED.
- Q: What does "Rebuild" do to a cycle? → A: The user chooses one of three modes each time: **Refresh from
  sources** (re-read the source recordings, pick up new calls, re-link children, update frozen copies, keep
  configuration where calls still match), **Rebuild from a new recording** (use a newer session cycle, or run the
  workflow once for real and capture it, as the new baseline, carrying configuration over by matching steps),
  or **Start over, keep settings** (rebuild the step list from the original source, dropping step edits but
  keeping variables, rules and settings).
- Q: Which Relive options appear when calls are selected in Live Calls or a session cycle? → A: All four: add
  to an existing cycle, create a new cycle, Relive now (quick run), and replace a cycle's steps.
- Q: Can a step pause the run before or after it executes, letting the user decide what happens next? → A:
  Yes. Any step may carry a "pause before" and/or "pause after" checkpoint. At a checkpoint the user can
  continue, replay the step as many times as they want (editing its request, variables and overrides between
  tries, every try kept as an attempt), skip it, or stop the run. For an outbound supplier call, which the
  application makes, the pause holds that call (before) or its response (after) with a timeout the user sets
  per step, after which the run continues automatically so the application is never left hanging.
- Q: When a run stops because a step failed (or, if the user asks for it, because a step had differences), can
  the user carry on with the remaining calls? → A: Yes. By default the run **holds** at a failed step instead of
  ending, and offers Retry, Edit & retry, **Continue with next calls**, and End run here. Differences keep going by
  default, but a cycle can be set to hold on them too. A run that already ended (failed, stopped or interrupted)
  can be **continued with the rest** in the same run. Later steps that need a value the failed step never produced
  are skipped with the reason shown, never sent with a gap.
- Q: How do rules on a call, cycle rules and match rules get edited? → A: In ALFRED's own rule editor, the same
  component as Interception → Rules, with every action and condition. The list of actions comes from ALFRED's
  action catalog, so an action added to ALFRED later is available in Relive automatically, with no change to
  Relive. Only the scope and the save target differ: a rule saves into the cycle, never into the global rules.
- Q: If the user edits an inbound step (e.g. Search's date), the application's supplier call no longer matches
  its recording. What happens to that REPLAY call? → A: The user chooses per call (refined below: default
  "Mock a failure"; also "Ask me", "Replay recording anyway", "Call live"). The run shows what changed in the
  request.
- Q: During a run, what happens to an outbound call that matches no step (made by mistake, a retry, a new
  endpoint)? → A: A cycle-level policy: Block (default: ALFRED answers, nothing leaves), Send to the real
  system, or Handle with my rules. "My rules" are defined in the same rule editor, with every action, and a
  fallback (Block or Send to real) covers calls none of them match.
- Q: How does the user compare a step's recording with what happened in the run? → A: With the same compare
  ALFRED shows for a resent call: the step strip (recorded call → edits → variables → sent → rules → upstream /
  ALFRED → response), Request/Response, Recorded / This run / Diff, and the header and body diff with its
  find, part filter and copy. It is reused, not rebuilt, and is one click away from a "request changed" hold.
- Q: Is REPLAY / LIVE a hard-coded behaviour? → A: No. Every call in a cycle owns exactly one ALFRED
  interception rule, its **call rule**, edited in ALFRED's own rule editor. The mode buttons only edit that
  rule: **REPLAY** turns on a request-phase *Mock response (never contact upstream)* filled with the recorded
  status, headers and body. **LIVE** turns that mock off but keeps it with the user's edits, and re-adds it from
  the recording if the user deleted it. The new **LIVE, reply mocked** calls the real host and adds a
  response-phase *Reply with a different response* filled with the recorded status, headers and body. The mode
  shown is read back from the rule, so it is always what really happens. The call rule also absorbs the match
  (its Match section), request edits (actions, including replacing the whole body), checkpoints (Pause
  actions) and "request differs" (a Condition action). Inbound steps get a call rule too. "Reset call rule"
  asks for confirmation and rebuilds it from the recording with the cycle default.
- Q: How does "request differs from the recording" fit the rule model? → A: As a new condition in ALFRED's
  existing Condition action, "request matches a recorded call (ignoring noise)", usable by global rules too.
  The call rule's Condition sends a match on to the mock; otherwise it mocks a failure, pauses, or (only if
  chosen and confirmed) sends the call to the host.
- Q: A REPLAY supplier call's request is edited (body model or headers) before it would go out, or the app
  sends something different. What happens? → A: Its request is compared with the recording **after the
  user's own edits** (noise ignored). Matching and attribution still use the request as the app sent it, so
  edits can't break them. A REPLAY call has a property, "When the request differs from the recording":
  - **Mock a failure** (default): an editable `502` mock; the supplier is never contacted.
  - **Ask me**: the call is held. When time runs out it's a mocked failure, and it is never sent to the
    supplier without an explicit yes.
  - **Replay recording anyway.**
  - **Call live**: marked dangerous, needs a confirmation when chosen, and appears in every pre-run LIVE
    summary.
  Editing a REPLAY call's request asks for this choice immediately, the first time per call.
- Q: What happens to a call that actually reached a real supplier during a run? → A: It is never wasted.
  Every such call goes, in full, into the Relive cycle's own **Live calls** log, whatever the reason it went
  live (LIVE mode, LIVE with a mocked reply, Call live, "Ask me" then send, or an unexpected/unattributed
  policy of "send to real"). The log is never pruned automatically; only the user deletes entries, with a
  confirmation. From the log the user can use a call as the step's new recording, mock with it, compare or
  resend it, and export it.
- Q: Should ALFRED notice when an edit lets a call reach a real supplier? → A: Yes. Any change that makes a
  call newly able to reach a real external system is announced at once, with the reason and an Undo.
  Examples: a mode button, turning off or deleting a mock, a Condition that forwards, a "Send the call to the
  host" or "Rewrite URL" action, an unexpected-call or unattributed policy of "send to real", or re-enabling a
  LIVE step.
- Q: Flipping the cycle-level inbound LIVE/REPLAY switch when each inbound step has its own call rule? →
  A: It applies the mode to every inbound call rule (turns the mock on or off, keeps edits). Steps whose rule
  was changed by hand are listed, and the user confirms before they change.
- Q: Do cycle and global response rules still change an answer mocked by a call rule? → A: Yes, as in ALFRED
  today. Later rules' response-phase actions run on the mocked or replaced answer, and Compare marks each
  change as expected, naming the rule.
- Q: A call rule or mode is edited while a run of the cycle is active - when does it apply? → A: ALFRED asks:
  to this run too (for steps not yet run, and the run's snapshot is updated and republished) or only from the
  next run.
- Q: Should ALFRED warn when the never-pruned Live calls log grows? → A: History shows its size; above 200 MB
  per cycle (configurable) a warning suggests bulk delete or export; nothing is removed automatically.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Build a Relive Cycle from recorded calls (Priority: P1)

A developer investigating a booking bug opens the Relive Cycles section, creates a cycle named "Book flow
repro", and adds the recorded calls of yesterday's failing session - Login, Search, Price, Book - from a
session cycle or from Live Calls. ALFRED brings each inbound call in together with the outbound calls it
caused (Search → Supplier A, B, C), shown as a tree. The developer reorders Price before Search by mistake,
notices the dependency warning, moves it back, disables the Logout call they don't need, duplicates Search to
try it twice, and saves. The recorded calls themselves are untouched.

**Why this priority**: Without a way to assemble and keep a cycle there is nothing to run. This alone already
gives value: a saved, inspectable, ordered record of "the calls that make up this workflow".

**Independent Test**: Create a cycle from four recorded calls (one with three outbound children), reorder,
disable, duplicate, remove and save it; reload the page; the cycle reappears exactly as saved, and every
source recording is byte-for-byte unchanged.

**Acceptance Scenarios**:

1. **Given** a session cycle with recorded calls, **When** the user adds its calls to a new Relive Cycle,
   **Then** each inbound call appears as a step with its correlated outbound children nested under it, in
   recorded order.
2. **Given** a cycle with several steps, **When** the user drags a step to a new position, disables one,
   duplicates one and removes one, **Then** the list reflects each change immediately and the cycle shows as
   having unsaved changes until saved.
3. **Given** unsaved changes, **When** the user tries to leave the cycle, **Then** they are warned before
   losing them.
4. **Given** a saved cycle, **When** the user duplicates it, **Then** an independent copy is created whose
   later edits do not affect the original.
5. **Given** a step whose replay configuration was edited, **When** the user resets the step (or the whole
   cycle), **Then** its configuration returns to the defaults derived from the recorded call(s).
6. **Given** any edit made in a cycle, **When** the user opens the original recorded call elsewhere in
   ALFRED, **Then** it is unchanged.

---

### User Story 2 - Choose LIVE or REPLAY per call and per outbound child (Priority: P1)

For the Search step, the developer wants the application to really run the search, with Supplier B contacted
for real (it is the suspect) while Suppliers A and C are answered by ALFRED from the recording. They set
Supplier A → REPLAY, Supplier B → LIVE, Supplier C → REPLAY. The cycle overview immediately shows a clear
LIVE marker on Supplier B and a summary "1 call can reach an external system".

**Why this priority**: Hybrid replay is the core promise of the feature and the thing no existing ALFRED
tool offers in one place: control, per child, over what really executes.

**Independent Test**: Configure an inbound step with three outbound children as REPLAY / LIVE / REPLAY, run
the step against the running application, and verify that only the LIVE child's supplier received a request,
while the two REPLAY children returned their recorded responses to the application.

**Acceptance Scenarios**:

1. **Given** a new step, **When** it is added, **Then** every outbound child defaults to REPLAY (safe by
   default) and is shown as such.
2. **Given** an inbound step with outbound children, **When** the user sets each child's mode independently,
   **Then** each child keeps its own mode and the overview shows the mix at a glance.
3. **Given** a REPLAY child, **When** the application makes the corresponding outbound request during a run,
   **Then** ALFRED answers it with the configured (recorded, by default) response and the real supplier is
   not contacted.
4. **Given** a LIVE child, **When** the application makes the corresponding outbound request during a run,
   **Then** the request goes to the real supplier and the step is marked as having contacted an external
   system.
5. **Given** a cycle, **When** the user sets the cycle-level inbound handling, **Then** they can choose
   between sending inbound calls to the real application (LIVE) and having ALFRED answer them from the
   recording (REPLAY), and the choice is shown clearly on every inbound step.
6. **Given** a REPLAY child whose outbound request the application never makes during the run, **When** the
   parent step finishes, **Then** the child is reported as "not called" rather than silently passing.
7. **Given** the application makes an outbound request during a run that matches no child step, **When**
   that happens, **Then** the cycle's unexpected-call policy decides what happens to it (blocked by default),
   and it is shown in the run as an unexpected call, with how it was handled and whether it reached an
   external system.
8. **Given** the user changed Search's request date, **When** odeysys calls Supplier A (REPLAY) with the new
   date, **Then** by default ALFRED answers with a mocked `502` failure without contacting the supplier and
   marks the step "request changed", showing recorded vs actual request. If the child is set to "Replay
   recording anyway", the recorded answer is given. If set to "Call live" (confirmed), the call goes to the
   real supplier. If set to "Ask me", the call is held and the user picks replay, edit answer & replay, send to
   real (confirmed again), or mock a failure; no decision in time means a mocked failure.
9. **Given** the unexpected-call policy "Handle with my rules" with a rule "Loyalty stub" (mock response for
   `*loyalty*`), **When** odeysys calls `api.loyalty.io/v1/points` during Price, **Then** the rule answers it,
   and the run lists it under unexpected calls as handled by that rule.

---

### User Story 3 - Run a cycle and follow it live (Priority: P1)

The developer presses Run. A pre-run summary lists the one LIVE external call and two warnings (an unused
variable, a disabled step). They confirm. The run view shows a checklist that fills in step by step - Login ✓,
Search ● running, children appearing as they execute with REPLAY or LIVE badges - with "3 / 7 completed" and
elapsed time. Supplier B comes back "⚠ 4 differences", Book fails with a 500. The developer stops the run.

**Why this priority**: Running and understanding the run is the other half of the core value; without it a
cycle is only a list.

**Independent Test**: Run a 7-step cycle and verify each step moves through the expected states in order,
progress and durations update without a page refresh, the failing step is marked failed with its error, and
stopping cancels the remaining steps.

**Acceptance Scenarios**:

1. **Given** a cycle containing LIVE external calls, **When** the user presses Run, **Then** a concise
   summary lists every call that can reach an external system and requires an explicit confirmation before
   anything is sent.
2. **Given** a cycle with no LIVE external calls and no blocking problems, **When** the user presses Run,
   **Then** it starts without an extra confirmation.
3. **Given** a running cycle, **When** each step executes, **Then** its state is shown as one of: Pending,
   Waiting, Running, Replayed, Live, Intercepted, Completed, Completed with differences, Failed, Skipped,
   Not called, Cancelled - and the user can tell at a glance what ran, what is running, what is waiting,
   what was replayed, what reached an external system, what failed and what differed.
4. **Given** a running cycle, **When** steps complete, **Then** overall progress (e.g. "5 / 9 completed")
   and per-step and total durations update live.
5. **Given** a running cycle, **When** the user presses Stop, **Then** no further steps start, a step already
   in flight is allowed to finish or is abandoned per its own timeout, and remaining steps are marked
   Cancelled.
6. **Given** a step fails, **When** the cycle's "when a step fails" setting is "hold and ask me" (default),
   **Then** the run holds there and offers Retry, Edit & retry, Continue with next calls, and End run here;
   when the setting is "keep going", the run continues with the next step and the failure stays visible.
6a. **Given** a run holding at a failed Book, **When** the user chooses "Continue with next calls", **Then** the
   run goes on with the steps after Book in the same run; a later step that needs `{{bookingId}}`, which only
   Book would have produced, is marked Skipped with that reason, and the run still ends as Failed.
6b. **Given** a cycle set to "hold on differences", **When** Supplier B comes back with unexpected differences,
   **Then** the run holds there with the same choices, and the differences are one click away.
6c. **Given** a run that already ended as Failed or Stopped, **When** the user chooses "Continue with the rest" on
   the step where it ended, **Then** the same run resumes with the remaining steps and the same variable values.
7. **Given** a finished run with a failed step, **When** the user chooses "Retry step" on it, **Then** that
   step runs again within the same run context (same variable values) and its new result is recorded as a
   new attempt, not overwriting the first.

---

### User Story 3b - Pause at a step, retry it until satisfied, then move on (Priority: P2)

The developer flags Book with "pause after" and Search with "pause before". When the run reaches Search it stops
and waits: they change the date in Search's request, press Continue, and Search runs with the new date. After
Book returns 500 "Offer expired" the run pauses again; they change `{{passengerName}}`, press Replay, look at the
new result, replay once more, and when satisfied press Continue to move to the next step. They also flag the
LIVE Supplier B call with "pause before, timeout 30 s": the application's call to Supplier B waits in ALFRED
while they check the request, and they release it; had they not, it would have continued by itself after 30 s.

**Why this priority**: Turns a replay into an interactive debugging session - the step-by-step control a
debugger gives - without leaving the cycle or losing the run.

**Independent Test**: Flag a step "pause after", run, replay it three times with an edit between tries, then
continue; verify the run waited, kept all four attempts with their own requests/results, and continued with the
next step only after Continue. Flag a supplier child "pause before, 10 s", don't touch it, and verify its call
continues on its own after 10 s and the run notes the timeout.

**Acceptance Scenarios**:

1. **Given** a step flagged "pause before", **When** the run reaches it, **Then** the run waits before sending
   it, shows the request that is about to be sent, and offers Continue, Edit, Skip and Stop.
2. **Given** a step flagged "pause after", **When** it completes, **Then** the run waits and offers Continue,
   Replay, Edit & replay, Skip rest of step and Stop, showing the result and differences of the latest attempt.
3. **Given** a paused step, **When** the user replays it any number of times, **Then** each try is kept as a
   separate attempt with its own request, response, differences and variables, and later steps use the
   variables produced by the attempt that was current when the user pressed Continue.
4. **Given** a paused step, **When** the user edits its request, variables or overrides before replaying,
   **Then** the edits apply to this run only, and the cycle definition is unchanged unless the user explicitly
   saves them back to the cycle.
5. **Given** an outbound supplier child flagged "pause before" with a timeout of N seconds, **When** the
   application makes that call during the run, **Then** ALFRED holds it and shows a countdown; Continue
   releases it (REPLAY: answered by ALFRED, LIVE: sent to the supplier), Skip fails it, and when N seconds
   pass untouched it continues automatically and the run records "continued after timeout".
6. **Given** an outbound child flagged "pause after", **When** its response (replayed or live) is ready,
   **Then** ALFRED holds the response before it reaches the application, under the same timeout rule.
7. **Given** a paused outbound child, **When** the user chooses Replay, **Then** ALFRED explains that the call
   is made by the application and offers to re-run the whole parent step instead.
8. **Given** a paused run, **When** the tab that orchestrates it is closed, **Then** the run is interrupted as
   in any other case and every held supplier call is released immediately with its default action.

---

### User Story 4 - Inspect a step's details and differences (Priority: P2)

The developer clicks Supplier B in the run timeline. A details panel shows the original recorded request and
response, the effective request after variables and rules, what was actually sent, what actually came back,
and a difference view against the recording. Two of the four differences are marked "expected - from
variable {{searchId}}"; the other two are unexpected. The panel also lists which rules matched, which
variables the step used and produced, its timing and mode.

**Why this priority**: The whole point of reliving a cycle is debugging; without an explanation of what ALFRED
did and what changed, the timeline only says "something differs".

**Independent Test**: Run a cycle where one step uses a variable, one rule rewrites a header, and one live
supplier returns a different body; open each step and verify the originals, effective, actual and difference
views are present and that the variable- and rule-caused differences are labelled as expected.

**Acceptance Scenarios**:

1. **Given** a step that returned 200 OK both when recorded and now, but with a different value (total 450 →
   455), **When** the step completes, **Then** it is shown as Completed with differences (yellow, "⚠ 1
   difference") and the run continues; with an assertion "total equals 450.00" it is Failed instead.
2. **Given** a completed step, **When** the user opens it, **Then** they see the original request/response,
   the effective request (after substitutions and rules), the actual request sent, the actual or replayed
   response, and the differences between the actual result and the recording.
3. **Given** differences caused by the cycle's own variables, rules or overrides, **When** differences are
   shown, **Then** those are labelled as expected and listed separately from unexpected differences, where
   ALFRED can attribute them.
4. **Given** a step, **When** it is opened, **Then** it lists the rules that matched it (each marked GLOBAL
   or CYCLE), the transformations applied, the variables it consumed with their values, the variables it
   produced, its execution mode, its duration and any error.
5. **Given** a step with differences, **When** the run timeline is shown, **Then** the difference count is
   visible on the step without opening it.
6. **Given** sensitive variable values (marked secret), **When** they appear in details, requests or
   differences, **Then** they are masked unless the user explicitly reveals them.

---

### User Story 5 - Cycle variables and extraction (Priority: P2)

Search's recorded response contains a `searchId`; Price and Book must use the new one, not the recorded one.
The developer adds an extraction on Search: `searchId = response.body.searchId`, and edits Price's body to use
`{{searchId}}`. They also define `passengerName` as a cycle variable. During the run, a variables panel
shows `searchId` filling in as Search completes, and Price sends the fresh value.

**Why this priority**: Real workflows chain identifiers; without extraction a replay of a multi-step flow
fails at the second step. ALFRED already has extraction for resend scenarios; this makes it part of the cycle.

**Independent Test**: Build a two-step cycle where step 2 uses a value extracted from step 1's live
response; run it and verify step 2's actual request contains the new value, and the variables panel shows it.

**Acceptance Scenarios**:

1. **Given** a cycle, **When** the user defines variables, **Then** they are visible only within that
   cycle and never affect global variables or other cycles.
2. **Given** a variable, **When** it is referenced as `{{name}}` in a URL, query, header, body, configured
   response or cycle rule, **Then** it is replaced with its current value when that step executes.
3. **Given** an extraction on a step, **When** that step completes, **Then** the extracted value becomes the
   variable's value for all later steps of that run.
4. **Given** a running cycle, **When** the user looks at the variables panel, **Then** they see each
   variable's current value, where it came from (defined, extracted by which step) and when it changed.
5. **Given** a reference to a variable that is never defined or extracted before use, **When** the user
   validates or runs the cycle, **Then** it is reported as unresolved before any call is sent.
6. **Given** an extraction whose path does not exist in the actual response, **When** the step completes,
   **Then** the step is flagged, the variable keeps no value, and later steps that need it are reported as
   blocked rather than sending a literal `{{name}}`.
7. **Given** a variable marked secret, **When** it is shown anywhere, **Then** its value is masked by
   default.

---

### User Story 6 - Cycle rules and global rules (Priority: P2)

The developer wants every call in this run to carry an `X-Debug: 1` header, and Book to fail with a timeout
on its first attempt. Global rules are also active in ALFRED, one of which rewrites a currency. They choose
"Selected global rules", keep only the currency rule, copy an existing global "slow supplier" rule into the
cycle and edit its delay without touching the global original. The overview labels each rule GLOBAL or CYCLE,
and warns that the copied rule and a global rule both target Supplier A.

**Why this priority**: Controlled replay often needs controlled interference; the rule engine already exists
and users already know it. Scoping it to the cycle avoids disturbing other traffic and other users.

**Independent Test**: Configure one cycle rule, select one global rule and copy another, run the cycle, and
verify only the chosen rules affect the run's calls, that the copied rule's edit did not change the global
rule, and that the step details list which rule (GLOBAL/CYCLE) applied.

**Acceptance Scenarios**:

1. **Given** a cycle, **When** the user sets global rule participation, **Then** they can choose No global
   rules, All global rules, or Selected global rules, and the run honours that choice.
2. **Given** a global rule, **When** the user copies it into the cycle, **Then** a cycle-scoped copy is
   created, clearly marked CYCLE, whose edits never change the global rule, and which records which global
   rule it was copied from.
3. **Given** cycle rules, **When** traffic outside the run passes through ALFRED at the same time, **Then**
   cycle rules do not affect it.
4. **Given** a global rule and a cycle rule that could both affect the same call, **When** the cycle is
   validated, **Then** the overlap is reported, and at run time the documented precedence is applied
   deterministically and shown in the step details.
5. **Given** a step, **When** the user opens its configuration, **Then** they can attach per-step
   overrides - request edits, response override, delay, wait/pause, timeout or failure simulation - using the
   same editors ALFRED already offers for rules and resend, rather than new ones.

---

### User Story 6b - Rebuild a cycle, and Relive straight from a selection (Priority: P3)

The application changed and yesterday's recording is stale. The developer opens the cycle and presses
**Rebuild**, choosing one of three modes:

- **Refresh from sources**: the session cycle it came from has gained two calls; ALFRED shows a preview - 2
  added, 1 recording updated, Supplier C re-linked under Search - and keeps every mode, variable, rule and
  checkpoint whose call still matches.
- **Rebuild from a new recording**: they pick this morning's session cycle (or let ALFRED run the workflow once
  for real and capture it, after the usual LIVE confirmation); the steps become the new baseline and their
  configuration is carried over wherever a step matches.
- **Start over, keep settings**: the step list is rebuilt from the original source exactly as first added,
  dropping step edits, while variables, cycle rules and settings stay.

Separately, in Live Calls they select three calls and open **Relive ▾**: Add to "Book flow repro", Create a
new cycle, **Relive now** (run the selection immediately with every supplier call REPLAY, saving it afterwards
if useful), or Replace the steps of an existing cycle.

**Why this priority**: Keeps cycles alive as the application evolves, and removes the detour through the
Relive section when the calls are already on screen.

**Independent Test**: Rebuild a cycle in each mode and verify the preview matches what is applied, that
configuration is kept exactly where steps match, and that earlier runs are untouched. Select calls in Live
Calls and in a session cycle and use each of the four Relive options.

**Acceptance Scenarios**:

1. **Given** a cycle, **When** the user presses Rebuild, **Then** they choose Refresh from sources, Rebuild
   from a new recording, or Start over (keep settings) before anything changes.
2. **Given** any rebuild mode, **When** the user confirms the mode, **Then** ALFRED first shows a preview
   listing steps added, removed, updated and re-linked, and the configuration kept or dropped per step; nothing
   changes until the user applies it.
3. **Given** a rebuild was applied, **When** the user regrets it, **Then** they can undo it back to the previous
   version of the cycle; earlier runs are never modified by a rebuild.
4. **Given** "Rebuild from a new recording" with "run it for real now", **When** the cycle contains calls that
   would reach external systems, **Then** the normal pre-run LIVE summary and confirmation apply.
5. **Given** calls selected in Live Calls or a session cycle (single or bulk), **When** the user opens
   **Relive ▾**, **Then** they can add them to an existing cycle, create a new cycle from them, Relive them now,
   or replace an existing cycle's steps with them - inbound calls always bringing their outbound children.
6. **Given** "Relive now", **When** it runs, **Then** it uses safe defaults (every outbound child REPLAY,
   Automatic driver), shows the normal run view, and offers "Save as cycle" at the end; nothing is saved
   unless the user chooses to.

---

### User Story 7 - Run history (Priority: P3)

A week later the developer reruns the cycle after a fix. The cycle's history shows both runs with status,
start/end time, counts of passed/failed/different steps. They open last week's run and today's side by side
to confirm Book now succeeds and Supplier B's differences are gone. The cycle definition was edited in
between; the old run still shows exactly what was executed then.

**Why this priority**: Valuable for regression checks and team hand-off, but the feature is useful without it.

**Independent Test**: Run a cycle, edit its definition, run it again; verify both runs are listed, each
reopens with its own requests, responses, differences, variables, rule applications and modes as they were at
the time, and the edit did not rewrite the first run.

**Acceptance Scenarios**:

1. **Given** a cycle with several runs, **When** the user opens its history, **Then** runs are listed newest
   first with status, start and end time, duration, and passed/failed/different/skipped counts.
2. **Given** an earlier run, **When** the cycle definition has since changed, **Then** the earlier run still
   shows the configuration, requests, responses, differences, variables, rule applications and modes it
   actually used.
3. **Given** two runs of the same cycle, **When** the user compares them, **Then** steps are matched up and
   differences in status, duration and result are shown.
4. **Given** a cycle's history grows beyond the retention limit, **When** a new run is saved, **Then** the
   oldest runs are removed and the user can see the limit.

---

### User Story 8 - Rerun from a step and skip optional steps (Priority: P3)

After a failure in Book, the developer fixes a variable and chooses "Run from Book", reusing the variable
values produced by the earlier steps of that run. They also mark Logout as optional so a failure there never
fails the run.

**Why this priority**: Saves time in long cycles, but only safe in some situations, so it comes after the
core flow.

**Independent Test**: Run a cycle that fails at step 5, choose "Run from step 5", and verify steps 1-4 are
not re-sent, step 5 uses the variable values from the earlier run, and ALFRED refuses the option when earlier
steps' variables are no longer available.

**Acceptance Scenarios**:

1. **Given** a finished run, **When** the user chooses "Run from" a step, **Then** a new run starts at that
   step, seeded with the variables the earlier run had produced up to that point, and earlier steps are shown
   as carried over rather than executed.
2. **Given** a step whose inputs cannot be reconstructed (an earlier step it depends on produced no value),
   **When** the user tries "Run from" it, **Then** the option explains why it is unavailable.
3. **Given** a step marked optional, **When** it fails, **Then** the run records the failure but continues
   and does not count as failed overall.

---

### Edge Cases

- A recorded call referenced by a cycle is later deleted or ages out of ALFRED's retention: the cycle must
  keep enough of the recorded call to still show and replay it, or clearly mark the step as missing and block
  it from running.
- The same recorded call added twice: allowed (duplicate step) but flagged, so it is intentional.
- A recorded inbound call has no correlated children, or its correlation was ambiguous: the step is shown
  without children and the user is told why; outbound calls made during the run then show as unexpected.
- The application makes the same outbound request more times than the recording had (retries, pagination):
  matching to children must be deterministic, and extra calls are shown as unexpected with their mode.
- Two REPLAY children look identical (same supplier, same request shape): matching order must be
  deterministic and visible.
- The application is not running or not reachable when an inbound step runs LIVE: the step fails quickly
  with a clear "application unreachable" error, not a hang.
- A LIVE supplier is unreachable or times out: the step fails with the supplier error; REPLAY siblings are
  unaffected.
- A held supplier call's timeout is shorter than the application's own request timeout by design; if the
  application gives up first, the step records the application-side timeout and the held call is released.
- Two concurrent runs pause the same kind of supplier call: each run holds only its own attributed calls; an
  unattributed call is never held.
- A run is stopped mid-step while the application is still waiting for a REPLAY child's answer: ALFRED must
  still answer (or fail) that child so the application is never left hanging.
- ALFRED's backend restarts during a run: the run is marked interrupted with the steps completed so far kept,
  and nothing resumes silently.
- A global rule the cycle selected is deleted or disabled before the run: validation reports it; the run does
  not silently proceed with a different rule set.
- A variable value contains characters that are special in the place it is inserted (JSON strings, URLs,
  headers): insertion must produce a valid request.
- Very large responses or cycles (hundreds of steps): the overview and run view stay usable, with search and
  status filtering, and nothing is truncated in details or exports.
- A run is started while other runs are active, including of the same cycle: it starts, and each run's
  calls, replays and variables stay separate (FR-050).
- The application does not carry the run's tag on some outbound call, so ALFRED cannot tell whose call it
  is: handled as the user chose before the run (Block by default), and marked unattributed in the run.
- Guided run where the user performs a step twice (double-click, page refresh): the second call is matched to
  the same step as a repeat attempt, not to the next step.
- Guided run left idle: the run keeps waiting for the next step with no timeout of its own until the user
  ends it; REPLAY children still answer immediately when called.
- Browser closed or page reloaded mid-run: a reload re-takes the run within 15 s and carries on. If no tab
  returns within 15 s, the run becomes Interrupted (the approved amendment, research D1); it can then be
  continued with the rest (FR-034d).

## Requirements *(mandatory)*

### Functional Requirements

**Section and cycle definition**

- **FR-001**: ALFRED MUST provide a dedicated Relive Cycles section, reachable from the main navigation, that
  lists saved Relive Cycles with name, description, number of steps, last run status and last run time.
- **FR-002**: Users MUST be able to create, rename, describe, save, duplicate and delete a Relive Cycle.
- **FR-003**: Users MUST be able to add recorded calls to a cycle from Live Calls, from session cycles and
  from ALFRED's existing call picker, singly or in bulk.
- **FR-003a**: "Add calls" in a cycle MUST offer **Pick from anywhere**, which starts ALFRED's existing call
  picker for that cycle: the user browses Live Calls and any session cycle, picks calls with the existing pick
  controls and floating pick bar, and on Done returns to the cycle with the picked calls added in the order
  picked (inbound calls with their outbound children).
- **FR-003b**: Calls elsewhere in ALFRED - a call card's menu, and any selection in Live Calls or a session
  cycle - MUST offer a **Relive ▾** menu with: **Add to cycle…** (choose an existing cycle), **New cycle from
  selection**, **Relive now**, and **Replace steps of cycle…**. Inbound calls always bring their correlated
  outbound children.
- **FR-003c**: **Relive now** MUST run the selection immediately as an unsaved cycle with safe defaults (every
  outbound child REPLAY, Automatic driver, hold on failure), through the normal pre-run check and run view, and
  offer **Save as cycle** afterwards; an unsaved quick run is kept in history only if saved.
- **FR-003d**: **Replace steps of cycle…** MUST keep the target cycle's variables, rules and settings, carry
  step configuration over where steps match (FR-007b), preview the change, and be undoable (FR-007c).
- **FR-004**: Adding an inbound call MUST also bring in its correlated outbound children as child steps,
  preserving ALFRED's existing parent/child relationship; the user MAY remove individual children.
- **FR-005**: Users MUST be able to reorder, enable/disable, duplicate and remove steps, and mark a step
  optional.
- **FR-006**: Replay configuration of a step MUST never modify the recorded call it references; recorded
  calls remain immutable.
- **FR-007**: Users MUST be able to reset a single step, or the whole cycle, to the defaults derived from
  its recorded calls.
- **FR-007a**: A cycle MUST offer **Rebuild** with three user-chosen modes: **Refresh from sources**,
  **Rebuild from a new recording** (from a chosen session cycle, or by running the workflow once for real and
  capturing it), and **Start over, keep settings**.
- **FR-007b**: Every rebuild MUST show a preview (steps added, removed, updated, re-linked; per-step
  configuration kept or dropped) and change nothing until applied. Configuration is carried over by matching
  steps on endpoint + order within their parent (the same rule as REPLAY matching, FR-014a).
- **FR-007c**: An applied rebuild MUST be undoable back to the previous cycle version, and MUST NOT modify
  earlier runs.
- **FR-008**: The cycle MUST show an unsaved-changes state and warn before discarding unsaved edits.
- **FR-009**: A cycle MUST keep enough of each referenced recorded call to display and replay it even if the
  recording is later removed from ALFRED's live retention; if that is impossible, the step MUST be marked
  missing and blocked from running.

**Execution modes**

- **FR-010**: Each outbound child step MUST have its own execution mode, **REPLAY**, **LIVE** or **LIVE, reply
  mocked**, defaulting to REPLAY. The mode is not a separate setting: it is read from the step's call rule
  (FR-010a) and the mode buttons are shortcuts that edit that rule.
- **FR-010a**: Every step (outbound child and inbound) MUST own exactly one **call rule**: an ALFRED
  interception rule in the existing model, edited in ALFRED's own rule editor (FR-029a), whose Match section
  is how ALFRED recognises the call (FR-014a/b) and whose pipeline decides what happens to it. The mode
  buttons MUST edit it as follows:
  - **REPLAY** turns on a request-phase *Mock response (never contact upstream)* holding the recorded status,
    headers and body, and turns off any *Reply with a different response*. If the user deleted the mock, it is
    re-created from the recording.
  - **LIVE** turns the mock off without deleting it, so its edited data is restored on switching back.
  - **LIVE, reply mocked** turns the mock off and turns on a response-phase *Reply with a different response*
    holding the recorded status, headers and body. The real host is contacted, and the caller gets the
    recording.
  Any other action MAY be added, changed, turned off or deleted, including request edits and *Replace the
  request body*. The mode badge, the LIVE markers and the pre-run LIVE summary (FR-015/016) MUST be derived
  from the rule: a call counts as reaching the real system when any path through its rule reaches the host,
  including one branch of a Condition.
- **FR-010b**: A step MUST offer **Reset call rule**, behind a confirmation that says what will be lost. It
  rebuilds the rule from the recording with the cycle default (REPLAY for outbound children, the cycle's inbound
  setting for inbound steps).
- **FR-011**: The cycle MUST have a setting for inbound handling - LIVE (sent to the real application) or
  REPLAY (answered by ALFRED from the recording). Changing it MUST apply that mode to every inbound step's call
  rule the same way the mode buttons do (FR-010a: the mock turned on or off, never deleted). Steps whose call
  rule was changed by hand MUST be listed first and changed only after the user confirms. Each step MAY then be
  set differently.
- **FR-012**: In REPLAY, ALFRED MUST answer in place of the real system with the call rule's mock response
  (the recording by default, editable in the rule) and MUST NOT contact the real system.
- **FR-013**: In LIVE, the request MUST reach the real system, and the step MUST be recorded as having
  contacted an external system.
- **FR-014**: During a run, outbound requests made by the application MUST be matched to the configured child
  steps deterministically; requests that match no child MUST be reported as unexpected, and children never
  requested MUST be reported as not called.
- **FR-014a**: By default a child step matches on **endpoint + order**: the same method and URL pattern as its
  recorded call, taken in recorded order among its siblings within the same parent step.
- **FR-014b**: The call rule's Match section (FR-010a) MUST be pre-filled with the default endpoint + order
  match. Any change there (loosening or tightening conditions on URL, headers, query or body) replaces the
  default match for that one step, and MAY reference cycle variables (e.g. `searchId == {{searchId}}`).
- **FR-014c**: A step whose call rule has a changed Match MUST show it (e.g. a "custom match" badge); Reset call
  rule (FR-010b) restores endpoint + order.
- **FR-014d**: Every REPLAY outbound child MUST have the property **"When the request differs from the
  recording"**, written into its call rule as a *Condition* action placed after any request edits and before
  the mock. It uses a new ALFRED condition, "request matches a recorded call (ignoring noise)", available to
  global rules too. "Differs" compares method, path, query and body **as they are at that point in the rule**,
  i.e. after the user's own edits; headers count only if the user marks them. Matching the step and
  attributing the call to the run always use the request as the application sent it, so edits never affect
  them. The choices are:
  - **Mock a failure** (default): answers with an editable mock, `502` and a JSON body explaining that the
    request differed. The supplier is never contacted, and the step is Failed with that reason.
  - **Ask me**: holds the call (*Pause and wait for me*, with its timeout) and offers: replay the recording,
    edit the answer & replay, send to the real supplier (behind a second confirmation), or mock a failure. When
    time runs out, the failure is mocked. The call MUST NOT reach the supplier without an explicit yes.
  - **Replay recording anyway**: the recorded (or edited) mock answers regardless.
  - **Call live**: a differing request is sent to the real supplier. It MUST be marked as dangerous, need an
    explicit confirmation when chosen, be listed in every pre-run LIVE summary (FR-016), and raise the
    external-reach notice (FR-015a).
  When the user edits a REPLAY call's request (in the Request tab or through request actions in its call rule),
  ALFRED MUST ask for this choice immediately, the first time for that call. Whatever the choice, the step MUST
  show "request changed" and the differences in Compare (FR-014g), including the three stages: recorded, sent
  by the application, and sent by ALFRED after edits.
- **FR-014g**: Every executed step MUST offer a **Compare** view that is ALFRED's existing resend comparison
  (the same component a resent call uses), showing the recording against this run for both request and
  response. It MUST be reachable from the step, from a "request changed" hold before the user chooses to send
  the call to the real system, and for LIVE and REPLAY steps alike. ALFRED's difference classification
  (unexpected / expected / noise, FR-041) is shown alongside it, not instead of it.
- **FR-014e**: When the user edits an inbound step's request, its configuration MUST point out that its REPLAY
  children may no longer match the recording and offer to set FR-014d for all of them at once.
- **FR-014f**: A cycle MUST have an **unexpected outbound call** policy for calls attributed to its run that
  match no step: **Block** (default: ALFRED answers `502` with an explanatory body; nothing is sent upstream),
  **Send to the real system**, or **Handle with my rules**. These are any number of rules defined in the same
  rule editor (FR-029a) with every action, first match wins, plus a fallback of Block or Send to the real
  system. Every such call MUST appear in the run with how it was handled. This is separate from calls ALFRED
  cannot attribute (FR-049a).
- **FR-015a**: ALFRED MUST notify the user immediately whenever an edit makes any call newly able to reach a
  real external system. This applies to every kind of edit: mode buttons, call rule edits in the rule editor
  (turning off or deleting a mock, a Condition branch that forwards, *Send the call to the host*, *Rewrite
  URL* to another host), enabling a step, and the unexpected-call and unattributed policies. The notice names
  the call, the host and the reason, and offers **Undo** (restores the state before that edit) and "That's
  intended". The rule editor MUST also warn before saving a call rule that would reach the host. The check uses
  the same `reachesHost` analysis as the LIVE markers and the pre-run summary (FR-010a, FR-016), so all three
  always agree. Internal hosts the user marked as internal don't trigger it.
- **FR-015b**: Every request that reached a real external system during a run MUST be saved in full (request
  and response as sent and received, plus run, step, time, duration, and why it was live) in the cycle's
  **Live calls** log, shown in the cycle's History, and marked on the step in the run ("saved"). The log MUST
  be exempt from run retention (FR-047). Entries are deleted only by the user, with a confirmation saying the
  answer can't be fetched again without calling the supplier again. Each entry MUST offer:
  - **Use as recording**: replaces the matched step's recording and its call rule's mock data. Shows a diff
    preview first and offers Undo. Past runs are unchanged.
  - **Mock with it**: puts its status, headers and body into any call rule's Mock response, or into a new
    cycle rule.
  - **Compare**: the resend comparison (FR-014g) against the recording.
  - **Resend**: ALFRED's existing resend, as a LIVE call with the usual confirmation.
  - **Export**: the existing exports (.md/.json/.html/cURL), never truncated.
  Secrets are masked as in run history (FR-022a).
- **FR-015c**: The Live calls log MUST show its total size. Above a per-cycle threshold (default 200 MB,
  `alfred.relive.live-calls.warn-bytes`) it MUST warn and offer bulk delete or export; it MUST never delete
  anything automatically.
- **FR-015**: Every LIVE step MUST be visually distinct everywhere it appears (overview, configuration, run
  view, history), and the overview MUST show a count of calls that can reach external systems.

**Safety**

- **FR-016**: Before a run that contains any LIVE external step, ALFRED MUST show a concise summary of those
  steps (including REPLAY children set to go to the real system when their request differs, and an
  unexpected-call policy that sends to the real system) and require an explicit confirmation; runs with no LIVE external steps MUST NOT require it.
- **FR-017**: Pre-run validation MUST detect and report, before anything is sent: unresolved variable
  references, missing recorded calls, duplicate steps, selected global rules that no longer exist, rule
  overlaps between GLOBAL and CYCLE rules, and steps with no enabled executable content. Problems that would
  make the run meaningless MUST block it; others are warnings the user can proceed past.
- **FR-018**: A REPLAY step MUST never fall back to contacting the real system when its configured response
  is unavailable; it MUST fail instead.

**Variables and extraction**

- **FR-019**: Each cycle MUST have its own variables, invisible to global variables and to other cycles.
- **FR-020**: Variables MUST be usable as `{{name}}` in URL/path, query parameters, headers, request body,
  configured responses and cycle rules. ALFRED's existing dynamic tokens (e.g. generated IDs and timestamps)
  MUST also work inside a cycle.
- **FR-021**: Users MUST be able to define extractions that take a value from a step's actual response (and,
  where useful, request) into a cycle variable for later steps, reusing ALFRED's existing extraction and
  path-picking behaviour.
- **FR-022**: Variables MUST support being marked secret; secret values MUST be masked by default in every
  view and in run history, and revealable on demand.
- **FR-022a**: Run history MUST store requests and responses in full, and MUST show secret material masked
  by default - secret cycle variables, Authorization and cookie headers, and anything matched by ALFRED's
  existing redaction rules - in run views, step details, run comparisons and exports, until the user
  explicitly reveals it. Revealing MUST be per view, not a saved setting.
- **FR-023**: While a run is active, the current value, source and last-change step of every variable MUST
  be visible.
- **FR-024**: A step MUST NOT be sent with an unresolved `{{name}}` reference; it MUST be blocked and
  explained instead.

**Rules and overrides**

- **FR-025**: A cycle MUST support its own cycle-scoped rules, using ALFRED's existing rule model and editor,
  that apply only to traffic belonging to that cycle's run.
- **FR-026**: A cycle MUST let the user choose global rule participation: none, all, or a selected set.
- **FR-027**: Users MUST be able to copy a global rule into a cycle; the copy MUST be independent of the
  original and remember its origin.
- **FR-028**: When GLOBAL and CYCLE rules can both affect a call, ALFRED MUST apply a single documented,
  deterministic precedence and show, per step, which rules applied and in what order.
- **FR-028a**: Response-phase actions of cycle rules and participating global rules MUST still apply to an
  answer produced by a call rule (a Mock response or Reply with a different response), exactly as ALFRED applies
  later rules to any answer today. Compare and the step's "rules applied" list MUST show each such change as
  expected, naming the rule.
- **FR-029**: Per-call behaviour (request edits, response override, delay, wait/pause, timeout simulation,
  failure simulation) is expressed as actions of the call's own rule (FR-010a, FR-029b), not a separate
  per-step setting; rule selection, variable substitution and extraction are configured alongside it, reusing
  ALFRED's existing interception, resend and editor capabilities rather than new implementations.
- **FR-029a**: Cycle rules, rules on a single step, and match rules MUST be edited in ALFRED's existing rule
  editor - the same component as Interception → Rules, not a copy - with every action, condition, recipe and
  helper it offers there (including "Pick from anywhere" for recorded answers). The actions offered MUST come
  from ALFRED's action catalog, never from a list kept by Relive, so an action added to ALFRED is available in
  Relive, and applied during runs, with no change to Relive. Only the scope (cycle, one step) and the save target
  (the cycle definition) differ.
- **FR-029b**: Everything that happens to one call lives in its single call rule (FR-010a). A delay, a
  failure, a pause, a header change or a new body on one call is an action in that rule, not a separate
  per-step setting or a second rule.

**Run and run view**

- **FR-030**: Starting a run MUST execute enabled steps in cycle order, with each inbound step's children
  handled as the application calls them.
- **FR-030a**: When starting a run the user MUST choose its driver: **Automatic** - ALFRED sends each enabled
  inbound step itself, in order - or **Guided** - the user performs the workflow in the real application and
  ALFRED matches each arriving inbound call to the next expected step. The cycle MAY remember a default.
- **FR-030b**: In a Guided run, the run view MUST show which step ALFRED expects next; an arriving inbound call
  that matches a later step MUST be flagged as out of order (and the skipped steps marked), and one that
  matches no step MUST be shown as unexpected. The user MUST be able to end a Guided run at any time; steps
  never reached are marked Not called.
- **FR-030c**: In a Guided run, variable substitution applies to what ALFRED controls (REPLAY answers, cycle
  rules); extractions MUST still capture values from the actual traffic for later steps.
- **FR-031**: Each step MUST show a live state from: Pending, Waiting, Running, Replayed, Live, Intercepted,
  Completed, Completed with differences, Failed, Skipped, Not called, Cancelled.
- **FR-032**: The run view MUST show overall progress (completed / total), elapsed time, per-step duration
  and total duration, updating live without a page refresh.
- **FR-033**: Users MUST be able to stop a run; remaining steps become Cancelled, and any in-flight REPLAY
  child MUST still be answered or failed so the application is not left waiting. Stopping or interrupting MUST
  NOT remove the run's interception at once: until every in-flight call of the run completes (or 30 s pass),
  every call attributed to the run is Blocked (never forwarded to a real system), and only then is it removed.
- **FR-034**: When a non-optional step fails, the run MUST by default **hold** at that step rather than end:
  nothing further is sent until the user chooses Retry, Edit & retry (for steps ALFRED sends), **Continue with
  next calls**, or End run here. A cycle MAY instead be set to keep going on failure. A cycle MAY also be set to
  hold on "Completed with differences" (default: keep going, FR-034b). The run view MUST show a holding run as
  holding, not as running or failed.
- **FR-034c**: When continuing past a failed step (by the user's choice or by the keep-going setting), any later
  step that references a variable only that failed step would have produced, and that has no value, MUST be
  marked Skipped with the reason shown (e.g. "needs {{bookingId}}, which Book did not produce"), never sent with
  an unresolved reference (FR-024). The hold MUST list those steps before the user chooses. The run's final status
  still reflects the failure.
- **FR-034d**: A run that ended as Failed, Stopped or Interrupted MUST offer "Continue with the rest" on the step
  where it ended: the **same** run resumes with its remaining steps, its own definition snapshot and its variable
  values, and its history records that it was resumed.
- **FR-034a**: A step's outcome MUST be decided as follows: **Failed** on a transport error, timeout, no
  answer, a 5xx response, a change of status class compared with the recording (e.g. 2xx → 4xx), or any
  failed assertion the user added (reusing Scenarios' assertions); otherwise **Completed with differences**
  when there is at least one unexpected difference from the recording; otherwise **Completed**. Expected
  differences (FR-041) never change the outcome.
- **FR-034b**: "Completed with differences" MUST NOT hold the run unless the cycle is set to hold on differences
  (default: keep going). Users who
  want a difference to fail a step add an assertion for it (e.g. "total equals 450.00").
- **FR-035**: Users MUST be able to retry a failed step within a finished or stopped run, keeping each
  attempt.
- **FR-035a**: Each step MUST support a "pause before" and a "pause after" checkpoint. They are the call
  rule's *Pause and wait for me* actions (request phase for before, response phase for after, each with its
  timeout), added with one click from the step, and shown on the step (e.g. a ⏸ badge). During a run,
  hitting one opens the checkpoint choices below.
- **FR-035b**: At a checkpoint the run MUST wait until the user chooses: **Continue**, **Replay** (repeat the
  step, unlimited times), **Edit & replay** (change the step's request, variables or overrides for this run,
  then repeat), **Skip**, or **Stop**. Every try MUST be kept as a separate attempt; later steps use the
  variables of the attempt that is current when the user continues.
- **FR-035c**: Edits made while paused apply to the current run only; the user MAY save them back to the cycle
  definition with an explicit action.
- **FR-035d**: A checkpoint on an outbound child MUST hold the application's call (pause before) or its
  response (pause after) inside ALFRED, reusing ALFRED's existing pause/breakpoint capability, with a timeout
  the user sets per step (default 60 s, allowed 5 s-10 min). When the timeout passes untouched the call
  continues with its configured mode, and the run records that it continued after timeout. Replay on a held
  outbound child MUST instead offer to re-run the whole parent step.
- **FR-035e**: While any step is paused, the run view MUST show which step is waiting, what is about to be
  sent or what came back, the available choices, and - for a held outbound call - a live countdown.
- **FR-035f**: A Guided run MUST honour "pause after" (it waits before expecting the next step) and "pause
  before" on outbound children; "pause before" on an inbound step in a Guided run means ALFRED holds the
  arriving call until the user continues, under the same timeout rule.
- **FR-036**: Users MUST be able to start a new run from a selected step, seeded with the variable values an
  earlier run had produced up to that step, when those values are available; otherwise the option MUST be
  unavailable with an explanation.
- **FR-037**: The run view MUST support filtering steps by state, searching steps, and collapsing/expanding
  parent/child trees.
- **FR-038**: A run MUST keep an execution log of what ALFRED did per step (matched, replayed, forwarded,
  rule applied, variable set, error), viewable from the run.

**Differences and details**

- **FR-039**: After a step completes, ALFRED MUST compare its actual result with the recorded call, where
  comparison makes sense, using ALFRED's existing difference view.
- **FR-040**: Difference counts MUST be visible on the step in the run timeline.
- **FR-041**: Where ALFRED can attribute a difference to the cycle's variables, rules or overrides, it MUST
  label it as expected and separate it from unexpected differences.
- **FR-041a**: ALFRED MUST automatically treat obviously volatile values as noise - at least timestamps and
  dates, UUID-like identifiers, per-request tracing/Date headers, and values taken from cycle variables or
  dynamic tokens - so they do not count as unexpected differences. Auto-ignored differences MUST remain
  visible (collapsed, labelled "ignored as noise") in the step's difference view.
- **FR-041b**: The user MUST be able to mark any difference's field as noise with one action ("Ignore this
  field"), choosing whether it applies to that step or to the whole cycle; marked fields stop counting from
  the next comparison onward, are listed in the cycle's configuration, and can be un-ignored.
- **FR-041c**: The user MUST be able to override an automatic noise decision for a field (count it after all),
  per step or per cycle.
- **FR-042**: Opening a step MUST show: original request and response, effective request, actual request,
  actual or replayed response, differences, matched rules (GLOBAL/CYCLE), transformations applied, variables
  consumed and produced, timing, execution mode and errors.
- **FR-043**: Details and any exports of a run MUST never truncate or summarize call data, in line with
  ALFRED's existing export guarantee.

**History**

- **FR-044**: Each run MUST be stored separately from the cycle definition, with status, start and end time,
  steps executed, effective and actual requests/responses, differences, failures, variable values, rule
  applications and execution modes as they were at run time.
- **FR-044a**: When the user edits a cycle (a call rule, a mode, a variable or rules) while a run of it is
  active, ALFRED MUST ask whether the change also applies to **this run** (steps not yet run; the run's
  definition snapshot and proxy snapshot are updated and the change is recorded in the run log) or only to
  **next runs**. Steps already executed are never changed.
- **FR-045**: Editing a cycle MUST NOT alter its earlier runs.
- **FR-046**: Users MUST be able to open any retained run and compare two runs of the same cycle step by step.
- **FR-047**: Run history MUST be bounded by a visible retention limit per cycle, removing the oldest runs
  first.

**Relationship to existing ALFRED features**

- **FR-048**: Relive Cycles MUST be a separate section alongside the existing Scenarios, which remain
  unchanged. Relive Cycles MUST reuse Scenarios' existing extraction, assertion and run-history capabilities
  rather than reimplementing them.
- **FR-049**: During a run, REPLAY answers and cycle rules MUST apply only to traffic ALFRED can attribute to
  that run. Other users' traffic, normal traffic and other runs MUST NOT be affected.
- **FR-049a**: Pre-run validation MUST identify the REPLAY steps whose matching calls ALFRED may not be able to
  attribute to the run, and the pre-run summary MUST let the user choose, per such step, how an
  unattributable matching call is handled: **Block** (the call fails; the real system is not contacted),
  **Replay anyway** (ALFRED answers it from the recording, knowingly accepting that it may not be the run's),
  or **Send to real system** (treated as LIVE). The default MUST be Block. The choice MUST be saved with the
  cycle, shown on the step, and recorded in the run.
- **FR-049b**: Every call handled under FR-049a MUST be marked in the run as unattributed, with the choice
  that was applied.
- **FR-050**: ALFRED MUST allow any number of runs at the same time, of the same cycle or of different cycles.
  Each run's REPLAY answers, cycle rules, variables and results MUST stay isolated from every other run.
- **FR-050a**: When two concurrent runs could both claim the same unattributable call (FR-049a), neither may
  take it silently: it MUST be treated as Block for both and reported in both runs.
- **FR-051**: A running cycle MUST NOT change how ALFRED records and displays normal traffic: the run's calls
  still appear in Live Calls (and in any recording session cycle), identifiable as belonging to that run.

### Key Entities

- **Relive Cycle**: named, described, saved workflow. Holds ordered steps, cycle settings (inbound handling,
  global rule participation, what to do when a step fails or differs), cycle variables, cycle rules, and validation state.
- **Step**: one ordered entry. References a recorded call (and keeps enough of it to replay), and holds
  replay-only configuration: enabled, optional, execution mode, request edits, response override,
  delay/wait/timeout/failure, rule selection, extractions. An inbound step owns child steps for its outbound
  calls.
- **Checkpoint**: per step - pause before (bool), pause after (bool), timeout in seconds for outbound
  children (default 60), recorded per run as pause events (at, choice, by timeout or by user).
- **Cycle Variable**: name, initial value, secret flag, and its source (defined, or extracted by a step).
- **Noise Rule**: a field (by location and path) whose differences don't count - automatic, or marked by the
  user for one step or the whole cycle - with an optional user override of an automatic decision.
- **Extraction**: which step, which part of its request/response, which path, into which variable.
- **Cycle Rule**: a rule in ALFRED's existing rule model, scoped to one cycle; optionally records the global
  rule it was copied from.
- **Call-scoped Match Rule**: a rule in ALFRED's existing rule model owned by one child step, defining when a
  live outbound request counts as that child; defaults to endpoint + order; may reference cycle variables.
- **Global Rule Participation**: none / all / selected, plus the selected global rules.
- **Cycle Version**: the cycle definition before each rebuild or replace-steps, kept for undo (at least the
  previous version).
- **Run**: one execution of a cycle - driver (Automatic or Guided), status, start/end time, settings and definition snapshot used, per-step
  results, variable timeline, execution log.
- **Step Result** (attempts include every Replay / Edit & replay try at a checkpoint): per step per attempt - state, mode, effective/actual request, actual or replayed response,
  differences (expected/unexpected), matched rules, variables consumed/produced, timing, error. Includes
  unexpected calls the application made during the step.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A user can build a runnable 5-step cycle (with one inbound step having three outbound
  children) from an existing recording and start its first run in under 5 minutes, without documentation.
- **SC-002**: In a run with mixed modes, 100% of REPLAY outbound children are answered by ALFRED with zero
  requests reaching the real supplier, verified by the supplier receiving nothing.
- **SC-003**: No run starts that contains a LIVE external call without the user having seen and confirmed the
  list of such calls (0 exceptions in testing).
- **SC-004**: 100% of unresolved variable references are reported before a run starts; no request is ever
  sent containing a literal `{{name}}`.
- **SC-005**: While a run is active, step state changes are visible to the user within 1 second of
  happening.
- **SC-006**: For any failed or different step, a user can identify from the step's details alone which
  request was sent, what came back, which rules and variables affected it, and why it differs - confirmed by
  test users answering those four questions correctly for 9 out of 10 steps.
- **SC-007**: Reopening a run after its cycle was edited shows exactly what executed at the time in 100% of
  checks.
- **SC-008**: Recorded calls used by cycles are unchanged after any number of edits and runs (byte-for-byte
  check).
- **SC-009**: The overview and run view of a 200-step cycle remain usable: finding a step by search or
  status filter takes under 10 seconds.
- **SC-010**: With two runs and unrelated traffic active at once, 0 calls are replayed or rewritten for the
  wrong run or for traffic outside any run, other than those the user explicitly allowed as "Replay anyway".
- **SC-011**: Rerunning an unchanged workflow twice in a row, with only volatile values (tokens, ids,
  timestamps) changing, yields zero "Completed with differences" steps on the second run once the user has
  marked any remaining noise - and at most 1 in 5 steps showing noise-only differences on the very first run.

## Assumptions

- The application under test (for LIVE inbound steps) and the external systems (for LIVE outbound children)
  are reachable through ALFRED's existing proxies as they are for recording today; Relive Cycle does not
  start or deploy applications.
- REPLAY of an outbound child relies on the application's outbound traffic already flowing through ALFRED's
  forward proxy, as it must for recording.
- Parent/child correlation uses ALFRED's existing call-tree correlation; Relive Cycle does not introduce a new
  correlation method.
- Rule semantics, editors, dynamic tokens, extraction/path picking, difference view and call picker are
  ALFRED's existing ones; Relive Cycle composes them.
- ALFRED has no login; anyone who can reach ALFRED can see and run cycles, as with every other feature.
- Attributing traffic to a run relies on the application carrying request identifiers through to its outbound
  calls (ALFRED already records session and operation identifiers); planning decides the exact mechanism.
- Default run history retention: the newest 50 runs per cycle, matching existing Scenarios.
- Default for a new step: enabled, not optional, outbound children REPLAY, inbound handling from the cycle
  setting, hold on failure.
- Reusable cycle templates are out of scope for this version; duplicating a cycle covers the main need.
- A working `mock.html` prototype demonstrating the full user flow is produced during planning and must be
  approved before implementation tasks are generated.
