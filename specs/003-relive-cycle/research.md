# Research: Relive Cycle

**Feature**: [spec.md](./spec.md) | **Plan**: [plan.md](./plan.md) | **Date**: 2026-09-27

Everything below was checked against the code on `003-relive-cycle` (at `b76d748`). Each decision
names what it reuses; "new" means nothing existing covers it.

## What ALFRED already has (inventory)

| Capability | Where it lives | How Relive uses it |
|---|---|---|
| Resend a logged call through the proxies, inbound (reverse-proxy listener) or outbound (forward proxy), with edits and session substitution | `backend-resend` (`ResendCallUseCase`, `OutgoingCall`, `JdkHttpCallSender`); proxy `take_resend_headers` trusts `X-Alfred-Resend-Of/-Edits` only from the backend's own address | Automatic runs send every inbound step through `POST /resend`, unchanged |
| Chaining: extract values from a response, substitute into later requests, dynamic tokens | `shared/utils/resend-draft.ts` (`ExtractRule`), `resend-draft-chain.ts` (`substituteDraft`, `extractValues`), `dynamic-tokens.ts` (+ Java/Python ports, shared vectors) | Cycle variables and extractions ARE these, scoped to one run |
| Assertions and pass/fail per step | `shared/utils/scenario-assertions.ts`, `scenario-assertion-editor` | Step assertions (FR-034a) |
| Saved workflows with run history (definition opaque to backend, newest 50 runs kept, `/ws/scenarios` change signal) | `backend-scenarios` (SQLite), `scenario-api.service.ts`, `scenario-state.service.ts`, `scenario-run-report`, `scenario-run-compare` | The storage shape and run-history UX Relive copies; run compare reused |
| Browser-orchestrated runs with live progress | `bulk-resend-dialog.service.ts` (runs, groups, stop-on-failure, retry policy) | Same orchestration model for Automatic runs |
| Rule engine in the proxy: match on source/project/method/host/path/headers/query/cookies/variables/body; actions incl. mock, fail, delay, pause/breakpoint, answer with recorded call or file; `priority` ascending + `stopProcessing`; rules from a backend-published `rules.json` snapshot, mtime-cached | `proxy/interception.py` (`Match`, `Rule`, `RuleSet`, `_RulesCache`), `backend-interception` (`FileRulesPublisherAdapter`, `StoredAnswersService`) | REPLAY answers and cycle rules are rules; answers are stored answers |
| Rule editor, "build a match from this call" | `rule-editor`, `rule-dialog`, `match-from-call.ts` | The per-call match-rule button (FR-014b) and cycle rules (FR-025) |
| Parent/child correlation | `shared/utils/call-tree.ts` (`buildCallTree`, `indexCallTree`: time containment + project attribution) | Deriving child steps when an inbound call is added |
| Outbound project attribution | per-project forward-proxy listener (`internal_call_services` 4th field, e.g. `127.0.0.2:443`) | Knowing which project an outbound request came from, at request time |
| Request identifiers | proxies read `X-Session-ID` / `X-Operation-Id` on both directions | Run tagging when the application propagates them |
| Differences | `interception-diff.ts` (before/after), resend "vs original" comparison in `call-card` | Step differences (FR-039) |
| Redaction / secret masking | `backend-redactions`, `redact.ts`, `SecretValuesService`, sensitive-header list | Masking in run history (FR-022a) |
| Call picker across pages | `call-picker.service.ts` (requester + `takeResult`), `pick-bar`, `pick-call-button` | "Pick from anywhere" (FR-003a): a Relive requester key per cycle, same flow session cycles use for "Add calls from anywhere…"; "Add to Relive cycle…" (FR-003b) joins the existing call-actions menu and bulk-actions bar |
| Live signals | `reconnectingSocket` + per-slice `/ws/*` change signals | `/ws/relive` |

## Decisions

### D1. Where a run executes

- **Decision**: The run is **orchestrated by the browser tab that started it**, exactly as Scenarios
  runs are today. The backend stores cycles and runs and publishes the run's proxy snapshot. The
  proxies enforce REPLAY answers and cycle rules. The tab sends inbound steps (via `POST /resend`),
  evaluates extraction and assertions, computes differences, and writes results back as they happen.
