import { ACTION_LABELS, ActionType, CallInterception, OriginalHttp, actionPhase } from '../../core/models/interception.model';

/**
 * What an interception rule did to one half of a call, shaped for the .md/.html exports.
 *
 * Neither export showed the interception record at all before this - a call a rule rewrote was
 * exported as though the client and the supplier had sent it that way, which is the exact
 * misreading the record exists to prevent. The split by phase, and what counts as "this half",
 * lives here once, so the two renderers only decide how it LOOKS; each keeps its own markup, as
 * everything else in those two builders does.
 *
 * Nothing is summarised or cut short: `before`/`after` carry the full headers and bodies, the same
 * never-truncate rule every other export section follows. Secret header values are already masked
 * by the proxy before the record is written (see proxy/interception.py's Verdict.as_log).
 */
export interface InterceptionExportLine {
  /** The rule's name, or "Manual edit" for a breakpoint decision a human made. */
  readonly rule: string;
  readonly action: string;
  readonly label: string;
  readonly detail: string | null;
}

export interface InterceptionExportPart {
  readonly lines: readonly InterceptionExportLine[];
  /** This half as it was before anything touched it. Absent when it was never modified. */
  readonly before: OriginalHttp | null;
  /** This half as it actually went out. */
  readonly after: OriginalHttp | null;
  /** A response Alfred made up (mocked, answered from a stored answer): there is no upstream "before". */
  readonly synthetic: boolean;
}

/** The part of `interception` that belongs to one half of the call, or null if nothing touched it. */
export function interceptionExportPart(
  interception: CallInterception | null | undefined,
  phase: 'request' | 'response'
): InterceptionExportPart | null {
  if (!interception) return null;
  const lines = (interception.applied ?? [])
    .filter((a) => belongsTo(a.action, phase))
    .map((a) => ({
      rule: a.ruleName || 'Manual edit',
      action: a.action,
      label: ACTION_LABELS[a.action as ActionType] ?? a.action,
      detail: a.detail ?? null,
    }));
  const before = (phase === 'request' ? interception.originalRequest : interception.originalResponse) ?? null;
  const after = (phase === 'request' ? interception.finalRequest : interception.finalResponse) ?? null;
  if (lines.length === 0 && !before && !after) return null;
  return { lines, before, after, synthetic: phase === 'response' && !before && !!after };
}

/**
 * A breakpoint decision belongs to both halves - it is one human act that can edit either - so it
 * is listed under each, as the call card's interception panel does. Everything else goes to the
 * lane the backend says it runs in (MOCK_RESPONSE is a request action despite its name).
 */
function belongsTo(action: string, phase: 'request' | 'response'): boolean {
  if (action.startsWith('BREAKPOINT_')) return true;
  const actionLane = actionPhase(action);
  return phase === 'response' ? actionLane === 'response' : actionLane !== 'response';
}

/** One half as a single readable text block: the start line, the headers, then the full body. */
export function interceptionHttpText(http: OriginalHttp): string {
  const lines: string[] = [];
  if (http.method || http.url) lines.push(`${http.method ?? ''} ${http.url ?? ''}`.trim());
  if (http.status != null) lines.push(`${http.status}${http.reason ? ` ${http.reason}` : ''}`);
  for (const [name, value] of Object.entries(http.headers ?? {})) {
    lines.push(`${name}: ${value}`);
  }
  if (http.body != null && http.body !== '') {
    lines.push('', http.body);
  }
  return lines.join('\n');
}
