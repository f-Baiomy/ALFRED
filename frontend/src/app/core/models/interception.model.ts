/**
 * Interception rules and paused calls, as the backend's backend-interception slice serves them.
 *
 * These types are the wire shape verbatim - the backend publishes the very same JSON to the proxy,
 * so a rule the UI builds here is byte-for-byte what proxy/interception.py evaluates. That is why
 * there is no separate "form model" mapped onto a "wire model": a second representation would be a
 * second place for an action's field names to drift out of step with the engine that reads them.
 */

/** Which direction a rule applies to. `both` and `null` mean the same thing; the UI writes `both`. */
export type RuleSource = 'outbound' | 'inbound' | 'both';

export type ActionPhase = 'request' | 'response';

export type ActionType =
  | 'DELAY_REQUEST'
  | 'SET_REQUEST_HEADER'
  | 'REMOVE_REQUEST_HEADER'
  | 'SET_QUERY_PARAM'
  | 'REMOVE_QUERY_PARAM'
  | 'SET_REQUEST_JSON_FIELD'
  | 'ABORT_REQUEST'
  | 'MOCK_RESPONSE'
  | 'PAUSE_REQUEST'
  | 'SEND_TO_HOST'
  | 'SIMULATE_FAILURE'
  | 'IF_REQUEST'
  | 'DELAY_RESPONSE'
  | 'SET_RESPONSE_STATUS'
  | 'SET_RESPONSE_HEADER'
  | 'REMOVE_RESPONSE_HEADER'
  | 'SET_RESPONSE_JSON_FIELD'
  | 'SET_RESPONSE_BODY'
  | 'REPLACE_RESPONSE'
  | 'PAUSE_RESPONSE'
  | 'IF_RESPONSE';

/**
 * How a call can be broken at the transport level rather than with a status code.
 *
 * Deliberately does not include a DNS or TLS failure: the caller is connected to Alfred, and its
 * handshake with Alfred succeeded long before any rule was evaluated, so the connection those
 * would have to break is one that demonstrably works. Offering them would be a lie in a dropdown.
 */
export type FailureMode =
  | 'CONNECTION_RESET'
  | 'HANG_THEN_DROP'
  | 'HANG_UNTIL_CALLER_GIVES_UP'
  | 'EMPTY_REPLY'
  | 'TRUNCATED_BODY'
  | 'GATEWAY_ERROR';

/**
 * What part of a call a condition looks at.
 *
 * Response subjects are legal only inside an `IF_RESPONSE` - in the request phase there is no
 * response, so a condition on one could only ever be false. The reverse is allowed and is one of
 * the main reasons to have conditions: "if we sent X and got back Y".
 */
export type ConditionSubject =
  | 'REQUEST_HEADER'
  | 'REQUEST_BODY'
  | 'REQUEST_JSON_FIELD'
  | 'QUERY_PARAM'
  | 'URL'
  | 'METHOD'
  | 'RESPONSE_STATUS'
  | 'RESPONSE_HEADER'
  | 'RESPONSE_BODY'
  | 'RESPONSE_JSON_FIELD';

export type ConditionOperator =
  | 'EXISTS'
  | 'NOT_EXISTS'
  | 'EQUALS'
  | 'NOT_EQUALS'
  | 'CONTAINS'
  | 'NOT_CONTAINS'
  | 'MATCHES'
  | 'NOT_MATCHES'
  | 'AT_LEAST'
  | 'AT_MOST';

export interface Condition {
  readonly subject: ConditionSubject;
  /** Header name, query parameter name, or dotted JSON path - see SUBJECTS_NEEDING_NAME. */
  readonly name?: string | null;
  readonly operator: ConditionOperator;
  /** Absent for EXISTS / NOT_EXISTS, which compare against nothing. */
  readonly value?: string | null;
  readonly caseSensitive?: boolean | null;
}

/** One arm of a conditional. Branches are tried in order and the first match wins. */
export interface ConditionBranch {
  readonly combine?: 'ALL' | 'ANY' | null;
  readonly conditions: readonly Condition[];
  readonly actions: readonly RuleAction[];
}

