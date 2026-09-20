import { OriginalHttp } from '../../core/models/interception.model';
import { BodyKind, detectBodyKind, formatBody } from './body-format';
import { HighlightToken, JsonToken, tokenizeJsonText } from './json-tokenizer';
import { splitTokensIntoLines } from './line-tokenizer';
import { tokenizeXmlText } from './xml-tokenizer';

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
  /**
   * The line's syntax tokens, or null when this body is not being coloured - it is plain text,
   * or it is past {@link MAX_COLOURED_LINES}. Null rather than a single plain token so the
   * template can fall back to interpolating `text`, which is one DOM node instead of one per
   * token: the whole reason the limit exists.
   */
  readonly tokens: readonly JsonToken[] | null;
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
  /** What both sides were formatted and coloured as - shown as a badge, so it is never a guess. */
  readonly kind: BodyKind;
  readonly bodyChanged: boolean;
  readonly headersChanged: boolean;
  /** "200 OK → 500 Internal Server Error", or null when the status did not change. */
  readonly statusChange: string | null;
  /** Set when a query rewrite changed the url and nothing else would show it. */
  readonly urlChange: { readonly from: string; readonly to: string } | null;
}

/**
 * Above this many lines a diff is rendered as plain text rather than coloured.
 *
 * Colour costs one DOM node per TOKEN instead of one per line. The call view measured 186,734
 * nodes and a 4,098ms main-thread freeze on a 28,937-line SOAP body, which is why that view
 * windows; this panel does not window, so it takes the honest trade instead - still
 * pretty-printed, still searchable, still copyable, just monochrome.
 */
export const MAX_COLOURED_LINES = 4000;

/**
 * One side of the diff, formatted once and tokenized once.
 *
 * Both halves come out of the same string, which is what keeps `lines[i]` and `tokenLines[i]`
 * describing the same line. If they ever disagree the tokens are dropped entirely rather than
 * used - colours one line out of step with the text they are colouring is worse on a diff than
 * no colours at all, and silently so.
 */
interface DiffSide {
  readonly lines: readonly string[];
  readonly tokenLines: readonly (readonly JsonToken[])[] | null;
}

/**
 * Pretty-prints before diffing so a one-field change shows as one changed line rather than one
 * enormous one - the whole point, and until now it happened for JSON only. An XML body was
 * diffed exactly as it arrived, so a single changed value inside a SOAP envelope was two vast,
 * visually identical lines.
 *
 * The KIND is decided once for both sides by the caller, so the two halves can never be
 * formatted by different rules and manufacture a difference that is not there.
 */
function prepareSide(body: string | null | undefined, kind: BodyKind, colour: boolean): DiffSide {
  const raw = body ?? '';
  if (!raw) return { lines: [], tokenLines: null };

  const text = formatBody(raw, kind) ?? raw;
  const lines = text.split('\n');

  if (!colour || kind === 'text' || lines.length > MAX_COLOURED_LINES) {
    return { lines, tokenLines: null };
  }

  const tokenLines = splitTokensIntoLines(
    (kind === 'xml' ? tokenizeXmlText(text) : tokenizeJsonText(text)).map((t) => ({ ...t, highlighted: false }))
  );
  // The guard described above. Equal lengths is the contract between the two splits, not an
  // assumption worth making silently.
  return { lines, tokenLines: tokenLines.length === lines.length ? tokenLines : null };
}

/** The one kind both sides are formatted as: whichever side is structured, preferring the newer. */
export function sharedBodyKind(before: string | null | undefined, after: string | null | undefined): BodyKind {
  const afterKind = detectBodyKind(after);
  if (afterKind !== 'text') return afterKind;
  return detectBodyKind(before);
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

export function diffLines(
  before: string | null | undefined,
  after: string | null | undefined,
  kind: BodyKind = sharedBodyKind(before, after),
  colour = true
): DiffLine[] {
  const sideA = prepareSide(before, kind, colour);
  const sideB = prepareSide(after, kind, colour);
  const a = sideA.lines;
  const b = sideB.lines;

  const lineA = (i: number): DiffLine => ({ kind: 'removed', text: a[i], tokens: sideA.tokenLines?.[i] ?? null });
  const lineB = (j: number): DiffLine => ({ kind: 'added', text: b[j], tokens: sideB.tokenLines?.[j] ?? null });

  if (a.length === 0 && b.length === 0) return [];
  if (a.length > MAX_DIFF_LINES || b.length > MAX_DIFF_LINES) {
    return [...a.map((_, i) => lineA(i)), ...b.map((_, j) => lineB(j))];
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
      // An unchanged line is the same text on both sides, so either side's tokens will do -
      // the "before" side is used consistently rather than arbitrarily.
      out.push({ kind: 'same', text: a[i], tokens: sideA.tokenLines?.[i] ?? null });
      i++;
      j++;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      out.push(lineA(i++));
    } else {
      out.push(lineB(j++));
    }
  }
  while (i < a.length) out.push(lineA(i++));
  while (j < b.length) out.push(lineB(j++));
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
  const kind = sharedBodyKind(original.body, current?.body);
  const body = diffLines(original.body, current?.body, kind);

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
    kind,
    bodyChanged: body.some((line) => line.kind !== 'same'),
    headersChanged: headers.some((row) => row.kind !== 'same'),
    statusChange,
    urlChange,
  };
}

