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
  | 'DELAY_RESPONSE'
  | 'SET_RESPONSE_STATUS'
  | 'SET_RESPONSE_HEADER'
  | 'REMOVE_RESPONSE_HEADER'
  | 'SET_RESPONSE_JSON_FIELD'
  | 'SET_RESPONSE_BODY'
  | 'REPLACE_RESPONSE'
  | 'PAUSE_RESPONSE';

export interface RuleMatch {
  readonly source?: RuleSource | null;
  readonly serviceName?: string | null;
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
}

/**
 * Every field except `action` is optional and means "leave this alone". That is what makes "send
 * unchanged" identical to never having paused: no status, no headers and no body means the proxy
 * rewrites nothing and a body that was never edited is never re-serialised.
 */
export interface PauseDecision {
  readonly action: 'release' | 'abort';
  readonly status?: number | null;
  readonly headers?: Record<string, string> | null;
  readonly body?: string | null;
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
   * What the supplier ACTUALLY sent, kept alongside what the caller actually received, whenever a
   * human edited a paused response. Without it the log quietly becomes fiction - which is the one
   * thing a traffic logger must never do.
   */
  readonly upstreamResponse?: PausedHttp | null;
}

/** Metadata for the action picker, served by the backend so the list lives in one place. */
export interface ActionTypeInfo {
  readonly type: ActionType;
  readonly phase: ActionPhase;
  readonly terminal: boolean;
  readonly pause: boolean;
}

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
  DELAY_RESPONSE: 'Delay response',
  SET_RESPONSE_STATUS: 'Set response status',
  SET_RESPONSE_HEADER: 'Set response header',
  REMOVE_RESPONSE_HEADER: 'Remove response header',
  SET_RESPONSE_JSON_FIELD: 'Set JSON field in response body',
  SET_RESPONSE_BODY: 'Replace the response body',
  REPLACE_RESPONSE: 'Reply with a different response',
  PAUSE_RESPONSE: 'Pause and wait for me (after the supplier answers)',
};

export function describeMatch(match: RuleMatch): string {
  const parts: string[] = [];
  const source = match.source ?? 'both';
  parts.push(source === 'both' ? 'any direction' : source);
  if (match.serviceName) parts.push(match.serviceName);
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
    case 'SET_RESPONSE_BODY':
      return `Replace response body (${(action.body ?? '').length} chars)`;
    case 'REPLACE_RESPONSE':
      return action.status ? `Reply with ${action.status} — host still called` : 'Reply with a different response';
    case 'PAUSE_REQUEST':
    case 'PAUSE_RESPONSE':
      return `Pause ${action.type === 'PAUSE_REQUEST' ? 'request' : 'response'} — wait ${action.timeoutSeconds}s`;
    default:
      return label;
  }
}

export function isPauseAction(type: ActionType): boolean {
  return type === 'PAUSE_REQUEST' || type === 'PAUSE_RESPONSE';
}

export function isTerminalAction(type: ActionType): boolean {
  return type === 'ABORT_REQUEST' || type === 'MOCK_RESPONSE';
}

/**
 * MOCK_RESPONSE is a REQUEST-phase action despite its name: it short-circuits before the request is
 * ever forwarded. REPLACE_RESPONSE is the response-phase counterpart - the host really is called,
 * and only the reply the caller gets is swapped.
 */
export function actionPhase(type: ActionType): ActionPhase {
  return type.includes('RESPONSE') && type !== 'MOCK_RESPONSE' ? 'response' : 'request';
}
