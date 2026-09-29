/**
 * A step's outcome (FR-034a): Failed on a transport error, timeout, no answer, a 5xx response, a
 * change of status class compared with the recording (e.g. 2xx → 4xx), or a failed assertion on a
 * specific field. A JSON check of the whole document (no path, actual value is an object or array)
 * is a difference, not a failure. Otherwise Completed with differences when at least one UNEXPECTED
 * difference remains (expected differences, FR-041, never change the outcome); otherwise Completed.
 */
import { type Assertion, AssertionResult } from './scenario-types';
import { DifferenceEntry, FrozenCall, StepResult, StepState } from './relive-types';

export type StepOutcome = 'COMPLETED' | 'COMPLETED_WITH_DIFFERENCES' | 'FAILED';

/** A reason line. `detail` is the full text, opened from "Click to show" when the line is long. */
export interface StepReason {
  readonly summary: string;
  readonly detail: string | null;
}

const REASON_PREVIEW_LIMIT = 240;

/** What actually happened, as far as the outcome check cares - not the whole logged call. */
export interface ActualCallOutcome {
  readonly transportError: boolean;
  readonly timedOut: boolean;
  /** No response at all was ever received (distinct from a transport error/timeout - e.g. the
   *  call was blocked/aborted and there is genuinely nothing to grade). */
  readonly noAnswer: boolean;
  readonly status: number | null;
}

function statusClass(status: number): number {
  return Math.floor(status / 100);
}

export function outcomeOf(
  actual: ActualCallOutcome,
  recording: Pick<FrozenCall, 'status'>,
  assertionResults: readonly AssertionResult[],
  differences: readonly DifferenceEntry[],
): StepOutcome {
  if (actual.transportError || actual.timedOut || actual.noAnswer || actual.status == null) {
    return 'FAILED';
  }
  if (statusClass(actual.status) === 5) {
    return 'FAILED';
  }
  if (statusClass(actual.status) !== statusClass(recording.status)) {
    return 'FAILED';
  }
  const failed = assertionResults.filter((a) => !a.passed);
  if (failed.some((a) => !wholeDocumentMismatch(a))) {
    return 'FAILED';
  }
  if (failed.length > 0 || differences.some((d) => d.kind === 'UNEXPECTED')) {
    return 'COMPLETED_WITH_DIFFERENCES';
  }
  return 'COMPLETED';
}

/**
 * How a saved step is shown. A failure stored before the whole-document rule, with nothing but that
 * mismatch, a normal status, and no transport error, is shown as differences.
 */
export function displayedState(
  result: Pick<StepResult, 'state' | 'error' | 'assertions' | 'actualResponse'>,
  recordingStatus: number | null,
): StepState {
  if (result.state !== 'FAILED') return result.state;
  if (result.error?.trim()) return 'FAILED';
  const status = responseStatus(result.actualResponse);
  if (status == null || statusClass(status) === 5) return 'FAILED';
  if (recordingStatus != null && statusClass(status) !== statusClass(recordingStatus)) return 'FAILED';
  const failed = failedAssertions(result.assertions);
  if (failed.length > 0 && failed.every(wholeDocumentMismatch)) return 'COMPLETED_WITH_DIFFERENCES';
  return 'FAILED';
}

/** Pretty-print a reason when it is a JSON object or array; otherwise leave the text as stored. */
export function formatReasonDetail(detail: string): string {
  const trimmed = detail.trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return detail;
  try {
    return JSON.stringify(JSON.parse(trimmed), null, 2);
  } catch {
    return detail;
  }
}

const EXPLAINED: ReadonlySet<StepState> = new Set(['FAILED', 'SKIPPED', 'NOT_CALLED', 'CANCELLED']);
const JSON_UNREADABLE = 'Response body is not valid JSON.';

/** Why a settled step failed, was skipped, or was never sent. Empty for every other state. */
export function explainStep(
  result: Pick<StepResult, 'state' | 'error' | 'assertions' | 'actualResponse'>,
  recordingStatus: number | null,
  parentState: StepState | null = null,
): readonly StepReason[] {
  if (!EXPLAINED.has(result.state)) return [];
  if (result.state === 'SKIPPED') return [brief(result.error?.trim() || 'Skipped before it was sent.')];
  if (result.state === 'NOT_CALLED') return [brief(notSentReason(result.error, parentState))];
  if (result.state === 'CANCELLED') return [brief(result.error?.trim() || 'Cancelled before it was sent.')];
  return explainFailure(result, recordingStatus);
}

function notSentReason(error: string | null | undefined, parentState: StepState | null): string {
  const own = error?.trim();
  if (own) return own;
  if (parentState === 'SKIPPED') return 'Not sent. Its parent was skipped.';
  if (parentState === 'FAILED') return 'Not sent. Its parent failed before this call went out.';
  if (parentState === 'CANCELLED') return 'Not sent. Its parent was cancelled.';
  if (parentState === 'COMPLETED' || parentState === 'COMPLETED_WITH_DIFFERENCES') {
    return 'Not sent. The parent finished without this call.';
  }
  return 'This call was not sent.';
}