- **Rationale**: Every piece of step logic already exists in TypeScript: substitution, extraction,
  dynamic tokens, assertions, diff, call tree. A backend engine would need a second, Java
  implementation of extraction paths, assertions and diffing, which the constitution (V: one
  implementation per behavior) forbids without cause. Unlimited concurrent runs (FR-050) come free:
  each run is one tab's work.
- **Consequence, a spec amendment to approve at mock review**: the spec's edge case "browser closed
  mid-run: the run continues on its own" becomes "**the run stops cleanly**". The backend holds a
  lease tied to the orchestrating tab's `/ws/relive` connection. When the connection is gone for
  more than `RUN_LEASE_GRACE` (15 s), the backend unpublishes the run's proxy snapshot, so no stale
  REPLAY answers or cycle rules linger, and marks the run **Interrupted**, keeping the steps
  completed so far. Reopening shows the partial run and offers "Run from step" (FR-036).
- **Alternatives considered**:
  - A backend run engine (a new orchestrator slice): survives tab close, but needs Java ports of
    `resend-draft-chain`, `scenario-assertions` and `interception-diff`, each kept in lockstep by
    shared vectors, as dynamic tokens already are. Too much duplicated logic for the one benefit
    of surviving a closed tab. Guided runs need an open tab anyway.
  - A hybrid, where the backend sends and the tab evaluates: same duplication for extraction,
    because later steps need extracted values before they're sent.

### D2. How the proxy knows a call belongs to a run (attribution)

The rules must be decided at request time, inside the addon, with no backend round trip
(Invariant: interception stays in the addons).

- **Decision**: three sources, tried in order. Each attributed call records which one was used.
  1. **Run header** (inbound, Automatic runs): the backend adds `X-Alfred-Relive: <runId>/<stepKey>`
     to every step it resends. The reverse proxy pops it and trusts it only from the backend's peer
     address, exactly like `take_resend_headers`, so it can't be forged and never reaches the
     application or the call log.
  2. **Propagated operation id** (outbound): the resend of an inbound step also sets
     `X-Operation-Id: relive-<runId>-<stepKey>`. If the application forwards `X-Operation-Id` on its
     outbound calls (the convention ALFRED already reads in both proxies), the forward proxy
     attributes the call exactly.
  3. **In-flight uniqueness** (outbound fallback): the backend publishes `relive/inflight.json`, the
     in-flight inbound calls per project with the run step each belongs to (or none). It is written
     only while at least one run is active, from the prepare/complete webhooks it already receives.
     An outbound request from project P is attributed to step S when S is the **only** in-flight
     inbound call for P. Otherwise it is **unattributable**, and the step's pre-run choice (Block /
     Replay anyway / Send to real system, default Block, FR-049a) applies.
- **Rationale**: 1 and 2 are exact and cost nothing. 3 is a heuristic, but a safe one: it only
  claims a call when there's no one else it could belong to, and every other case falls to the
  user's explicit choice. It needs no proxy-to-proxy channel, since the backend already sees every
  inbound call start and finish.
- **Guided runs**: inbound comes from the user's real browser, with no run header. A Guided run
  claims untagged inbound calls for its projects only when it's the sole active Guided run for that
  project and no Automatic step is in flight there; otherwise the arrival is shown as unattributed
  and the user assigns or ignores it in the run view. Binding by client IP was considered and
  rejected: Docker's userland proxy rewrites source addresses on common setups, so the IP isn't
  reliable.
