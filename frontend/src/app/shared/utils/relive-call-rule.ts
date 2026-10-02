/**
 * The pure core of the call-rule model (FR-010a, research D17): each call in a Relive cycle owns
 * exactly one real ALFRED interception rule. Every button in the step drawer (`relive-step-drawer`,
 * T037) edits this rule; nothing here is a separate stored flag - `mode`, `checkpoint` and
 * `onRequestChanged` are always read back FROM the rule's actions, never stored beside it, so the
 * UI and the proxy (which evaluates the very same rule document) can never disagree about what a
 * call will do.
 *
 * A rule's `actions` is one ordered array (not split by request/response phase - see
 * `actionPhase`/`isTerminalAction` in `interception.model.ts`). This module manages five "owned"
 * actions by their `type` alone (no synthetic id/kind tag is needed, unlike the UX mock, because
 * the real `ActionType` already says what an action does):
 *
 *   - `MOCK_RESPONSE`   -> the REPLAY answer (never contacts upstream)
 *   - `REPLACE_RESPONSE`-> the LIVE_MOCKED answer (upstream IS contacted; only the reply is swapped)
 *   - `PAUSE_REQUEST`   -> the "before" checkpoint
 *   - `PAUSE_RESPONSE`  -> the "after" checkpoint
 *   - `IF_REQUEST` whose single branch tests `RECORDED_CALL` -> the request-differs decision
 *   - `SET_REQUEST_BODY` -> "I edited the whole request" (at most one, the first found)
 *
 * Every other action in the rule (added by the user through the rule editor - a header rewrite, a
 * variable capture, anything) is left exactly where it is; this module only ever inserts, edits or
 * removes its own five kinds, in the fixed order `[PAUSE_REQUEST?, SET_REQUEST_BODY?, IF_REQUEST?,
 * MOCK_RESPONSE?]` followed by the rest of the actions, then `[REPLACE_RESPONSE?, PAUSE_RESPONSE?]`
 * at the very end (both are response-phase - the host really is or was already contacted by then).
 */
import { Condition, ConditionBranch, InterceptionRuleDraft, RuleAction, isTerminalAction } from '../../core/models/interception.model';
import { CycleRule, FrozenCall, ReliveSettings, Step, StepMode, OnRequestChanged } from './relive-types';

const DEFAULT_TIMEOUT_SECONDS = 30;

const FAIL_STATUS = 502;
const FAIL_BODY = JSON.stringify({ error: 'Request differs from the recording - blocked by ALFRED Relive' }, null, 2);

// ---------------------------------------------------------------------------
// Recognising the five owned actions purely from ActionType (+ shape, for the condition).
// ---------------------------------------------------------------------------

function isOurCondition(action: RuleAction): boolean {
  if (action.type !== 'IF_REQUEST' || action.enabled === false) return false;
  const branches = action.branches ?? [];
  if (branches.length !== 1 || branches[0].conditions.length !== 1) return false;
  return branches[0].conditions[0].subject === 'RECORDED_CALL';
}

function findMock(rule: InterceptionRuleDraft): RuleAction | undefined {
  return rule.actions.find((a) => a.type === 'MOCK_RESPONSE');
}
function findReplace(rule: InterceptionRuleDraft): RuleAction | undefined {
  return rule.actions.find((a) => a.type === 'REPLACE_RESPONSE');
}
function findPauseRequest(rule: InterceptionRuleDraft): RuleAction | undefined {
  return rule.actions.find((a) => a.type === 'PAUSE_REQUEST');
}
function findPauseResponse(rule: InterceptionRuleDraft): RuleAction | undefined {
  return rule.actions.find((a) => a.type === 'PAUSE_RESPONSE');
}
function findCondition(rule: InterceptionRuleDraft): RuleAction | undefined {
  return rule.actions.find(isOurCondition);
}
function findBody(rule: InterceptionRuleDraft): RuleAction | undefined {
  return rule.actions.find((a) => a.type === 'SET_REQUEST_BODY');
}

function withActions(rule: CycleRule, actions: readonly RuleAction[]): CycleRule {
  return { ...rule, actions };
}

/** Removes every action of `type`, keeping everything else in place. */
function without(rule: InterceptionRuleDraft, predicate: (a: RuleAction) => boolean): RuleAction[] {
  return rule.actions.filter((a) => !predicate(a));
}

/** Puts the five owned actions back in their fixed relative order; every other action keeps its
 *  existing position (it is never one of `owned`, so `without()` above never touched it). */
