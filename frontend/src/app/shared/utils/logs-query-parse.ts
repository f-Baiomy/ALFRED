import { Pill } from '../../core/models/logs.model';

/**
 * The explorer's query-bar grammar (contracts/log-query.md), identical to mock.html's parseQ():
 * `field:value` = equals, `-field:value` = not equals, `field:*` / `-field:*` = present / missing,
 * `field>v` / `field<v` = greater / less, `"text"` or anything else = free text.
 */
export function parseQuery(input: string, knownFields: ReadonlySet<string>): Pill | null {
  const s = input.trim();
  if (!s) return null;
  let m: RegExpMatchArray | null;
  if ((m = s.match(/^"(.+)"$/))) return { op: 'TEXT', value: m[1] };
  if ((m = s.match(/^-([\w.@$-]+):\*$/)) && knownFields.has(m[1])) return { op: 'NOT_EXISTS', field: m[1] };
  if ((m = s.match(/^([\w.@$-]+):\*$/)) && knownFields.has(m[1])) return { op: 'EXISTS', field: m[1] };
  if ((m = s.match(/^-([\w.@$-]+):(.+)$/)) && knownFields.has(m[1])) return { op: 'NEQ', field: m[1], value: m[2] };
  if ((m = s.match(/^([\w.@$-]+)\s*([<>])\s*(.+)$/)) && knownFields.has(m[1])) {
    return { op: m[2] === '>' ? 'GT' : 'LT', field: m[1], value: m[3].trim() };
  }
  if ((m = s.match(/^([\w.@$-]+):(.+)$/)) && knownFields.has(m[1])) return { op: 'EQ', field: m[1], value: m[2] };
  return { op: 'TEXT', value: s };
}

const OP_SIGN: Partial<Record<Pill['op'], string>> = { EQ: '=', NEQ: '≠', GT: '>', LT: '<' };

/** What a pill reads as (mock `pillText()`). */
export function pillText(p: Pill, formatTime: (ms: number) => string = (ms) => new Date(ms).toISOString()): string {
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
  switch (p.op) {
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
    && (a.from ?? null) === (b.from ?? null) && (a.to ?? null) === (b.to ?? null);
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