- **Pre-run validation** marks a REPLAY step "may be unattributable" when its project has no
  evidence of `X-Operation-Id` propagation in the recording (the child call's recorded `operation_id`
  differs from its parent's). That's what drives the FR-049a prompt.
- **Alternatives considered**: all matching traffic (rejected in clarification); a proxy-to-proxy
  socket (a new moving part on the hot path); client IP (unreliable, above).

### D3. REPLAY answers and "endpoint + order" matching

- **Decision**: at run start, the backend publishes a **run snapshot**
  (`proxy/interception/relive/<runId>.json`) holding, per REPLAY child step, a rule in ALFRED's
  existing rule shape:
  - match: method + host + path pattern derived by `match-from-call.ts` from the recorded call, or
    the user's edited call-scoped match rule;
  - `relive: {runId, parentStepKey, ordinal}`: new;
  - action: `ANSWER_WITH_RECORDED_CALL` pointing at a stored answer, copied from the step's frozen
    recording (or its response override).

  The proxy keeps a per-run counter for each (parent step, match key). "Order" means the Nth
  matching request inside that parent's in-flight window gets the child with ordinal N; requests
  beyond the recorded count are **unexpected** (FR-014).
- **Rationale**: reuses the whole answer pipeline (stored answers, `answer_parts`, date refresh). The
  only new matching concept is the ordinal, a few lines beside `Match.matches`.
- **Call-scoped match rules (FR-014b)**: the child's "match rule" button opens the existing
  `rule-dialog` pre-filled from `match-from-call.ts`. What's saved is a rule document stored on the
  step, not in the global rule list, and published only inside that run's snapshot. Cycle variables
  are rendered into it at run start and on each extraction, with the same `{{name}}` rendering the
  proxy already applies (`_resolve_variable_tokens`).

### D4. Rule precedence between CYCLE and GLOBAL

- **Decision**: for a request attributed to run R, the proxy evaluates, in order:
  1. R's **step rules** (REPLAY answers and call-scoped match rules for the matched child);
  2. R's **cycle rules**, by their own `priority` then order;
  3. the **participating global rules** (none / all / selected, per R's setting), by their existing
     priority.

  Every existing semantic still holds inside each tier: all matching rules apply in order until one
  has `stopProcessing`. A REPLAY answer ends the request (no upstream), so tier 3's request edits
  can't reach a supplier the step replays. Traffic not attributed to any run sees tier 3 only, with
  all global rules, exactly as today.
- **Rationale**: "the cycle is the more specific configuration" is the least surprising rule. It's
  deterministic, and it's shown per step: the run records each applied rule with its tier (FR-028).
- **Validation (FR-017)**: an overlap warning when a cycle rule and a participating global rule match
  the same step's recorded request and both modify the same part (request line, headers, body,
  response).
- **Alternatives considered**: global first (global rules would silently override the cycle's
  intent); a merged single list by priority (the order depends on numbers users never set
  consciously).

### D5. Proxy snapshot lifecycle

- **Decision**: `relive/<runId>.json` is written atomically (temp file and rename), as `rules.json`
  is, when a run starts. It's rewritten when a variable the snapshot uses changes, and deleted when
  the run ends, is stopped, or loses its lease. Each proxy lists `relive/` at most once per second
  (mtime of the directory) and caches parsed runs, the same mtime-cache idiom as `_RulesCache`.
  `inflight.json` sits beside it.
- **Rationale**: no backend call on the request path, and runs keep working while the backend is
  briefly down. A missing directory costs one `stat`.
- **Performance**: with no run active, the added cost per proxied request is one cached directory
  mtime check. With runs active, attribution is dictionary lookups; ordinal counters are in memory.

### D6. Step outcome, noise and differences

- **Outcome (FR-034a)**: computed in the tab from the actual response and assertions:
  - **Failed**: transport error, timeout, 5xx, a status-class change, or a failed assertion;
  - otherwise **Completed with differences** when there are unexpected differences;
  - otherwise **Completed**.
- **Differences**: `interception-diff.ts` compares recorded and actual per part (status, headers,
  body). Each difference is then classified:
  - **expected**: the path was written by a variable, rule or override (known from the run's
    applied-rule log and the substitution map);
  - **noise (automatic)**: ISO/epoch timestamps, UUIDs, the `Date` header and tracing headers
    (`traceparent`, `X-Request-Id`, `X-Session-ID`, `X-Operation-Id`), and any value equal to a
    cycle variable or dynamic token;
  - **noise (user)**: in the cycle's or step's ignore list (FR-041b);
  - otherwise **unexpected**.
- **New code**: a small `relive-noise.ts` (auto-noise detectors plus ignore-list matching). Nothing
  existing classifies differences this way.

### D7. Freezing recorded calls (FR-006, FR-009)

- **Decision**: adding a call to a cycle copies its full detail (request, response, timing, source,
  service) into the step, the same way a stored answer copies a recorded call today. The step keeps
  the source call's id and cycle for "open original", but never depends on it still existing.
- **Rationale**: session-cycle and Live Calls retention would otherwise break saved cycles.
  Immutability is automatic: the originals are never written.

### D8. Storage and retention

- **Decision**: a new slice **`backend-relive`**, SQLite only like `backend-scenarios`:
  - `relive_cycles` (definition as validated JSON);
  - `relive_runs` (header plus summary);
  - `relive_step_results` (one row per step attempt, holding request/response bodies).

  List queries never select bodies. Retention: the newest **50 runs per cycle** (as Scenarios),
  plus a total size cap `alfred.relive.runs.max-size-bytes` (default 500 MB) that removes the
  oldest runs first. Cycle definitions are unbounded, like session-cycle capture (a bounded manual
  artifact).
- **Rationale**: the constitution requires explicit retention, and step results are body-heavy. A
  file adapter isn't added: Scenarios set the SQLite-only precedent for opaque run stores, and
  keeping a file fallback working would double every adapter for no user benefit (recorded in
  Complexity Tracking).

### D9. Security

- Run headers are trusted from the backend's peer address only (D2.1). All new endpoints use `@Valid`
  DTOs with clamped sizes (step count at most 500, body at most the existing resend limits). Secret
  masking in the run view, details, compare and exports uses the existing redaction list plus the
  cycle's secret variables. Reveal is per view (FR-022a). No call data in logs.
- Auto-noise never hides a difference completely: noise is collapsed, not removed (FR-041a).

### D11. Checkpoints: pause before / after a step (US 3b)

- **Decision**: two paths, chosen by who makes the call.
  - **Steps ALFRED sends** (inbound steps in Automatic runs): the checkpoint lives purely in the orchestrating tab.
    It stops before sending, or after settling, and waits for the user. **Replay** / **Edit & replay** re-send
    through `POST /resend` as a new attempt (the retry path of FR-035); edits go to the run's working copy of the
    step, and "Save to cycle" writes them back. No proxy involvement and no timeout: nothing external is waiting.
  - **Calls the application makes** (outbound children, and inbound steps arriving in Guided runs): the run
    snapshot marks the child with `pause: { before, after, timeoutMs }`. The addon reuses **`proxy/breakpoints.py`**
    as-is: it holds the flow, registers it with backend-interception (`POST /interception/paused`), long-polls
    for a decision, and on timeout applies the default action, which here is always "continue with the configured
    mode". The paused entry carries the run tag, so the Relive run view shows it inline, with a countdown, and
    releases it through the existing decision endpoint (`BreakpointUseCase`). It also still appears in the
    Interception page's paused list, where it's labelled with the run.
- **Rationale**: the breakpoint path already solves the hard parts: no event-loop blocking (a dedicated poll
  pool), never waiting forever (a timeout plus a default action), surviving a backend restart (falls back to the
  timeout action), and concurrent pauses. Rebuilding any of that for Relive would duplicate a subtle subsystem.
- **Timeout**: set per step, default 60 s, clamped 5 s-600 s (the same bounds the breakpoint validator already
  enforces). When the orchestrating tab's lease ends, the backend releases every held call of that run
  immediately with its default action.
- **Replay on a held child**: the application made the call, so ALFRED can't "send it again". The run view
  offers "Re-run parent step" instead (FR-035d).

### D12. Rebuild, and Relive from a selection (US 6b)

- **Matching, once**: a single pure `shared/utils/relive-match.ts` pairs "old" and "new" steps on endpoint +
  order within the same parent: the rule REPLAY children use by default (FR-014a). The rebuild preview, carrying
  configuration over, and "Replace steps" all call it, so a step counts as "the same" everywhere.
- **Refresh from sources**: the tab re-fetches each step's `source` (call detail for the ids it still has, and the
  source session cycle's full list for new calls after the last frozen one), rebuilds the tree with `call-tree.ts`,
  and diffs it against the current steps with `relive-match.ts`.
- **Rebuild from a new recording**: either the user picks a session cycle, or ALFRED runs the cycle once with
  every child **LIVE** and inbound sent for real. The usual pre-run LIVE confirmation lists everything that will be
  contacted; the run's actual calls become the new frozen recordings. Same preview and merge afterwards.
- **Start over, keep settings**: re-freezes from the original `source` of each step as first added, with no
  step configuration; cycle-level variables, rules, noise and settings are kept.
- **Preview → apply → undo**: the preview is computed client-side and applied with `PUT`. The backend snapshots
  the previous definition into `relive_cycle_versions` on every rebuild or replace, keeping the newest 10 per
  cycle; "Undo" restores the latest. Runs hold their own definition snapshot (FR-044), so a rebuild never
  touches them.
- **Relive ▾ on selections**: a new entry in the existing `call-actions` menu and `bulk-actions-bar`, not a new
  toolbar, offering Add to cycle / New cycle / Relive now / Replace steps. "Relive now" creates a cycle with
  `transient: true`. It's hidden from the list and runs normally, then is either saved (the flag is cleared) or
  deleted when its run ends or its lease is lost. That keeps a quick run on exactly the same code path as a saved
  one.

### D13. Hold, continue, resume (FR-034, 034c, 034d)

- **Hold is tab-side**, like checkpoints: the orchestrating tab owns the run loop (D1), so on a failed step (or
  differences, when the cycle holds on them) it simply does not start the next step, records `hold` through
  `PUT …/hold`, and waits for the user. Nothing in the proxy is held - the step has already settled - so no
  timeout is needed; the lease still applies (closing the tab interrupts the run).
- **Continue with next calls** clears the hold and advances. Before advancing, the tab computes the steps to skip:
  later enabled steps whose `{{refs}}` include a variable whose only producer (an `extract` on an earlier step) is
  the failed step and that has no value yet. It's the same reference scan pre-run validation already does
  (`ORDER_DEPENDENCY`, FR-017), reused.
- **"Keep going" setting** takes the same path without waiting, so both behave identically.
- **Continue with the rest of an ended run** (`POST …/resume`) re-publishes the run's *own* definition snapshot
  (FR-044), sets `RUNNING`, and the tab takes a new lease and resumes at the step after the one it ended on. It
  reuses the same run id so history keeps one record with a `resumed[]` trail, unlike "Run from step" (FR-036),
  which is a new run seeded from an old one.
- **Alternative rejected**: an automatic "skip everything after a failure" - it hides which later steps could
  still have run, and the user asked to decide.

### D14. One rule editor, one action catalog (FR-029a/b)

- **Frontend**: `RuleEditorComponent` (`components/rule-editor/`) is reused as-is, embedded in the Relive step
  drawer and rules tab through the existing `RuleDialogService` pattern. It currently saves through
  `InterceptionStateService.createRule/updateRule`; a new DI token `RULE_EDITOR_TARGET` (default: the global
  store) lets the Relive host supply a target that writes into the cycle draft instead, plus a `scope` input
  (`GLOBAL` | `CYCLE` | `STEP` | `MATCH`) that locks the Match section to the step (STEP) or hides the pipeline
  (MATCH). That's the pattern the codebase already uses to share components rather than fork them
  (docs/frontend-architecture.md). The action list, groups, goals and recipes already come from
  `InterceptionStateService.actionTypes()` (server catalog) and `shared/utils/action-catalog.ts`, so a new action
  appears in Relive with no Relive change.
- **"Pick from anywhere" from the editor** parks the editor snapshot with the host's return route (existing
  `EditorSnapshot` / `goToCall` flow); the Relive page restores it on return like the Interception page does.