export interface RuleMatch {
  readonly source?: RuleSource | null;
  /** Superseded by `serviceNames`; only ever read, never written - see the backend's RuleMatch. */
  readonly serviceName?: string | null;
  /** Any of these projects matches. Empty or absent means any project at all. */
  readonly serviceNames?: readonly string[];
  readonly methods?: readonly string[];
  readonly host?: string | null;
  readonly pathContains?: string | null;
  readonly pathRegex?: string | null;
}

export interface RuleAction {
  readonly type: ActionType;
  readonly durationMs?: number | null;
  readonly name?: string | null;
  readonly value?: unknown;
  readonly path?: string | null;
  readonly status?: number | null;
  readonly headers?: Readonly<Record<string, string>> | null;
  readonly body?: string | null;
  readonly timeoutSeconds?: number | null;
  readonly onTimeout?: 'release' | 'abort' | null;
  /** SIMULATE_FAILURE only. */
  readonly failure?: FailureMode | null;
  /** IF_REQUEST / IF_RESPONSE only: the arms, tried in order. */
  readonly branches?: readonly ConditionBranch[] | null;
  /** IF_REQUEST / IF_RESPONSE only: what runs when no branch matched. */
  readonly otherwise?: readonly RuleAction[] | null;
  /**
   * Whether the engine actually runs this action. Absent or true means enabled - this is
   * something you turn OFF, not on, so every rule saved before this field existed keeps working.
   * Disabling an IF_REQUEST/IF_RESPONSE disables its whole subtree; there is no separate flag for
   * what is nested inside a condition that is not running at all.
   */
  readonly enabled?: boolean | null;
}

/** True unless explicitly set to false - the same default the backend and proxy both use. */
export function isActionEnabled(action: RuleAction): boolean {
  return action.enabled !== false;
}

export interface InterceptionRule {
  readonly id: string;
  readonly name: string;
  readonly description?: string | null;
  readonly enabled: boolean;
  readonly priority: number;
  readonly stopProcessing: boolean;
  readonly match: RuleMatch;
  readonly actions: readonly RuleAction[];
  readonly createdAt?: string | null;
  readonly updatedAt?: string | null;
}

/**
 * What happened to each rule in an imported file.
 *
 * Per rule rather than one pass/fail: discarding nine working rules because a tenth is malformed
 * is the worse failure, and a quiet partial import is worse still - so every rejection carries
 * the validator's own words and the position it had in the file.
 */
export interface RuleImportResult {
  readonly imported: number;
  readonly rejected: number;
  readonly results: readonly RuleImportOutcome[];
}

export interface RuleImportOutcome {
  readonly index: number;
  readonly name?: string | null;
  readonly status: 'imported' | 'rejected';
  readonly id?: string | null;
  readonly problems?: readonly string[] | null;
}

/** What POST/PUT accept - id and timestamps are assigned server-side. */
export interface InterceptionRuleDraft {
  readonly name: string;
  readonly description?: string | null;
  readonly enabled?: boolean;
  readonly priority?: number;
  readonly stopProcessing?: boolean;
  readonly match: RuleMatch;
  readonly actions: readonly RuleAction[];
}

export interface PausedHttp {
  readonly status?: number | null;
  readonly headers?: Readonly<Record<string, string>> | null;
  readonly body?: string | null;
}

/**
 * One half of an exchange as it was BEFORE anything touched it.
 *
 * `status`/`reason` are set for a response only, `method`/`url` for a request only. The url
 * matters more than it looks: a rule that rewrites a query parameter changes nothing else, so a
 * snapshot without it would show two identical copies.
 */
export interface OriginalHttp {
  readonly status?: number | null;
  readonly reason?: string | null;
  readonly method?: string | null;
  readonly url?: string | null;
  readonly headers?: Readonly<Record<string, string>> | null;
  readonly body?: string | null;
}

/**
 * A call the proxy is holding open while somebody decides what happens to it.
 *
 * `pausedAt` is stamped by the BACKEND, not the proxy, so the countdown is measured on the same
 * clock the rest of this page reads - two containers' clocks routinely differ by enough to show a
 * timer that starts at 27 seconds instead of 30.
 */
