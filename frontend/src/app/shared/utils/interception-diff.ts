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
   * The line's syntax tokens, or null when there is nothing to colour - a body that is neither
   * JSON nor XML. Null rather than one plain token so the template can interpolate `text`
   * instead, which is a single DOM node.
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

/*
 * There used to be a MAX_COLOURED_LINES cap here, dropping colour past 4,000 lines because colour
 * costs one DOM node per TOKEN rather than one per line. The panel windows now, so the number of
 * rows BUILT no longer depends on the size of the body - which was the only thing that cap was
 * protecting. Tokenizing a 28,937-line body costs 45ms, measured, and is paid once on expand.
 * A large body is coloured like any other.
 */

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

  if (!colour || kind === 'text') {
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
 * Longest-common-subsequence line diff, on whatever is left after trimming the common ends off.
 *
 * O(n*m) in memory over whatever it is given, which is why it only ever runs on the part that
 * might actually differ (see `diffLines`) rather than the whole body - a bound sized for the WHOLE
 * body would either be too small to be useful (a real search response is thousands of lines) or
 * too large to be safe (two 5,000-line bodies is 25 million cells on the main thread).
 */
const MAX_DIFF_LINES = 3000;

function lcsDiff(
  a: readonly string[],
  b: readonly string[],
  sideA: DiffSide,
  sideB: DiffSide,
  aStart: number,
  bStart: number,
  aLen: number,
  bLen: number
): DiffLine[] {
  const lineA = (i: number): DiffLine => ({ kind: 'removed', text: a[i], tokens: sideA.tokenLines?.[i] ?? null });
  const lineB = (j: number): DiffLine => ({ kind: 'added', text: b[j], tokens: sideB.tokenLines?.[j] ?? null });

  if (aLen > MAX_DIFF_LINES || bLen > MAX_DIFF_LINES) {
    const out: DiffLine[] = [];
    for (let i = aStart; i < aStart + aLen; i++) out.push(lineA(i));
    for (let j = bStart; j < bStart + bLen; j++) out.push(lineB(j));
    return out;
  }

  // Classic LCS table, sized to this range only, then walk it back into a line list.
  const lcs: number[][] = Array.from({ length: aLen + 1 }, () => new Array<number>(bLen + 1).fill(0));
  for (let i = aLen - 1; i >= 0; i--) {
    for (let j = bLen - 1; j >= 0; j--) {
      lcs[i][j] =
        a[aStart + i] === b[bStart + j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }

  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < aLen && j < bLen) {
    if (a[aStart + i] === b[bStart + j]) {
      // An unchanged line is the same text on both sides, so either side's tokens will do -
      // the "before" side is used consistently rather than arbitrarily.
      out.push({ kind: 'same', text: a[aStart + i], tokens: sideA.tokenLines?.[aStart + i] ?? null });
      i++;
      j++;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      out.push(lineA(aStart + i++));
    } else {
      out.push(lineB(bStart + j++));
    }
  }
  while (i < aLen) out.push(lineA(aStart + i++));
  while (j < bLen) out.push(lineB(bStart + j++));
  return out;
}

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

  if (a.length === 0 && b.length === 0) return [];

  /*
   * Trim the common prefix and suffix before touching the O(n*m) part at all.
   *
   * Found live: editing ONE field in a 7,368-line intercepted response rendered the WHOLE body as
   * removed-then-added, because the untrimmed body was well past MAX_DIFF_LINES and the bound's
   * fallback marks everything changed rather than nothing. But a real edit - one JSON value, one
   * header - changes a handful of lines inside a body that is otherwise byte-identical top and
   * bottom. Stripping the matching ends first turns "diff two 7,368-line arrays" into "diff the
   * three lines around the edit", which is cheap enough to run properly AND produces the real
   * diff instead of the size bound's fallback. The bound above still exists for the genuinely
   * large case - most of a huge body actually rewritten - where showing it all as changed is not
   * a compromise, it is the honest answer.
   */
  const maxCommon = Math.min(a.length, b.length);
  let prefix = 0;
  while (prefix < maxCommon && a[prefix] === b[prefix]) prefix++;

  let suffix = 0;
  const maxSuffix = maxCommon - prefix;
  while (suffix < maxSuffix && a[a.length - 1 - suffix] === b[b.length - 1 - suffix]) suffix++;

  const sameLine = (i: number): DiffLine => ({ kind: 'same', text: a[i], tokens: sideA.tokenLines?.[i] ?? null });

  const out: DiffLine[] = [];
  for (let i = 0; i < prefix; i++) out.push(sameLine(i));
  out.push(...lcsDiff(a, b, sideA, sideB, prefix, prefix, a.length - suffix - prefix, b.length - suffix - prefix));
  for (let i = a.length - suffix; i < a.length; i++) out.push(sameLine(i));
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
  /** Always present: a line with nothing to colour becomes one unclassified token. */
  readonly highlighted: readonly HighlightToken[];
}

/** Which part of the panel a search applies to. Request versus response is already the panel. */
export type SearchScope = 'all' | 'headers' | 'body';

/**
 * Where every match in the body is, WITHOUT building a single highlight token.
 *
 * This split is what lets the panel window. Counting is one `indexOf` loop per line and is run
 * over the whole body, because the total has to be truthful - "3 of 412" cannot only know about
 * the rows currently on screen. BUILDING the tokens is the expensive half, and that is done for
 * the visible slice only, by {@link highlightLine}.
 *
 * `firstIndex[i]` is the global match number of the first match on line i, so a line highlighted
 * in isolation still numbers its matches the way the whole panel does.
 */
export interface BodySearch {
  readonly perLine: readonly number[];
  readonly firstIndex: readonly number[];
  readonly count: number;
}

export function searchBody(lines: readonly DiffLine[], query: string, offset = 0): BodySearch {
  const perLine = new Array<number>(lines.length).fill(0);
  const firstIndex = new Array<number>(lines.length).fill(offset);
  if (!query) return { perLine, firstIndex, count: 0 };

  const needle = query.toLowerCase();
  let running = offset;
  for (let i = 0; i < lines.length; i++) {
    firstIndex[i] = running;
    perLine[i] = countOccurrences(lines[i].text, needle);
    running += perLine[i];
  }
  return { perLine, firstIndex, count: running - offset };
}

function countOccurrences(text: string, lowerNeedle: string): number {
  if (!lowerNeedle) return 0;
  const haystack = text.toLowerCase();
  let count = 0;
  let from = 0;
  for (;;) {
    const at = haystack.indexOf(lowerNeedle, from);
    if (at === -1) return count;
    count++;
    from = at + lowerNeedle.length;
  }
}

/**
 * Which body line a global match number falls on, so the panel can scroll to it.
 *
 * Needed because a windowed panel cannot find its current match by querying the DOM for a
 * `<mark>` - the row holding it may never have been built. The flat view learned the same thing;
 * see its scrollToRow.
 */
export function lineOfMatch(search: BodySearch, matchIndex: number): number {
  const { firstIndex, perLine } = search;
  let lo = 0;
  let hi = firstIndex.length - 1;
  if (hi < 0) return -1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (firstIndex[mid] <= matchIndex) lo = mid;
    else hi = mid - 1;
  }
  // Both bounds. Without the lower one, a match number belonging to the HEADERS - which are
  // numbered before the body - fell through to line 0 and scrolled the body for a match that was
  // never in it.
  const withinLine = matchIndex >= firstIndex[lo] && matchIndex < firstIndex[lo] + perLine[lo];
  return perLine[lo] > 0 && withinLine ? lo : -1;
}