- **Backend**: cycle/step/match rules are validated with the existing `RuleValidator` from
  `backend-interception`'s API (read-only dependency, as `backend-resend` already has on shared models), so a new
  action type is accepted as soon as the global rules accept it. Answers referenced by actions are copied into
  `relive_answers` and published with the run.
- **Proxy**: step and cycle rules run through the same `interception.py` evaluator as `rules.json` (D4 tiers), so
  new actions work in runs automatically.
- **Guard test**: a frontend spec renders the editor in `STEP` scope with a stubbed catalog that includes a type
  Relive has never heard of, and asserts it's offered and saved into the cycle; a backend test runs every
  catalog action type through cycle-rule validation.
- **Alternative rejected**: a Relive-specific "faults" form (delay / timeout / fail / pause). It's a second
  implementation of existing actions, and it would fall behind every time an action is added.

### D15. Changed requests and unexpected calls (FR-014d/e/f)

- **Where the decision is made**: in the addon, at request time, because only the proxy sees the live request
  before it is answered. The snapshot carries each REPLAY child's recorded request (by reference, as answers
  are) and its `onRequestChanged`. Canonicalization of both sides happens in Python (`interception.py` already
  parses JSON bodies for JSON-field actions), with the same noise paths the run view uses, so "changed" in the
  proxy and "request changed" in the run view agree.