export interface PausedCall {
  readonly callId: string;
  readonly phase: ActionPhase;
  readonly source: string;
  readonly serviceName?: string | null;
  readonly ruleId?: string | null;
  readonly ruleName?: string | null;
  readonly timeoutSeconds: number;
  readonly onTimeout?: string | null;
  readonly method: string;
  readonly url: string;
  readonly request?: PausedHttp | null;
  readonly response?: PausedHttp | null;
  readonly pausedAt: number;
  /**
   * Epoch millis somebody took control, or absent while the call is only paused.
   *
   * `timeoutSeconds` is a grace period for a human to NOTICE the call, not a deadline for deciding
   * what to do with it. Once this is set the countdown stops and the call waits for an explicit
   * decision - otherwise a large body could never be read and edited before the call was released
   * from under you.
   */
  readonly heldAt?: number | null;
  /** Holding a caller, in flight upstream, or finished. Absent on a payload from an older proxy. */
  readonly stage?: PauseStage | null;
  readonly cycle?: PauseCycle | null;
}

/**
 * Where a card in the inspector physically is.
 *
 * Only `holding` has a real client socket open on the other end of it, and that is the whole
 * reason the three are distinguished: it is the only one that counts towards the badge in the tab
 * bar. A single number covering all three would have the badge shouting about calls nobody is
 * waiting on, which teaches you to ignore it.
 */
export type PauseStage = 'holding' | 'in-flight' | 'finished';

/** What has happened to a call beyond the one half a rule paused it on. */
export interface PauseCycle {
  /** Whether the user asked to be stopped again when the supplier answered. */
  readonly follow: boolean;
  readonly releasedAt?: number | null;
  readonly finishedAt?: number | null;
  readonly durationMs?: number | null;
  /** 'completed' | 'aborted' | 'failed' | 'never-came-back'. Absent until the cycle ends. */
  readonly outcome?: string | null;
  readonly note?: string | null;
  /** What the user changed on the way out - header NAMES only, never values. */
  readonly requestEdit?: string | null;
  readonly responseEdit?: string | null;
}

/**
 * A `simulate_failure` decision's payload - exactly the shape `RuleAction`'s SIMULATE_FAILURE
 * fields already carry (`failure`/`durationMs`/`status`/`body`), just grouped under one key here
 * instead of spread across the action record, since a decision has no other use for those four
 * names. Read by proxy/interception.py's `failure_plan` - the SAME function a rule's
 * SIMULATE_FAILURE action already goes through, so a mode means exactly the same thing whether it
 * came from a rule or from a human resolving a paused call by hand.
 */
export interface PauseFailure {
  readonly mode: FailureMode;
  /** HANG_THEN_DROP only. */
  readonly durationMs?: number | null;
  /** GATEWAY_ERROR only. */
  readonly status?: number | null;
  /** TRUNCATED_BODY only. */
  readonly body?: string | null;
}

/**
 * Every field except `action` is optional and means "leave this alone". That is what makes "send
 * unchanged" identical to never having paused: no status, no headers and no body means the proxy
 * rewrites nothing and a body that was never edited is never re-serialised.
 */
export interface PauseDecision {
  readonly action: 'release' | 'abort' | 'simulate_failure';
  readonly status?: number | null;
  /**
   * A null VALUE removes that header; an absent key leaves it untouched. That asymmetry is the
   * whole reason this is a patch rather than the full set - changing one header on a call with
   * forty must not rewrite the other thirty-nine.
   */
  readonly headers?: Record<string, string | null> | null;
  readonly body?: string | null;
  /**
   * Stop this call again when the supplier answers. Only meaningful releasing a request half.
   *
   * Note this is NOT what keeps the card on screen - a call you decided on is always followed to
   * the end of its cycle. This is only whether Alfred holds the caller a second time.
   */
  readonly follow?: boolean;
  /** action: 'simulate_failure' only - what to reproduce instead of releasing or aborting plainly. */
  readonly failure?: PauseFailure | null;
}

/** One rule's effect on one call, as recorded on the call itself by the proxy. */
export interface AppliedInterception {
  readonly ruleId?: string | null;
  readonly ruleName?: string | null;
  readonly action: string;
  readonly detail?: string | null;
}

/**
 * The `interception` object the proxy attaches to a call's webhook when a rule touched it. Absent
 * entirely on a call no rule matched, which is what keeps an ordinary call's payload identical to
 * what it was before this feature existed.
 */
