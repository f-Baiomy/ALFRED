/**
 * TypeScript mirror of `specs/003-relive-cycle/data-model.md`. Names in comments below are the
 * wire names from that file; keep this in step with it rather than re-deriving shapes by hand.
 *
 * `InterceptionRuleDraft` is imported, not redefined, so a Relive rule (a call rule, a cycle
 * rule, an unexpected-call rule) is byte-for-byte the same document the rule editor already
 * knows how to render and the proxy already knows how to evaluate - see FR-029a.
 */
import type { InterceptionRuleDraft } from '../../core/models/interception.model';
import type { ExtractRule } from './scenario-types';
import type { StepAssertions } from './relive-checks';

export type ReliveDriver = 'AUTOMATIC' | 'GUIDED';
export type GlobalRulesMode = 'NONE' | 'ALL' | 'SELECTED';
export type InboundMode = 'LIVE' | 'REPLAY';
export type OnFailurePolicy = 'HOLD' | 'CONTINUE';
export type OnDifferencesPolicy = 'CONTINUE' | 'HOLD';
export type UnattributedChoice = 'BLOCK' | 'REPLAY_ANYWAY' | 'SEND_REAL';
export type UnexpectedCallsPolicyKind = 'BLOCK' | 'SEND_REAL' | 'RULES';
export type StepMode = 'REPLAY' | 'LIVE' | 'LIVE_MOCKED';
export type OnRequestChanged = 'FAIL' | 'ASK' | 'REPLAY' | 'LIVE';

/** An interception rule document plus where it was copied from, if anywhere (FR-025-029b). */
export interface CycleRule extends InterceptionRuleDraft {
  readonly copiedFrom?: { readonly ruleId: string; readonly name: string; readonly copiedAt: string } | null;
}

export interface NoiseRule {
  readonly part: 'status' | 'header' | 'body' | 'query';
  readonly path: string;
  readonly auto: boolean;
  readonly count: boolean;
}

export interface GlobalRulesSelection {
  readonly mode: GlobalRulesMode;
  readonly selectedIds: readonly string[];
}

export interface UnexpectedCallsPolicy {
  readonly policy: UnexpectedCallsPolicyKind;
  readonly rules: readonly CycleRule[];
  readonly fallback: 'BLOCK' | 'SEND_REAL';
}

export interface ReliveSettings {
  readonly inboundMode: InboundMode;
  readonly onFailure: OnFailurePolicy;
  readonly onDifferences: OnDifferencesPolicy;
  readonly defaultDriver: ReliveDriver;
  /** Hosts (or suffixes, e.g. ".internal") that never count as "reaching an external system". */
  readonly internalHosts: readonly string[];
  /** Automatic runs: each Set-Cookie a step receives replaces that cookie in later steps' Cookie
   *  header (relive-session.ts). Absent (a cycle saved before it) reads as on. */
  readonly carryCookies?: boolean;
  /** A REPLAY supplier call still matches its recording when only its Authorization header is
   *  new - the app authenticating itself. Read by the proxy; absent reads as on. */
  readonly replayIgnoresCredentials?: boolean;
}

/** The recorded call as ALFRED already serves it in call detail (data-model.md "FrozenCall"). */
export interface FrozenCall {
  readonly method: string;
  readonly url: string;
  readonly requestHeaders: Readonly<Record<string, string>>;
  readonly requestBody?: string | null;
  readonly status: number;
  readonly responseHeaders: Readonly<Record<string, string>>;
  readonly responseBody?: string | null;
  readonly timestamp: string;
  readonly durationMs: number;
  readonly sessionId?: string | null;
  readonly operationId?: string | null;
  readonly serviceName?: string | null;
  readonly source: 'outbound' | 'inbound';
}

export interface CycleVariable {
  readonly name: string;
  readonly value: string;
  readonly secret: boolean;
  readonly note?: string | null;
}

/** `mode`, `checkpoint`, `onRequestChanged` and `modified` are NOT fields here - they are derived
 *  by `relive-call-rule.ts` from `callRule` (data-model.md Step, "Derived, never stored"). */