/* --------------------------------------------------------------------------------------------
 * Searching and copying what is on screen.
 *
 * Both work on the SHOWN view rather than on the underlying call, because that is what the
 * reader is looking at: searching a side that is not displayed would report matches nobody can
 * see, and copying one would put something other than what is on screen on the clipboard.
 * ------------------------------------------------------------------------------------------ */

/** A header row with its matched substrings marked, for the same treatment the body gets. */
export interface HeaderDiffRowTokens extends HeaderDiffRow {
  readonly nameTokens: readonly HighlightToken[];
  readonly valueTokens: readonly HighlightToken[];
}

export interface DiffLineTokens extends DiffLine {
  /** Always present: the plain text becomes a single unclassified token when there is nothing to colour. */
  readonly highlighted: readonly HighlightToken[];
}

export interface SearchedView {
  readonly headers: readonly HeaderDiffRowTokens[];
  readonly body: readonly DiffLineTokens[];
  readonly matchCount: number;
}

/**
 * Marks every occurrence of `query` across the headers and then the body, numbering matches in
 * READING ORDER down the panel.
 *
 * The numbering is the fiddly part and it is worth being explicit about why it is done here
 * rather than by highlightTokens alone. A diff interleaves lines from two separately-tokenized
 * sides, and each side would start its own count at zero - so "3 of 7" would point at two
 * different places. Everything is renumbered once, after interleaving, against the order it is
 * actually drawn in.
 */
export function searchView(
  headers: readonly HeaderDiffRow[],
  body: readonly DiffLine[],
  query: string
): SearchedView {
  let next = 0;
  const mark = (text: string): HighlightToken[] => {
    const parts = splitOnQuery(text, query);
    return parts.map((part) =>
      part.match
        ? { text: part.text, cls: '' as const, highlighted: true, matchIndex: next++ }
        : { text: part.text, cls: '' as const, highlighted: false }
    );
  };

  const markTokens = (tokens: readonly JsonToken[] | null, text: string): HighlightToken[] => {
    if (!tokens) return mark(text);
    const out: HighlightToken[] = [];
    for (const token of tokens) {
      for (const part of splitOnQuery(token.text, query)) {
        out.push(
          part.match
            ? { ...token, text: part.text, highlighted: true, matchIndex: next++ }
            : { ...token, text: part.text, highlighted: false }
        );
      }
    }
    return out;
  };

  const searchedHeaders = headers.map((row) => ({
    ...row,
    nameTokens: mark(row.name),
    valueTokens: mark(row.value),
  }));
  const searchedBody = body.map((line) => ({ ...line, highlighted: markTokens(line.tokens, line.text) }));

  return { headers: searchedHeaders, body: searchedBody, matchCount: next };
}

/** Case-insensitive split keeping the original casing of each piece. */
function splitOnQuery(text: string, query: string): { text: string; match: boolean }[] {
  if (!query || !text) return text ? [{ text, match: false }] : [];
  const haystack = text.toLowerCase();
  const needle = query.toLowerCase();
  const out: { text: string; match: boolean }[] = [];
  let from = 0;
  for (;;) {
    const at = haystack.indexOf(needle, from);
    if (at === -1) break;
    if (at > from) out.push({ text: text.slice(from, at), match: false });
    out.push({ text: text.slice(at, at + needle.length), match: true });
    from = at + needle.length;
  }
  if (from < text.length) out.push({ text: text.slice(from), match: false });
  return out;
}

/**
 * Everything currently on screen, as text for the clipboard.
 *
 * Status and headers as well as the body, because a copy that dropped the status change would
 * drop the very thing that is usually the point - "200 → 500" is the headline of most of these
 * panels. In a single-side view the markers are absent, so what lands is that side clean and
 * ready to replay.
 */
export function copyableView(options: {
  readonly statusChange?: string | null;
  readonly urlChange?: { from: string; to: string } | null;
  readonly headers: readonly HeaderDiffRow[];
  readonly body: readonly DiffLine[];
  readonly showMarkers: boolean;
}): string {
  const mark = (kind: DiffKind) => {
    if (!options.showMarkers) return '';
    return kind === 'removed' ? '- ' : kind === 'added' ? '+ ' : '  ';
  };

  const parts: string[] = [];
  if (options.statusChange) parts.push(`Status  ${options.statusChange}`);
  if (options.urlChange) parts.push(`URL     ${options.urlChange.from} → ${options.urlChange.to}`);
  if (parts.length > 0) parts.push('');

  if (options.headers.length > 0) {
    parts.push('Headers');
    for (const row of options.headers) {
      parts.push(`${mark(row.kind)}${row.name}: ${row.value}`);
    }
    parts.push('');
  }

  if (options.body.length > 0) {
    parts.push('Body');
    for (const line of options.body) {
      parts.push(`${mark(line.kind)}${line.text}`);
    }
  }
  return parts.join('\n');
}