export interface CallInterception {
  readonly applied: readonly AppliedInterception[];
  /**
   * The request as the CLIENT sent it, present whenever a rule or a human changed it before it
   * went upstream. Absent means the request was never modified - which is not the same as "not
   * recorded", and the UI must not imply otherwise.
   */
  readonly originalRequest?: OriginalHttp | null;
  /** The response as UPSTREAM actually sent it, present whenever anything changed it. */
  readonly originalResponse?: OriginalHttp | null;
  /**
   * The request as it ACTUALLY went upstream, and the response as the caller ACTUALLY received it.
   *
   * Present alongside the originals whenever that half was modified. Not redundant with the
   * logged call: the request half is written to the log at PREPARE time, before a request
   * breakpoint lets anyone edit it, so diffing against the log would show no change on a
   * hand-edited request while the record insisted one was made.
   */
  readonly finalRequest?: OriginalHttp | null;
  readonly finalResponse?: OriginalHttp | null;
}

/** Whether a human, rather than only a rule, changed this call. Drives the stronger badge. */
export function wasEditedByHand(interception: CallInterception | null | undefined): boolean {
  return (interception?.applied ?? []).some((a) => a.action.startsWith('BREAKPOINT_'));
}

/**
 * Whether there is anything to show a before/after of.
 *
 * Either end counts. A mocked response has a final side and no original - the host was never
 * contacted - and that is the case a test most wants to see, not the one to hide.
 */
export function hasBeforeAfter(interception: CallInterception | null | undefined): boolean {
  return (
    interception?.originalRequest != null ||
    interception?.originalResponse != null ||
    interception?.finalRequest != null ||
    interception?.finalResponse != null
  );
}

/** Metadata for the action picker, served by the backend so the list lives in one place. */
export interface ActionTypeInfo {
  readonly type: ActionType;
  readonly phase: ActionPhase;
  readonly terminal: boolean;
  readonly pause: boolean;
  /**
   * Whether the picker offers it. ABORT_REQUEST is not: it is exactly SIMULATE_FAILURE with
   * CONNECTION_RESET, and a rule already using it still has to render and still fires.
   */
  readonly selectable?: boolean;
}

/** What each failure mode is called, and what the caller actually experiences. */
export const FAILURE_LABELS: Readonly<Record<FailureMode, string>> = {
  CONNECTION_RESET: 'Reset the connection immediately',
  HANG_THEN_DROP: 'Hang, then drop the connection',
  HANG_UNTIL_CALLER_GIVES_UP: 'Hang until the caller gives up',
  EMPTY_REPLY: 'Empty reply (200, no body)',
  TRUNCATED_BODY: 'Truncated body (cut short of its length)',
  GATEWAY_ERROR: 'Gateway failure (502 / 503 / 504)',
};

export const FAILURE_HINTS: Readonly<Record<FailureMode, string>> = {
  CONNECTION_RESET:
    'Killed before forwarding. The caller sees a reset or EOF, not a status code - the host is never contacted.',
  HANG_THEN_DROP:
    'Accepted, held, then dropped. Reproduces a supplier that goes quiet mid-call; what you are testing is how your client handles a read timeout.',
  HANG_UNTIL_CALLER_GIVES_UP:
    'Held until your client gives up on its own. Alfred never ends it, so what you are testing is whether the client HAS a timeout at all.',
  EMPTY_REPLY:
    'A valid 200 with zero bytes. Parses as HTTP and breaks anything that assumes there is a body to read.',
  TRUNCATED_BODY:
    'Part of the body arrives, then the connection closes short of the length it promised - which client libraries report very differently from an empty reply.',
  GATEWAY_ERROR:
    'An intermediary failing rather than the supplier answering. The host is never contacted.',
};

/**
 * Every failure mode as a {value, label} pair for a `<app-select-picker>`. Exported (rather than a
 * private const rebuilt in each place that offers this list) so the rule editor's SIMULATE_FAILURE
 * picker and the paused-call inspector's "mock a network failure instead" control read from the
 * exact same list - one dropdown never drifts from the other's set of modes or wording. Not typed
 * against SelectOption to avoid a models -> components import; the shape is structurally identical.
 */
export const FAILURE_OPTIONS: ReadonlyArray<{ readonly value: FailureMode; readonly label: string }> = (
  Object.keys(FAILURE_LABELS) as FailureMode[]
).map((mode) => ({ value: mode, label: FAILURE_LABELS[mode] }));

