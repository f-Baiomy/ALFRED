import { Pill } from '../../core/models/logs.model';
import { excludes, pillWords } from './logs-filter';

/**
 * The explorer's query-bar grammar (contracts/log-query.md), identical to mock.html's parseQ():
 * `field:value` = equals, `-field:value` = not equals, `field:*` / `-field:*` = present / missing,
 * `field>v` / `field<v` = greater / less, `"text"` or anything else = free text.
 */
export function parseQuery(input: string, knownFields: ReadonlySet<string>): Pill | null {
  const s = input.trim();
  if (!s) return null;
  const m = s.match(/^"(.+)"$/);
  if (m) return { op: 'TEXT', value: m[1] };
  const neg = s.startsWith('-');
  const body = neg ? s.slice(1) : s;
  // The field is the longest known label the text starts with, followed by its operator - so a label
  // with spaces, slashes or colons of its own (any JSON key) can be typed as well.
  let best: { field: string; op: ':' | '>' | '<'; rest: string } | null = null;
  for (const f of knownFields) {
    if (!body.startsWith(f) || (best && best.field.length >= f.length)) continue;
    const after = body.slice(f.length).trimStart();
    const op = after.charAt(0);
    if (op === ':' || ((op === '>' || op === '<') && !neg)) best = { field: f, op, rest: after.slice(1).trim() };
  }
  if (!best) return { op: 'TEXT', value: s };
  const { field, op, rest } = best;
  // A known field with nothing after its operator is an unfinished filter, not text to search for.
  if (!rest) return null;
  if (op === '>' || op === '<') return { op: op === '>' ? 'GT' : 'LT', field, value: unquote(rest) };
  if (rest === '*') return { op: neg ? 'NOT_EXISTS' : 'EXISTS', field };
  return { op: neg ? 'NEQ' : 'EQ', field, value: unquote(rest) };
}

/** `"API request"` -> `API request`: quotes group a value, they are not part of it. */
function unquote(v: string): string {
  const m = v.match(/^"(.*)"$/);
  return m ? m[1] : v;
}

/**
 * Whether Enter takes the highlighted suggestion instead of the typed text. It does when the user picked
 * it with the arrow keys, when the text is only part of a filter (`level`, `level:`), and when the
 * highlighted value completes the value typed so far (`level:E` -> `level:ERROR`). Otherwise the typed
 * text is the filter (`message:timeout` with no such value listed stays `message = timeout`).
 */
export function enterTakesSuggestion(text: string, insert: string, picked: boolean): boolean {
  if (picked) return true;
  const t = text.trim();
  if (!t) return false;
  if (!t.includes(':') && !/[<>"]/.test(t)) return true;
  const m = t.match(/^(-?[\w.@$-]+):(.*)$/);
  if (!m) return false;
  if (m[2] === '') return true;
  if (insert.endsWith(':*')) return false;
  return insert.toLowerCase().startsWith(t.toLowerCase());
}

const OP_SIGN: Partial<Record<Pill['op'], string>> = { EQ: '=', NEQ: '≠', GT: '>', LT: '<' };

/** What a pill reads as (mock `pillText()`). */
export function pillText(p: Pill, formatTime: (ms: number) => string = (ms) => new Date(ms).toISOString()): string {
  const w = pillWords(p);
  if (w && p.op !== 'TEXT') return `${w.not ? 'NOT ' : ''}${w.field} ${w.word}${w.value ? ' ' + w.value : ''}`;
  if (p.op === 'TEXT' && p.not) return `NOT "${p.value ?? ''}"`;
  switch (p.op) {
    case 'TEXT':
      return `"${p.value ?? ''}"`;
    case 'EXISTS':
      return `${p.field} exists`;
    case 'NOT_EXISTS':
      return `${p.field} missing`;
    case 'BETWEEN':
      return `${p.field} ${formatTime(Number(p.from))} – ${formatTime(Number(p.to))}`;
    case 'SELECTION':
      return `selection only (${p.lineIds?.length ?? 0})`;
    case 'PATTERN':
      return `pattern #${p.value}`;
    case 'INGESTED':
      return `recorded ${formatTime(Number(p.from))} – ${p.to ? formatTime(Number(p.to)) : 'now'}`;
    default:
      return `${p.field} ${OP_SIGN[p.op]} ${p.value ?? ''}`;
  }
}

/** Colour class per operator: = blue, ≠ red, exists green, text amber, ranges cyan (mock `.qp.*`). */
export function pillClass(p: Pill): string {
  if (excludes(p) && p.op !== 'NOT_EXISTS') return 'lg-qp-neq';
  switch (p.op) {
    case 'CONTAINS':
      return 'lg-qp-eq';
    case 'EQ':
      return 'lg-qp-eq';
    case 'NEQ':
      return 'lg-qp-neq';
    case 'EXISTS':
    case 'NOT_EXISTS':
      return 'lg-qp-ex';
    case 'TEXT':
      return 'lg-qp-text';
    default:
      return 'lg-qp-range';
  }
}

export function samePill(a: Pill, b: Pill): boolean {
  return a.op === b.op && (a.field ?? null) === (b.field ?? null) && (a.value ?? null) === (b.value ?? null)
    && (a.from ?? null) === (b.from ?? null) && (a.to ?? null) === (b.to ?? null)
    && (a.values ?? []).join('\u0000') === (b.values ?? []).join('\u0000') && !!a.not === !!b.not;
}

/** Splits text into plain and matched segments for every TEXT pill term - rendered with bindings, never innerHTML. */
export function highlightSegments(text: string, terms: readonly string[]): { text: string; hit: boolean }[] {
  const active = terms.map((t) => t.toLowerCase()).filter((t) => t.length > 0);
  if (!active.length || !text) return [{ text, hit: false }];
  const lower = text.toLowerCase();
  const out: { text: string; hit: boolean }[] = [];
  let i = 0;
  while (i < text.length) {
    let best = -1;
    let len = 0;
    for (const t of active) {
      const at = lower.indexOf(t, i);
      if (at >= 0 && (best < 0 || at < best || (at === best && t.length > len))) {
        best = at;
        len = t.length;
      }
    }
    if (best < 0) {
      out.push({ text: text.slice(i), hit: false });
      break;
    }
    if (best > i) out.push({ text: text.slice(i, best), hit: false });
    out.push({ text: text.slice(best, best + len), hit: true });
    i = best + len;
  }
  return out;
}