/** Builds one line's highlight tokens. Called for the rows on screen and no others. */
export function highlightLine(line: DiffLine, query: string, firstIndex: number): DiffLineTokens {
  let next = firstIndex;
  const out: HighlightToken[] = [];
  const source: readonly JsonToken[] = line.tokens ?? [{ text: line.text, cls: '' }];
  for (const token of source) {
    for (const part of splitOnQuery(token.text, query)) {
      out.push(
        part.match
          ? { ...token, text: part.text, highlighted: true, matchIndex: next++ }
          : { ...token, text: part.text, highlighted: false }
      );
    }
  }
  return { ...line, highlighted: out };
}

/**
 * Headers are highlighted eagerly: there are tens of them, not tens of thousands, and they are
 * all on screen at once.
 */
export function searchHeaders(
  rows: readonly HeaderDiffRow[],
  query: string,
  offset = 0
): { rows: readonly HeaderDiffRowTokens[]; count: number } {
  let next = offset;
  const mark = (text: string): HighlightToken[] =>
    splitOnQuery(text, query).map((part) =>
      part.match
        ? { text: part.text, cls: '' as const, highlighted: true, matchIndex: next++ }
        : { text: part.text, cls: '' as const, highlighted: false }
    );

  const marked = rows.map((row) => ({ ...row, nameTokens: mark(row.name), valueTokens: mark(row.value) }));
  return { rows: marked, count: next - offset };
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
/** Which part of the panel a copy takes. */
export type CopySection = 'all' | 'headers' | 'body';

export function copyableView(options: {
  readonly statusChange?: string | null;
  readonly urlChange?: { from: string; to: string } | null;
  readonly headers: readonly HeaderDiffRow[];
  readonly body: readonly DiffLine[];
  readonly showMarkers: boolean;
  /**
   * Defaults to everything. A section on its own is copied WITHOUT the surrounding labels -
   * "Body" then a JSON document is not something you can paste into a request, and copying just
   * the body is almost always in order to replay or re-post it.
   */
  readonly section?: CopySection;
}): string {
  const section = options.section ?? 'all';
  const mark = (kind: DiffKind) => {
    if (!options.showMarkers) return '';
    return kind === 'removed' ? '- ' : kind === 'added' ? '+ ' : '  ';
  };
  const headerLines = () => options.headers.map((row) => `${mark(row.kind)}${row.name}: ${row.value}`);
  const bodyLines = () => options.body.map((line) => `${mark(line.kind)}${line.text}`);

  if (section === 'headers') return headerLines().join('\n');
  if (section === 'body') return bodyLines().join('\n');

  const parts: string[] = [];
  if (options.statusChange) parts.push(`Status  ${options.statusChange}`);
  if (options.urlChange) parts.push(`URL     ${options.urlChange.from} → ${options.urlChange.to}`);
  if (parts.length > 0) parts.push('');

  if (options.headers.length > 0) {
    parts.push('Headers');
    parts.push(...headerLines());
    parts.push('');
  }

  if (options.body.length > 0) {
    parts.push('Body');
    parts.push(...bodyLines());
  }
  return parts.join('\n');
}