/** The three statuses an intermediary (rather than the supplier) actually produces - see GATEWAY_ERROR. */
export const GATEWAY_STATUSES: readonly number[] = [502, 503, 504];

/** Human labels for the action picker and the rule list's chips. */
export const ACTION_LABELS: Readonly<Record<ActionType, string>> = {
  DELAY_REQUEST: 'Delay request',
  SET_REQUEST_HEADER: 'Set request header',
  REMOVE_REQUEST_HEADER: 'Remove request header',
  SET_QUERY_PARAM: 'Set query parameter',
  REMOVE_QUERY_PARAM: 'Remove query parameter',
  SET_REQUEST_JSON_FIELD: 'Set JSON field in request body',
  ABORT_REQUEST: 'Abort request (kill the connection)',
  MOCK_RESPONSE: 'Mock response (never contact upstream)',
  PAUSE_REQUEST: 'Pause and wait for me (before forwarding)',
  SEND_TO_HOST: 'Send the call to the host',
  SIMULATE_FAILURE: 'Simulate a failure (network, not a status)',
  IF_REQUEST: 'Condition — look at the request, then decide',
  DELAY_RESPONSE: 'Delay response',
  SET_RESPONSE_STATUS: 'Set response status',
  SET_RESPONSE_HEADER: 'Set response header',
  REMOVE_RESPONSE_HEADER: 'Remove response header',
  SET_RESPONSE_JSON_FIELD: 'Set JSON field in response body',
  SET_RESPONSE_BODY: 'Replace the response body',
  REPLACE_RESPONSE: 'Reply with a different response',
  PAUSE_RESPONSE: 'Pause and wait for me (after the supplier answers)',
  IF_RESPONSE: 'Condition — look at the response, then decide',
};

export const SUBJECT_LABELS: Readonly<Record<ConditionSubject, string>> = {
  REQUEST_HEADER: 'Request header',
  REQUEST_BODY: 'Request body',
  REQUEST_JSON_FIELD: 'Request JSON field',
  QUERY_PARAM: 'Query parameter',
  URL: 'URL',
  METHOD: 'Method',
  RESPONSE_STATUS: 'Response status',
  RESPONSE_HEADER: 'Response header',
  RESPONSE_BODY: 'Response body',
  RESPONSE_JSON_FIELD: 'Response JSON field',
};

export const OPERATOR_LABELS: Readonly<Record<ConditionOperator, string>> = {
  EXISTS: 'exists',
  NOT_EXISTS: 'does not exist',
  EQUALS: 'equals',
  NOT_EQUALS: 'does not equal',
  CONTAINS: 'contains',
  NOT_CONTAINS: 'does not contain',
  MATCHES: 'matches regex',
  NOT_MATCHES: 'does not match regex',
  AT_LEAST: 'is at least',
  AT_MOST: 'is at most',
};

/** Subjects that need a header name, parameter name or field path to identify the value. */
export const SUBJECTS_NEEDING_NAME: ReadonlySet<ConditionSubject> = new Set<ConditionSubject>([
  'REQUEST_HEADER',
  'REQUEST_JSON_FIELD',
  'QUERY_PARAM',
  'RESPONSE_HEADER',
  'RESPONSE_JSON_FIELD',
]);

/** Subjects that do not exist yet in the request phase. */
export const RESPONSE_SUBJECTS: ReadonlySet<ConditionSubject> = new Set<ConditionSubject>([
  'RESPONSE_STATUS',
  'RESPONSE_HEADER',
  'RESPONSE_BODY',
  'RESPONSE_JSON_FIELD',
]);

/** Operators that compare against nothing, so the value field is meaningless for them. */
export const OPERATORS_WITHOUT_VALUE: ReadonlySet<ConditionOperator> = new Set<ConditionOperator>([
  'EXISTS',
  'NOT_EXISTS',
]);

export function isConditionalAction(type: ActionType): boolean {
  return type === 'IF_REQUEST' || type === 'IF_RESPONSE';
}

/** "request header x-api-key does not exist" - the plain-language form, used in the editor and the log. */
export function describeCondition(condition: Condition): string {
  const subject = SUBJECT_LABELS[condition.subject] ?? condition.subject;
  const head = condition.name ? `${subject} ${condition.name}` : subject;
  const operator = OPERATOR_LABELS[condition.operator] ?? condition.operator;
  if (OPERATORS_WITHOUT_VALUE.has(condition.operator)) return `${head} ${operator}`;
  return `${head} ${operator} ${condition.value ?? ''}`.trim();
}