function reinsertOwned(rule: InterceptionRuleDraft, owned: { pauseReq?: RuleAction; body?: RuleAction; cond?: RuleAction; mock?: RuleAction; replace?: RuleAction; pauseRes?: RuleAction }): RuleAction[] {
  const rest = without(
    rule,
    (a) => a.type === 'MOCK_RESPONSE' || a.type === 'REPLACE_RESPONSE' || a.type === 'PAUSE_REQUEST' || a.type === 'PAUSE_RESPONSE' || a.type === 'SET_REQUEST_BODY' || isOurCondition(a),
  );
  const front: RuleAction[] = [owned.pauseReq, owned.body, owned.cond, owned.mock].filter((a): a is RuleAction => !!a);
  const back: RuleAction[] = [owned.replace, owned.pauseRes].filter((a): a is RuleAction => !!a);
  return [...front, ...rest, ...back];
}

function currentOwned(rule: InterceptionRuleDraft) {
  return {
    pauseReq: findPauseRequest(rule),
    body: findBody(rule),
    cond: findCondition(rule),
    mock: findMock(rule),
    replace: findReplace(rule),
    pauseRes: findPauseResponse(rule),
  };
}

// ---------------------------------------------------------------------------
// Building fresh owned actions from a step's recording.
// ---------------------------------------------------------------------------

function mockAction(type: 'MOCK_RESPONSE' | 'REPLACE_RESPONSE', recording: FrozenCall): RuleAction {
  return { type, enabled: true, status: recording.status, headers: { ...recording.responseHeaders }, body: recording.responseBody ?? '' };
}

function pauseAction(type: 'PAUSE_REQUEST' | 'PAUSE_RESPONSE', timeoutSeconds: number): RuleAction {
  // A checkpoint that nobody answers carries on with the call's own mode (FR-035d); the proxy
  // resumes the call rule after the pause, so 'release' never skips a REPLAY mock. The ASK pause
  // of the request-differs branch is a failure on timeout whatever this says (relive.py).
  return { type, enabled: true, timeoutSeconds, onTimeout: 'release' };
}

function conditionAction(recordedStepKey: string, otherwise: readonly RuleAction[]): RuleAction {
  const condition: Condition = { subject: 'RECORDED_CALL', operator: 'MATCHES', recordedStepKey, ignore: [] };
  const branch: ConditionBranch = { conditions: [condition], actions: [] };
  return { type: 'IF_REQUEST', enabled: true, branches: [branch], otherwise };
}

function bodyAction(body: string): RuleAction {
  return { type: 'SET_REQUEST_BODY', enabled: true, body };
}