- **ASK reuses the checkpoint hold** (D11, `breakpoints.py`) with `at: "CHANGED"`; the run view renders it with
  the request differences and the four choices. "Edit answer & replay" releases the flow with a
  one-run response (the same run-only edit mechanism as checkpoints, FR-035c).
- **Unexpected-call policy replaces "report only"**: an unexpected call was already detected (it's in the
  step result). The addon now also acts on it according to `unexpectedCalls`. The default is `BLOCK`, in keeping
  with "make accidental supplier calls difficult" (safety FRs). `RULES` are ordinary rule documents edited in the
  shared `RuleEditorComponent` with `scope: UNEXPECTED` (D14): the Match section is open and the pipeline takes every
  catalog action.
- **Alternatives rejected**: comparing requests in the backend after the fact (too late to change what
  happened); a fixed "mock unexpected calls with 200 {}" option (a subset of what rules already do).

### D16. Compare view = the resend comparison (FR-014g)

- `ResendPanelComponent` (step strip) and `InterceptionPanelComponent` (Original / Resent / Diff tabs, IN/COPY
  filters, header and body diff) already compare "the original call" with "what happened this time". The step
  drawer's Compare tab embeds `InterceptionPanelComponent` for each half, fed a `CallInterception` built from
  `step.recording` (before) and `StepResult.actualRequest/actualResponse` (after), with `labels` set to
  "Recorded / This run". The step strip is `ResendPanelComponent`'s strip, fed from the StepResult (edits,
  variables, rules applied, upstream vs ALFRED-answered) through a small adapter, not a copy. The strip's markup
  moves into a presentational child both panels use, so resend and Relive can't drift.