export function describeBranch(branch: ConditionBranch): string {
  const joiner = branch.combine === 'ANY' ? ' or ' : ' and ';
  return branch.conditions.map(describeCondition).join(joiner);
}

export function describeMatch(match: RuleMatch): string {
  const parts: string[] = [];
  const source = match.source ?? 'both';
  parts.push(source === 'both' ? 'any direction' : source);
  const projects = match.serviceNames?.length ? match.serviceNames : (match.serviceName ? [match.serviceName] : []);
  if (projects.length) parts.push(projects.join(' or '));
  parts.push(match.methods?.length ? match.methods.join('/') : 'any method');
  if (match.host) parts.push(match.host);
  if (match.pathContains) parts.push(`path contains ${match.pathContains}`);
  if (match.pathRegex) parts.push(`path ~ ${match.pathRegex}`);
  return parts.join(' · ');
}

/** The one-line summary shown on a rule's chip - "Delay request 10,000 ms" rather than a raw type. */
export function describeAction(action: RuleAction): string {
  const label = ACTION_LABELS[action.type] ?? action.type;
  switch (action.type) {
    case 'DELAY_REQUEST':
    case 'DELAY_RESPONSE':
      return `${label} ${(action.durationMs ?? 0).toLocaleString()} ms`;
    case 'SET_REQUEST_HEADER':
    case 'SET_RESPONSE_HEADER':
    case 'SET_QUERY_PARAM':
      return `${label} ${action.name}`;
    case 'REMOVE_REQUEST_HEADER':
    case 'REMOVE_RESPONSE_HEADER':
    case 'REMOVE_QUERY_PARAM':
      return `${label} ${action.name}`;
    case 'SET_REQUEST_JSON_FIELD':
    case 'SET_RESPONSE_JSON_FIELD':
      return `Set ${action.path} = ${JSON.stringify(action.value)}`;
    case 'SET_RESPONSE_STATUS':
      return `${label} ${action.status}`;
    case 'MOCK_RESPONSE':
      return `Mock ${action.status} — host never called`;
    case 'SEND_TO_HOST':
      return 'Send to the host';
    case 'SIMULATE_FAILURE':
      return action.failure ? FAILURE_LABELS[action.failure] : 'Simulate a failure';
    case 'IF_REQUEST':
    case 'IF_RESPONSE': {
      const branches = action.branches?.length ?? 0;
      const otherwise = action.otherwise?.length ? ' · else' : '';
      return `If ${branches === 1 ? '1 condition' : `${branches} branches`}${otherwise}`;
    }
    case 'SET_RESPONSE_BODY':
      return `Replace response body (${(action.body ?? '').length} chars)`;
    case 'REPLACE_RESPONSE':
      return action.status ? `Reply with ${action.status} — host still called` : 'Reply with a different response';
    case 'PAUSE_REQUEST':
    case 'PAUSE_RESPONSE':
      // The timeout can genuinely be missing: this also describes rules read out of an imported
      // file, before the backend has had a chance to reject one. "wait undefineds" is not a
      // useful thing to print on the screen whose job is to show you an untrusted file.
      return (
        `Pause ${action.type === 'PAUSE_REQUEST' ? 'request' : 'response'} — ` +
        (action.timeoutSeconds == null ? 'no timeout set' : `wait ${action.timeoutSeconds}s`)
      );
    default:
      return label;
  }
}

export function isPauseAction(type: ActionType): boolean {
  return type === 'PAUSE_REQUEST' || type === 'PAUSE_RESPONSE';
}

export function isTerminalAction(type: ActionType): boolean {
  return type === 'ABORT_REQUEST' || type === 'MOCK_RESPONSE' || type === 'SIMULATE_FAILURE';
}

/**
 * MOCK_RESPONSE is a REQUEST-phase action despite its name: it short-circuits before the request is
 * ever forwarded. REPLACE_RESPONSE is the response-phase counterpart - the host really is called,
 * and only the reply the caller gets is swapped.
 */
export function actionPhase(type: ActionType): ActionPhase {
  return type.includes('RESPONSE') && type !== 'MOCK_RESPONSE' ? 'response' : 'request';
}