function explainFailure(
  result: Pick<StepResult, 'error' | 'assertions' | 'actualResponse'>,
  recordingStatus: number | null,
): readonly StepReason[] {
  const lines: StepReason[] = [];
  const raw = result.error?.trim() ?? '';
  const described = raw && raw !== 'no response' ? (raw.startsWith('unresolved {{') ? `Not sent: ${raw}.` : raw) : '';
  if (described) lines.push(brief(described));

  const status = responseStatus(result.actualResponse);
  const statusLine = statusReason(status, recordingStatus);
  if (statusLine) lines.push(brief(statusLine));
  else if (status == null && !described) lines.push(brief('No response came back.'));

  const gzip = isGzip(result.actualResponse);
  for (const failed of failedAssertions(result.assertions)) {
    lines.push(explainAssertion(failed, gzip, status));
  }
  if (!lines.length) lines.push(brief('This step failed.'));
  return lines;
}

function brief(text: string): StepReason {
  if (text.length <= REASON_PREVIEW_LIMIT) return { summary: text, detail: null };
  return { summary: `${text.slice(0, 160).trimEnd()}…`, detail: text };
}

function statusReason(status: number | null, recordingStatus: number | null): string | null {
  if (status == null) return null;
  const actualClass = Math.floor(status / 100);
  const recordedClass = recordingStatus == null ? null : Math.floor(recordingStatus / 100);
  const classChanged = recordedClass != null && actualClass !== recordedClass;
  if (actualClass === 5 || classChanged) {
    return classChanged
      ? `The host answered ${status}; the recording was ${recordingStatus}.`
      : `The host answered ${status}.`;
  }
  return null;
}

function explainAssertion(failed: AssertionResult, gzip: boolean, status: number | null): StepReason {
  const message = failed.message?.trim() ?? '';
  if (message === JSON_UNREADABLE && gzip) {
    const head = status == null
      ? 'The response body is still gzip-compressed, so the JSON check could not read it.'
      : `The host answered ${status}, but the body is still gzip-compressed, so the JSON check could not read it.`;
    return brief(`${head}${expectedClause(failed.assertion)}`);
  }
  const actual = failed.actual ?? '';
  if (actual.length > REASON_PREVIEW_LIMIT || message.length > REASON_PREVIEW_LIMIT) {
    return { summary: shortAssertion(failed), detail: actual.length > REASON_PREVIEW_LIMIT ? actual : message };
  }
  return brief(message || 'An assertion failed.');
}

/** A JSON assertion with no path whose actual value is a whole document, not a field. */
function wholeDocumentMismatch(result: AssertionResult): boolean {
  const assertion = result.assertion;
  if (!assertion || assertion.kind !== 'JSON') return false;
  if ((assertion.path ?? '').trim() !== '') return false;
  const actual = (result.actual ?? '').trim();
  return actual.startsWith('{') || actual.startsWith('[');
}

function shortAssertion(failed: AssertionResult): string {
  const assertion = failed.assertion;
  if (!assertion) return 'An assertion failed.';
  const path = (assertion.path ?? '').trim();
  const where = assertion.kind === 'JSON'
    ? (path ? `JSON path "${path}"` : 'The whole body')
    : assertion.kind === 'HEADER'
      ? `Header "${path}"`
      : assertion.kind === 'STATUS'
        ? 'The status'
        : assertion.kind === 'LATENCY'
          ? 'The duration'
          : 'A check';
  const wanted = assertion.value ?? '';
  const expected = wanted.length > 80 ? `${wanted.slice(0, 80)}…` : wanted;
  const verbs: Partial<Record<Assertion['operator'], string>> = {
    EQUALS: 'equal',
    NOT_EQUALS: 'not equal',
    CONTAINS: 'contain',
    MATCHES: 'match',
    GT: 'be greater than',
    LT: 'be less than',
  };
  const verb = verbs[assertion.operator];
  return verb && expected ? `${where} did not ${verb} "${expected}".` : `${where} failed its check.`;
}

function expectedClause(assertion: Assertion | undefined): string {
  if (!assertion || assertion.kind !== 'JSON') return '';
  const path = (assertion.path ?? '').trim();
  const where = path ? `JSON path "${path}"` : 'the whole body';
  const value = assertion.value ?? '';
  const how: Partial<Record<Assertion['operator'], string>> = {
    EQUALS: `to equal "${value}"`,
    NOT_EQUALS: `to not equal "${value}"`,
    CONTAINS: `to contain "${value}"`,
    MATCHES: `to match "${value}"`,
    GT: `to be greater than "${value}"`,
    LT: `to be less than "${value}"`,
    EXISTS: 'to be present',
    NOT_EXISTS: 'to be absent',
  };
  const wanted = how[assertion.operator];
  return wanted ? ` The check expected ${where} ${wanted}.` : '';
}

function failedAssertions(raw: unknown): AssertionResult[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((item): item is AssertionResult => !!item && typeof item === 'object' && (item as AssertionResult).passed === false);
}

function responseStatus(response: unknown): number | null {
  if (!response || typeof response !== 'object') return null;
  const status = (response as { status?: unknown }).status;
  return typeof status === 'number' ? status : null;
}

function isGzip(response: unknown): boolean {
  if (!response || typeof response !== 'object') return false;
  const headers = (response as { headers?: unknown }).headers;
  if (!headers || typeof headers !== 'object') return false;
  return Object.entries(headers as Record<string, unknown>).some(
    ([name, value]) => name.toLowerCase() === 'content-encoding' && String(value).toLowerCase().includes('gzip'),
  );
}