- Inbound steps ALFRED sends are real resends (`resend_of` set), so their logged call already renders the
  resend panel unchanged.
- **Alternative rejected**: extending the mock's own diff table. It would be a second comparison UI.

### D17. The call rule (FR-010a/b, 014b-d, 029b, 035a)

- **One document per step**: `Step.callRule` is an ordinary rule in the existing model, and the backend
  validates it with `RuleValidator` like any other. Its Match is the step's match. Its actions are the whole
  behaviour: `MOCK_RESPONSE` for REPLAY, nothing for LIVE, `REPLACE_RESPONSE` for LIVE with a mocked reply, plus
  anything the user adds. The mode buttons are a small pure helper, `shared/utils/relive-call-rule.ts`
  (`applyMode(rule, mode, recording)`, `modeOf(rule)`, `reachesHost(rule)`), unit-tested on its own. It only
  toggles/creates the three actions and never rewrites others. `reachesHost` walks `IF_REQUEST` branches, so a
  condition that may forward counts as LIVE for safety.
- **Turned off, not deleted**: switching away from REPLAY sets `enabled: false` on the mock action. That uses
  the per-action enable flag the rule editor already has, so the user's edited mock data survives. If the user
  deleted it, `applyMode` re-creates it from `step.recording`.
- **New condition**: `IF_REQUEST` gains a condition kind `MATCHES_RECORDED_CALL { answerId, ignore[] }`,
  evaluated in `interception.py` with the canonical comparison from D15. It is added to ALFRED's Condition action
  (and its editor UI) for everyone, not just Relive.
