import { OriginalHttp } from '../../core/models/interception.model';

/**
 * Before/after for a call an interception rule changed.
 *
 * Exists as its own module, rather than inside the component, for the usual reason in this
 * codebase: it is the part with actual logic, and it is worth testing without a fixture. The
 * component only decides when to run it.
 *
 * It runs on EXPAND, never for a list. A line diff of two large bodies is real work, and the call
 * list has already fought this battle once - see the windowed rendering notes in
 * docs/frontend-architecture.md.
 */

export type DiffKind = 'same' | 'removed' | 'added';

export interface DiffLine {
  readonly kind: DiffKind;
  readonly text: string;
}

export interface HeaderDiffRow {
  readonly kind: DiffKind;
  readonly name: string;
  /** For a 'removed' row the old value, for 'added' the new, for 'same' the unchanged one. */
  readonly value: string;
}

export interface HttpDiff {
  readonly headers: readonly HeaderDiffRow[];
  readonly body: readonly DiffLine[];
  readonly bodyChanged: boolean;
  readonly headersChanged: boolean;
  /** "200 OK → 500 Internal Server Error", or null when the status did not change. */
  readonly statusChange: string | null;
  /** Set when a query rewrite changed the url and nothing else would show it. */
  readonly urlChange: { readonly from: string; readonly to: string } | null;
}

/**
 * Pretty-prints JSON before diffing so a one-field change shows as one changed line rather than
 * one enormous one. Anything that is not JSON is diffed as it stands.
 */
function toLines(body: string | null | undefined): string[] {
  const text = body ?? '';
  if (!text) return [];
  const trimmed = text.trimStart();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      return JSON.stringify(JSON.parse(text), null, 2).split('\n');
    } catch {
      // Not valid JSON despite the leading brace - diff the raw text.
    }
  }
  return text.split('\n');
}

/**
 * Longest-common-subsequence line diff.
 *
 * O(n*m) in memory, which is why it is bounded: two 5,000-line bodies would be 25 million cells,
 * and this runs in the browser on the main thread. Past the bound the caller still gets a correct
 * answer - every line marked changed - just not a minimal one, which is the right trade when the
 * alternative is locking the tab.
 */
const MAX_DIFF_LINES = 3000;

export function diffLines(before: string | null | undefined, after: string | null | undefined): DiffLine[] {
  const a = toLines(before);
  const b = toLines(after);

  if (a.length === 0 && b.length === 0) return [];
  if (a.length > MAX_DIFF_LINES || b.length > MAX_DIFF_LINES) {
    return [
      ...a.map((text) => ({ kind: 'removed' as const, text })),
      ...b.map((text) => ({ kind: 'added' as const, text })),
    ];
  }

  // Classic LCS table, then walk it back into a line list.
  const lcs: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }

  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.push({ kind: 'same', text: a[i] });
      i++;
      j++;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      out.push({ kind: 'removed', text: a[i++] });
    } else {
      out.push({ kind: 'added', text: b[j++] });
    }
  }
  while (i < a.length) out.push({ kind: 'removed', text: a[i++] });
  while (j < b.length) out.push({ kind: 'added', text: b[j++] });
  return out;
}

/**
 * Header names are compared case-insensitively, because HTTP header names are - a rule that sets
 * `X-Alfred` over an existing `x-alfred` replaced it, and showing that as one removed plus one
 * added row would be a lie about what happened.
 */
export function diffHeaders(
  before: Readonly<Record<string, string>> | null | undefined,
  after: Readonly<Record<string, string>> | null | undefined
): HeaderDiffRow[] {
  const lower = (h: Readonly<Record<string, string>> | null | undefined) =>
    new Map(Object.entries(h ?? {}).map(([k, v]) => [k.toLowerCase(), { name: k, value: v }]));

  const a = lower(before);
  const b = lower(after);
  const rows: HeaderDiffRow[] = [];

  for (const [key, entry] of a) {
    const other = b.get(key);
    if (other === undefined) {
      rows.push({ kind: 'removed', name: entry.name, value: entry.value });
    } else if (other.value !== entry.value) {
      rows.push({ kind: 'removed', name: entry.name, value: entry.value });
      rows.push({ kind: 'added', name: other.name, value: other.value });
    } else {
      rows.push({ kind: 'same', name: entry.name, value: entry.value });
    }
  }
  for (const [key, entry] of b) {
    if (!a.has(key)) rows.push({ kind: 'added', name: entry.name, value: entry.value });
  }

  // Changed rows first: on a call with forty headers and one rewritten, the one that matters must
  // not be somewhere in the middle of the list.
  return [...rows.filter((r) => r.kind !== 'same'), ...rows.filter((r) => r.kind === 'same')];
}

function statusLabel(http: { status?: number | null; reason?: string | null } | null | undefined): string | null {
  if (!http?.status) return null;
  return http.reason ? `${http.status} ${http.reason}` : String(http.status);
}

export function buildHttpDiff(
  original: OriginalHttp | null | undefined,
  current: { status?: number | null; reason?: string | null; url?: string | null; headers?: Readonly<Record<string, string>> | null; body?: string | null } | null | undefined
): HttpDiff | null {
  if (!original) return null;

  const headers = diffHeaders(original.headers, current?.headers);
  const body = diffLines(original.body, current?.body);

  const beforeStatus = statusLabel(original);
  const afterStatus = statusLabel(current);
  const statusChange =
    beforeStatus && afterStatus && beforeStatus !== afterStatus ? `${beforeStatus} → ${afterStatus}` : null;

  const urlChange =
    original.url && current?.url && original.url !== current.url
      ? { from: original.url, to: current.url }
      : null;

  return {
    headers,
    body,
    bodyChanged: body.some((line) => line.kind !== 'same'),
    headersChanged: headers.some((row) => row.kind !== 'same'),
    statusChange,
    urlChange,
  };
}