export interface Step {
  readonly key: string;
  readonly parentKey?: string | null;
  readonly label: string;
  readonly enabled: boolean;
  readonly optional: boolean;
  readonly direction: 'inbound' | 'outbound';
  readonly serviceName?: string | null;
  readonly callRule: CycleRule;
  readonly unattributed: UnattributedChoice;
  readonly recording: FrozenCall;
  readonly source: { readonly callId: string; readonly cycleId: string | null; readonly direction: 'outbound' | 'inbound' };
  readonly extract: readonly ExtractRule[];
  /** The step's checks (relive-checks.ts `StepChecks`); an older Assertion[] in a step saved before them - read with `stepChecks`. */
  readonly assertions: StepAssertions;
  readonly noise: readonly NoiseRule[];
  /** Persisted SEMANTIC_V1 hash of an outbound request. Absent until the cycle is saved. */
  readonly fingerprint?: string | null;
  readonly fingerprintVersion?: string | null;
}

export interface RunSummary {
  readonly total: number;
  readonly completed: number;
  readonly different: number;
  readonly failed: number;
  readonly skipped: number;
  readonly notCalled: number;
  readonly cancelled: number;
  readonly live: number;
  readonly replayed: number;
  readonly unattributed: number;
}

export interface ReliveCycle {
  readonly id: string;
  readonly name: string;
  readonly description?: string | null;
  readonly steps: readonly Step[];
  readonly variables: readonly CycleVariable[];
  readonly cycleRules: readonly CycleRule[];
  readonly globalRules: GlobalRulesSelection;
  readonly settings: ReliveSettings;
  readonly noise: readonly NoiseRule[];
  readonly unexpectedCalls: UnexpectedCallsPolicy;
  readonly createdAt?: string | null;
  readonly updatedAt?: string | null;
  readonly transient: boolean;
  readonly lastRun?: RunSummary | null;
}

/** The cycles list row - headers only, matching backend `ReliveCycleSummary` (no `steps`/`variables`/`cycleRules` bodies). */
export interface ReliveCycleSummary {
  readonly id: string;
  readonly name: string;
  readonly description?: string | null;
  readonly stepCount: number;
  readonly childCount: number;
  readonly liveCount: number;
  readonly cycleRuleCount: number;
  readonly lastRun?: RunSummary | null;
  readonly createdAt?: string | null;
  readonly updatedAt?: string | null;
  readonly isTransient: boolean;
}

export interface CycleVersion {
  readonly cycleId: string;
  readonly version: number;
  readonly savedAt: string;
  readonly reason: 'REBUILD_REFRESH' | 'REBUILD_RECORDING' | 'REBUILD_START_OVER' | 'REPLACE_STEPS';
  readonly definition: ReliveCycle;
}

export type StepState =
  | 'PENDING'
  | 'WAITING'
  | 'PAUSED'
  | 'RUNNING'
  | 'REPLAYED'
  | 'LIVE'
  | 'INTERCEPTED'
  | 'COMPLETED'
  | 'COMPLETED_WITH_DIFFERENCES'
  | 'FAILED'
  | 'SKIPPED'
  | 'NOT_CALLED'
  | 'CANCELLED';

export interface DifferenceEntry {
  readonly part: string;
  readonly path: string;
  readonly recorded: string | null;
  readonly actual: string | null;
  readonly kind: 'EXPECTED' | 'NOISE_AUTO' | 'NOISE_USER' | 'UNEXPECTED';
  readonly cause?: string | null;
}

export interface RuleApplied {
  readonly ruleId: string;
  readonly name: string;
  readonly tier: 'STEP' | 'CYCLE' | 'GLOBAL';
  readonly actions?: readonly string[];
}

/** Same shape as backend `UnexpectedCallEntry`. */
export interface UnexpectedCallEntry {
  readonly callId: string;
  readonly method: string | null;
  readonly url: string | null;
  readonly handledBy: 'BLOCK' | 'SEND_REAL' | 'RULES' | null;
  readonly handledByRuleId?: string | null;
  readonly handledByRuleName?: string | null;
  readonly reachedExternal: boolean;
}

export interface RequestChangedEntry {
  readonly changes: readonly { readonly part: string; readonly path: string; readonly recorded: string | null; readonly actual: string | null }[];
  readonly decision: 'REPLAY' | 'SEND_REAL' | 'EDIT_REPLAY' | 'FAIL' | 'TIMEOUT';
}

export interface PauseEntry {
  readonly at: 'BEFORE' | 'AFTER';
  readonly since: string;
  readonly resolvedAt?: string | null;
  readonly choice?: 'CONTINUE' | 'REPLAY' | 'EDIT_REPLAY' | 'SKIP' | 'STOP' | 'TIMEOUT' | null;
  readonly breakpointId?: string | null;
}