- **Proxy**: the snapshot's child `rules` becomes the single `callRule`. The step tier (D4) evaluates it, so
  mock, replace, pause and condition all use the existing action code paths. The snapshot's separate
  `answerId` / `pause` / `onRequestChanged` fields (proxy-snapshot.md) are superseded; the addon's only Relive
  logic left is attribution and step matching.
- **Request differs (FR-014d)**: the default REPLAY call rule is
  `[request edits…] → IF_REQUEST(MATCHES_RECORDED_CALL, else: MOCK_RESPONSE 502 {error}) → MOCK_RESPONSE(recording)`.
  Because the condition sits after the edit actions, the comparison sees the edited request, while matching
  and attribution run before the pipeline on the original request. `ASK` puts `PAUSE_REQUEST` in the else
  branch with the failure mock as its timeout default, so the breakpoint's "default action" guarantees no
  forwarding without a decision. `LIVE` puts `SEND_TO_HOST` there, and `reachesHost()` reports it (FR-015a).
  Editing a REPLAY call's request raises the choice once per call (`askedChanged` UI flag, not stored in the rule).
- **Mock data size**: the mock's body lives inline in the rule, as the existing `MOCK_RESPONSE` action already
  allows. Very large bodies (over the action's inline limit) are stored as a Relive answer and referenced, the
  same way `ANSWER_WITH_FILE` handles uploads.
- **External-reach watcher (FR-015a)**: a computed signal in the Relive editor state,
  `externalReach = Map<stepKey | policy, reason>`, derived from `reachesHost()` over every call rule plus the
  cycle's unexpected/unattributed policies. An effect diffs it against the previous value after each edit.
  New entries raise one grouped notice (the existing toast host with actions, not a new component) carrying an
  Undo, which restores the draft snapshot taken before the edit. The draft already keeps one for the dirty
  state. Pure function, unit-tested with rules that reach the host by each route (mock off/deleted,
  `IF_REQUEST` else-branch, `SEND_TO_HOST`, `REWRITE_URL`).
- **Alternatives rejected**: a separate `mode` field with rules layered on top. The user asked that the mode
  never be hard-coded, and two sources of truth can disagree.

### D18. Live-call log (FR-015b)

- **Source**: the proxy already logs every call, and a run call carries `relive.attribution/choice` (proxy →
  backend contract). `backend-relive`'s `NewCallObserverPort` hook copies each run call whose handling reached
  upstream (LIVE, forwarded branch, unexpected/unattributed SEND_REAL) into `relive_live_calls`: a full copy,
  so Live Calls' size cap or ring buffer can't evict it. The addon reports `reachedUpstream: true` so this never
  depends on the frontend.
- **Retention**: outside the run pruning job. The size shows in the cycle's storage line, and bulk delete is
  offered, but never automatic.
- **Reuse**: "Use as recording" goes through the same versioned PUT as rebuild (D12), so Undo = restore the
  previous version. "Mock with it" is a client-side call-rule edit. Compare reuses D16. Resend and export use
  the existing `backend-resend` and export builders with the stored call (FrozenCall shape).

### D10. Frontend placement

- A new page `pages/relive/` (list) and `pages/relive-cycle/` (overview, configuration, run view,
  all one route with a selected-step drawer), and new components `relive-*` for the step tree,
  mode switch, run timeline, step details and pre-run summary.
- Reused as-is: `rule-dialog`, `scenario-assertion-editor`, `json-path-input`, `answer-picker`,
  `scenario-run-compare`, the call picker, `global-variables` panel styling, and the diff renderer.
- Route and gateway: the SPA page is `/relive`, the API is `/relive-cycles` and the socket is
  `/ws/relive`. The gateway regex gains `relive-cycles`. Because `/relive` is not a backend prefix, no
  `$spa_page` entry is needed.