function failOtherwise(): RuleAction[] {
  return [{ type: 'MOCK_RESPONSE', enabled: true, status: FAIL_STATUS, headers: { 'Content-Type': 'application/json' }, body: FAIL_BODY }];
}
function askOtherwise(): RuleAction[] {
  return [pauseAction('PAUSE_REQUEST', DEFAULT_TIMEOUT_SECONDS)];
}
function liveOtherwise(): RuleAction[] {
  return [{ type: 'SEND_TO_HOST', enabled: true }];
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * The rule a freshly frozen step gets (FR-006, FR-010a). A child (`step.parentKey` set) gets a
 * REPLAY pipeline that fails closed when the request differs: `[IF_REQUEST(FAIL), MOCK_RESPONSE]`.
 * A standalone outbound root gets the same safe REPLAY pipeline. An inbound step gets an
 * empty pipeline (runs the real application), unless the cycle's
 * `settings.inboundMode` is `REPLAY`, in which case it gets a plain `MOCK_RESPONSE` too (no
 * request-differs condition - an inbound call has no "recording" to differ from in the same sense).
 */
export function defaultCallRule(step: Pick<Step, 'key' | 'parentKey' | 'label' | 'recording'>, settings: ReliveSettings): CycleRule {
  const base: CycleRule = {
    name: step.label,
    enabled: true,
    priority: 0,
    stopProcessing: true,
    match: {},
    actions: [],
  };
  if (step.parentKey || step.recording.source === 'outbound') {
    const cond = conditionAction(step.key, failOtherwise());
    return withActions(base, [cond, mockAction('MOCK_RESPONSE', step.recording)]);
  }
  if (settings.inboundMode === 'REPLAY') {
    return withActions(base, [mockAction('MOCK_RESPONSE', step.recording)]);
  }
  return base;
}

/**
 * REPLAY turns the mock on (re-creating it from `recording` if it was deleted) and the replace
 * off, keeping its data; LIVE turns both off, keeping their data; LIVE_MOCKED turns the mock off
 * and the replace on (creating it from `recording` if missing). Never touches any other action.
 */
export function applyMode(rule: CycleRule, mode: StepMode, recording: FrozenCall): CycleRule {
  const owned = currentOwned(rule);
  if (mode === 'REPLAY') {
    const mock = owned.mock ?? mockAction('MOCK_RESPONSE', recording);
    const replace = owned.replace ? { ...owned.replace, enabled: false } : undefined;
    return withActions(rule, reinsertOwned(rule, { ...owned, mock: { ...mock, enabled: true }, replace }));
  }
  if (mode === 'LIVE_MOCKED') {
    const replace = owned.replace ?? mockAction('REPLACE_RESPONSE', recording);
    const mock = owned.mock ? { ...owned.mock, enabled: false } : undefined;
    return withActions(rule, reinsertOwned(rule, { ...owned, mock, replace: { ...replace, enabled: true } }));
  }
  // LIVE
  const mock = owned.mock ? { ...owned.mock, enabled: false } : undefined;
  const replace = owned.replace ? { ...owned.replace, enabled: false } : undefined;
  return withActions(rule, reinsertOwned(rule, { ...owned, mock, replace }));
}

/**
 * "Mock with it" (T074, mock.html's `applyMockWith`): overwrites a step's REPLAY mock with a live
 * call's actual status/body, switching the step to REPLAY first if it wasn't already (creating the
 * mock from `recording` the same way `applyMode` does) - so the next run answers with what really
 * came back instead of the original recording.
 */
export function setMockResponse(rule: CycleRule, recording: FrozenCall, status: number, body: string): CycleRule {
  const replayed = applyMode(rule, 'REPLAY', recording);
  const mock = findMock(replayed);
  if (!mock) return replayed;
  const updated = { ...mock, status, body };
  return withActions(replayed, replayed.actions.map((a) => (a === mock ? updated : a)));
}

/** The edited request body ("Replace the request body", FR-014d), or null when the recording's
 *  body is sent as recorded. */
export function requestBodyOf(rule: InterceptionRuleDraft): string | null {
  const action = findBody(rule);
  return action && action.enabled !== false ? (action.body ?? '') : null;
}

/** Sets or clears the edited request body. It sits before the request-differs condition, so the
 *  comparison with the recording sees the user's own edit (FR-014d). */
export function setRequestBody(rule: CycleRule, body: string | null): CycleRule {
  const owned = currentOwned(rule);
  const bodyOwned = body === null ? undefined : { ...(owned.body ?? bodyAction(body)), body, enabled: true };
  return withActions(rule, reinsertOwned(rule, { ...owned, body: bodyOwned }));
}

export function modeOf(rule: InterceptionRuleDraft): StepMode {
  const mock = findMock(rule);
  if (mock && mock.enabled !== false) return 'REPLAY';
  const replace = findReplace(rule);
  if (replace && replace.enabled !== false) return 'LIVE_MOCKED';
  return 'LIVE';
}

/** Places the request-differs condition after the edit actions (pauseReq/body) and before the
 *  mock (research D15/D17). `REPLAY` removes the condition entirely - the recording answers
 *  regardless of any difference. */
export function setOnRequestChanged(rule: CycleRule, choice: OnRequestChanged, recordedStepKey: string): CycleRule {
  const owned = currentOwned(rule);
  if (choice === 'REPLAY') {
    return withActions(rule, reinsertOwned(rule, { ...owned, cond: undefined }));
  }
  const otherwise = choice === 'FAIL' ? failOtherwise() : choice === 'ASK' ? askOtherwise() : liveOtherwise();
  const cond = conditionAction(recordedStepKey, otherwise);
  return withActions(rule, reinsertOwned(rule, { ...owned, cond }));
}

export function onRequestChangedOf(rule: InterceptionRuleDraft): OnRequestChanged {
  const cond = findCondition(rule);
  if (!cond) return 'REPLAY';
  const otherwise = cond.otherwise ?? [];
  const first = otherwise[0];
  if (!first) return 'REPLAY';
  if (first.type === 'SEND_TO_HOST') return 'LIVE';
  if (first.type === 'PAUSE_REQUEST') return 'ASK';
  return 'FAIL';
}

export function setCheckpoint(rule: CycleRule, at: 'before' | 'after', on: boolean, timeoutSeconds = DEFAULT_TIMEOUT_SECONDS): CycleRule {
  const owned = currentOwned(rule);
  if (at === 'before') {
    return withActions(rule, reinsertOwned(rule, { ...owned, pauseReq: on ? pauseAction('PAUSE_REQUEST', timeoutSeconds) : undefined }));
  }
  return withActions(rule, reinsertOwned(rule, { ...owned, pauseRes: on ? pauseAction('PAUSE_RESPONSE', timeoutSeconds) : undefined }));
}

export function checkpointOf(rule: InterceptionRuleDraft): { readonly before: boolean; readonly after: boolean; readonly timeoutSeconds?: number } {
  const before = findPauseRequest(rule);
  const after = findPauseResponse(rule);
  const active = before ?? after;
  return {
    before: !!before && before.enabled !== false,
    after: !!after && after.enabled !== false,
    timeoutSeconds: active?.timeoutSeconds ?? undefined,
  };
}

/** Reaching the real host would need an ordered walk of every enabled path through the rule's
 *  actions, including every `IF_REQUEST` branch and its `otherwise` (research D17's safety
 *  invariant: the supplier is never contacted without an explicit yes). A `PAUSE_REQUEST` never
 *  counts as reaching by itself - it only ever forwards after an explicit human decision, which
 *  this static check cannot see - so it is treated the same as a block. */
export function reachesHost(rule: InterceptionRuleDraft): { readonly reaches: boolean; readonly reason: string | null } {
  const reaches = evalReaches(rule.actions);
  if (!reaches) return { reaches: false, reason: null };
  const mock = findMock(rule);
  const replace = findReplace(rule);
  const cond = findCondition(rule);
  if (replace && replace.enabled !== false) {
    return { reaches: true, reason: "LIVE, reply mocked still calls the real host - only the answer ALFRED gets is the recording" };
  }
  if (cond && onRequestChangedOf(rule) === 'LIVE') {
    return { reaches: true, reason: "its call rule's request-differs choice is Call live - a differing request goes to the real host" };
  }
  if (!mock) {
    return { reaches: true, reason: 'the Mock response was deleted from its call rule' };
  }
  if (mock.enabled === false) {
    return { reaches: true, reason: 'the Mock response in its call rule is turned off' };
  }
  const rewrite = rule.actions.find((a) => a.type === 'REWRITE_URL' && a.enabled !== false);
  if (rewrite) {
    return { reaches: true, reason: "its call rule has “Rewrite URL”" };
  }
  return { reaches: true, reason: 'it is set to LIVE' };
}

/** `nested`: inside an IF branch. A checkpoint (a top-level pause) carries on with the rule once
 *  released or timed out, so it decides nothing; the "Ask me" pause of the request-differs branch
 *  ends in a failure unless someone says yes, so it never reaches the host on its own (T082). */
function classify(action: RuleAction, nested: boolean): 'BLOCK' | 'REACH' | 'IF' | 'PASS' {
  if (action.enabled === false) return 'PASS';
  if (action.type === 'PAUSE_REQUEST') return nested ? 'BLOCK' : 'PASS';
  if (action.type === 'SEND_TO_HOST' || action.type === 'REWRITE_URL') return 'REACH';
  if (action.type === 'IF_REQUEST') return 'IF';
  if (isTerminalAction(action.type)) return 'BLOCK';
  return 'PASS';
}

/** `nestedCount`: how many of the first `actions` come from inside an IF branch. */
function evalReaches(actions: readonly RuleAction[], nestedCount = 0): boolean {
  for (let i = 0; i < actions.length; i++) {
    const action = actions[i];
    const kind = classify(action, i < nestedCount);
    if (kind === 'PASS') continue;
    if (kind === 'BLOCK') return false;
    if (kind === 'REACH') return true;
    // IF: two possible worlds - a branch matched, or none did (otherwise runs) - each continues
    // with whatever comes after this action in `actions` if it didn't itself decide anything.
    const rest = actions.slice(i + 1);
    const branches = action.branches ?? [];
    const restNested = Math.max(0, nestedCount - (i + 1));
    const branchReaches = branches.some((b) => evalReaches([...b.actions, ...rest], b.actions.length + restNested));
    const otherwise = action.otherwise ?? [];
    const otherwiseReaches = evalReaches([...otherwise, ...rest], otherwise.length + restNested);
    return branchReaches || otherwiseReaches;
  }
  return true; // nothing stopped it - the proxy's default behaviour is to forward upstream
}

/** Compares the rule's actions against what `defaultCallRule` would build for this step right
 *  now - anything else (a custom match, a manual edit) makes it "modified" (FR-006/FR-029b). */
export function isModified(rule: InterceptionRuleDraft, step: Pick<Step, 'key' | 'parentKey' | 'label' | 'recording'>, settings: ReliveSettings): boolean {
  const fresh = defaultCallRule(step, settings);
  return JSON.stringify(normalizeForCompare(rule.actions)) !== JSON.stringify(normalizeForCompare(fresh.actions));
}

/** Strips `enabled: true` (the default) so a freshly built and a round-tripped-from-the-backend
 *  rule compare equal even if one omits the field and the other states it explicitly. */
function normalizeForCompare(actions: readonly RuleAction[]): unknown {
  const strip = (a: RuleAction): RuleAction => {
    const { enabled, ...rest } = a;
    const clean: RuleAction = enabled === false ? { ...rest, enabled: false } : (rest as RuleAction);
    if (clean.branches) {
      return { ...clean, branches: clean.branches.map((b) => ({ ...b, actions: b.actions.map(strip) })), otherwise: clean.otherwise?.map(strip) };
    }
    return clean;
  };
  return actions.map(strip);
}