export interface StepResult {
  readonly runId: string;
  readonly stepKey: string;
  readonly attempt: number;
  readonly state: StepState;
  readonly mode: 'LIVE' | 'REPLAY';
  readonly attribution: 'HEADER' | 'OPERATION_ID' | 'INFLIGHT' | 'UNATTRIBUTED';
  readonly effectiveRequest?: unknown;
  readonly actualRequest?: unknown;
  readonly actualResponse?: unknown;
  readonly differences: readonly DifferenceEntry[];
  readonly rulesApplied: readonly RuleApplied[];
  readonly variablesUsed: readonly { readonly name: string; readonly value: string }[];
  readonly variablesProduced: readonly { readonly name: string; readonly value: string }[];
  readonly assertions?: unknown;
  readonly startedAt?: string | null;
  readonly finishedAt?: string | null;
  readonly durationMs?: number | null;
  readonly error?: string | null;
  readonly unexpectedCalls: readonly UnexpectedCallEntry[];
  readonly requestChanged?: RequestChangedEntry | null;
  readonly pauses: readonly PauseEntry[];
  readonly editsApplied?: unknown;
  /** Whether the call really reached the real host; a mocked LIVE child did not. Null when unknown. */
  readonly reachedUpstream?: boolean | null;
}

export type LogEntryKind =
  | 'SENT'
  | 'MATCHED'
  | 'REPLAYED'
  | 'FORWARDED_LIVE'
  | 'BLOCKED'
  | 'RULE_APPLIED'
  | 'VARIABLE_SET'
  | 'UNEXPECTED_CALL'
  | 'AMBIGUOUS_BLOCKED'
  | 'REQUEST_CHANGED'
  | 'HELD'
  | 'CONTINUED'
  | 'RESUMED'
  | 'DEFINITION_UPDATED'
  | 'ERROR';

export interface LogEntry {
  readonly at: string;
  readonly stepKey?: string | null;
  readonly kind: LogEntryKind;
  readonly message: string;
}

export type RunStatus = 'RUNNING' | 'COMPLETED' | 'COMPLETED_WITH_DIFFERENCES' | 'FAILED' | 'STOPPED' | 'INTERRUPTED';

export interface Run {
  readonly id: string;
  readonly cycleId: string;
  readonly driver: ReliveDriver;
  readonly status: RunStatus;
  readonly startedAt: string;
  readonly finishedAt?: string | null;
  readonly definition: ReliveCycle;
  readonly fromStepKey?: string | null;
  readonly seedVariables: readonly { readonly name: string; readonly value: string }[];
  readonly variableTimeline: readonly { readonly name: string; readonly value: string; readonly stepKey: string | null; readonly at: string }[];
  readonly summary: RunSummary;
  readonly hold?: { readonly stepKey: string; readonly reason: 'FAILED' | 'DIFFERENCES'; readonly since: string } | null;
  readonly resumed: readonly { readonly at: string; readonly afterStepKey: string | null }[];
  readonly log: readonly LogEntry[];
}

export type ValidationFindingCode =
  | 'UNRESOLVED_VARIABLE'
  | 'MISSING_RECORDING'
  | 'DUPLICATE_STEP'
  | 'GLOBAL_RULE_GONE'
  | 'RULE_OVERLAP'
  | 'NOTHING_TO_RUN'
  | 'MAY_BE_UNATTRIBUTED'
  | 'GUIDED_PROJECT_BUSY'
  | 'LIVE_EXTERNAL'
  | 'UNUSED_VARIABLE'
  | 'ORDER_DEPENDENCY';

export interface ValidationFinding {
  readonly severity: 'BLOCK' | 'WARN';
  readonly code: ValidationFindingCode;
  readonly stepKey?: string | null;
  readonly message: string;
}

export type LiveCallReason = 'LIVE' | 'LIVE_MOCKED' | 'CALL_LIVE' | 'ASK_SENT' | 'UNEXPECTED' | 'UNATTRIBUTED';

export interface LiveCall {
  readonly id: string;
  readonly cycleId: string;
  readonly runId: string;
  readonly stepKey?: string | null;
  readonly reason: LiveCallReason;
  readonly loggedCallId?: string | null;
  readonly request: unknown;
  readonly response: unknown;
  readonly status: number;
  readonly durationMs: number;
  readonly at: string;
}
