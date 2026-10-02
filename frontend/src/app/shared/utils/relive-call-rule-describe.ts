/**
 * Human-readable summaries of a call rule's actions, for the step drawer's "Call rule" preview
 * (mock.html `actLine()`/`hostCard()`). Purely descriptive - never edits anything; the buttons
 * around it (T037) are what call into `relive-call-rule.ts`.
 */
import { ACTION_LABELS, RuleAction } from '../../core/models/interception.model';
import { RecordedCallPreview } from './recorded-call-match';

export interface ActionLine {
  readonly title: string;
  readonly detail: string | null;
  readonly on: boolean;
}

function truncate(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ');
  return flat.length > max ? flat.slice(0, max) + '…' : flat;
}

function isOurCondition(action: RuleAction): boolean {
  if (action.type !== 'IF_REQUEST') return false;
  const branches = action.branches ?? [];
  return branches.length === 1 && branches[0].conditions.length === 1 && branches[0].conditions[0].subject === 'RECORDED_CALL';
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]!));
}

function matchPhrase(preview: RecordedCallPreview | null): string {
  if (!preview) {
    return 'matches the recorded call\'s <b>URL, method, headers</b> (not auto-generated) and <b>body</b> (JSON or SOAP; spacing ignored)';
  }
  const headers = preview.headerNames.length ? preview.headerNames.join(', ') : 'none';
  return `matches <b>${escapeHtml(preview.method)} ${escapeHtml(preview.url)}</b>, headers <b>${escapeHtml(headers)}</b> (not auto-generated), and the body (${escapeHtml(preview.bodyNote)})`;
}

function conditionDetail(action: RuleAction, preview: RecordedCallPreview | null): string {
  const otherwise = action.otherwise ?? [];
  const first = otherwise[0];
  const branchWord = `if the request <b>as it is at this point</b> (after the edits above) ${matchPhrase(preview)} → continue`;
  if (!first) {
    return `${branchWord} → otherwise → <b>replay the recording anyway</b>`;
  }
  if (first.type === 'SEND_TO_HOST') {
    return `${branchWord} → otherwise → <b><span class="rl-warn-text">send to the real host ⚠</span></b>`;
  }
  if (first.type === 'PAUSE_REQUEST') {
    return `${branchWord} → otherwise → <b>pause and ask me (no answer in time = mocked failure)</b>`;
  }
  return `${branchWord} → otherwise → <b>Mock response ${first.status ?? 502} (failure) - host never contacted</b>`;
}

export function describeAction(action: RuleAction, preview: RecordedCallPreview | null = null): ActionLine {
  const on = action.enabled !== false;
  const title = ACTION_LABELS[action.type] ?? action.type;

  if (action.type === 'MOCK_RESPONSE' || action.type === 'REPLACE_RESPONSE') {
    const headers = Object.entries(action.headers ?? {}).map(([k, v]) => `${k}: ${v}`).join(', ');
    const detail = `${action.status ?? ''} · ${headers} · ${truncate(action.body ?? '', 46)}`;
    return { title, detail, on };
  }
  if (isOurCondition(action)) {
    return { title, detail: conditionDetail(action, preview), on };
  }
  if (action.type === 'PAUSE_REQUEST' || action.type === 'PAUSE_RESPONSE') {
    return { title, detail: `hold up to ${action.timeoutSeconds ?? 30} s`, on };
  }
  if (action.type === 'SET_REQUEST_BODY') {
    return { title, detail: truncate(action.body ?? '', 50), on };
  }
  return { title, detail: null, on };
}

export interface HostCardInfo {
  readonly icon: string;
  readonly title: string;
  readonly detail: string;
  readonly tone: 'off' | 'warn' | 'ask' | 'reaches';
}

/** mock.html `hostCard()` - a small status card between the request and response action lists. */
export function hostCard(actions: readonly RuleAction[], who: string): HostCardInfo {
  const mockOn = actions.some((a) => a.type === 'MOCK_RESPONSE' && a.enabled !== false);
  const condOn = actions.some((a) => isOurCondition(a) && a.enabled !== false && (a.otherwise ?? [])[0]?.type === 'SEND_TO_HOST');

  if (condOn && mockOn) {
    return { icon: '⚠', title: 'The host', tone: 'warn', detail: `${who} IS contacted when the request differs from the recording (Call live).` };
  }
  if (mockOn) {
    return { icon: '✕', title: 'The host', tone: 'off', detail: `${who} is not contacted; Mock response answers.` };
  }
  if (condOn) {
    return { icon: '?', title: 'The host', tone: 'ask', detail: `${who} is contacted only when the request differs from the recording.` };
  }
  return { icon: '→', title: 'The host', tone: 'reaches', detail: `the real request goes to ${who} and the real answer comes back.` };
}
