import { Pill } from '../../core/models/logs.model';

/**
 * The filter form (Include / Exclude, Field, Condition, Value) and the pills the query sends, both ways;
 * and the whole search as one line of text, both ways. Pure, so it is tested without a component.
 */
export type FilterCondition = 'is' | 'contains' | 'exists' | 'gt' | 'lt';

export interface FilterForm {
  readonly include: boolean;
  /** A field label; empty for "contains" means any Text field (free-text search). */
  readonly field: string;
  readonly condition: FilterCondition;
  /** "is": one or more values (several = any of them). */
  readonly values: readonly string[];
  /** contains / gt / lt */
  readonly value: string;
}

/** Whether a pill filters lines out (NEQ, NOT_EXISTS or any filter with `not`). */
export function excludes(p: Pill): boolean {
  return p.op === 'NEQ' || p.op === 'NOT_EXISTS' || !!p.not;
}

export function pillToForm(p: Pill): FilterForm {
  const include = !excludes(p);
  const values = p.values?.length ? [...p.values] : p.value != null && p.value !== '' ? [p.value] : [];
  switch (p.op) {
    case 'EQ':
    case 'NEQ':
      return { include, field: p.field ?? '', condition: 'is', values, value: '' };
    case 'EXISTS':
    case 'NOT_EXISTS':
      return { include, field: p.field ?? '', condition: 'exists', values: [], value: '' };
    case 'GT':
      return { include, field: p.field ?? '', condition: 'gt', values: [], value: p.value ?? '' };
    case 'LT':
      return { include, field: p.field ?? '', condition: 'lt', values: [], value: p.value ?? '' };
    case 'TEXT':
      return { include, field: '', condition: 'contains', values: [], value: p.value ?? '' };
    default:
      return { include, field: p.field ?? '', condition: 'contains', values: [], value: p.value ?? '' };
  }
}

/**
 * The pill a form means, keeping the previous pill's AND/OR join and on/off state. null when the form is
 * not complete yet (no field, or no value for a condition that needs one).
 */
export function formToPill(f: FilterForm, prev?: Pill | null): Pill | null {
  const keep = { or: prev?.or ?? null, off: prev?.off ?? null };
  const field = f.field.trim();
  const value = f.value.trim();
  if (f.condition === 'contains' && !field) {
    return value ? { op: 'TEXT', value, not: f.include ? null : true, ...keep } : null;
  }
  if (!field) return null;
  switch (f.condition) {
    case 'is': {
      const vs = f.values.map((v) => v.trim()).filter((v) => v !== '');
      if (!vs.length) return null;
      const op = f.include ? 'EQ' : 'NEQ';
      return vs.length === 1 ? { op, field, value: vs[0], ...keep } : { op, field, values: vs, ...keep };
    }
    case 'exists':
      return { op: f.include ? 'EXISTS' : 'NOT_EXISTS', field, ...keep };
    case 'contains':
      return value ? { op: 'CONTAINS', field, value, not: f.include ? null : true, ...keep } : null;
    case 'gt':
    case 'lt':
      return value ? { op: f.condition === 'gt' ? 'GT' : 'LT', field, value, not: f.include ? null : true, ...keep } : null;
  }
}

/** One pill split for display: "NOT" (red), the field, the condition word, the value. */
export interface PillWords {
  readonly not: boolean;
  readonly field: string;
  readonly word: string;
  readonly value: string;
}

export function pillWords(p: Pill): PillWords | null {
  const not = excludes(p);
  const field = p.field ?? '';
  switch (p.op) {
    case 'EQ':
    case 'NEQ':
      return p.values?.length ? { not, field, word: 'is any of', value: p.values.join(', ') } : { not, field, word: 'is', value: p.value ?? '' };
    case 'EXISTS':
    case 'NOT_EXISTS':
      return { not, field, word: 'exists', value: '' };
    case 'CONTAINS':
      return { not, field, word: 'contains', value: p.value ?? '' };
    case 'GT':
      return { not, field, word: '>', value: p.value ?? '' };
    case 'LT':
      return { not, field, word: '<', value: p.value ?? '' };
    case 'TEXT':
      return { not, field: '', word: 'text', value: `"${p.value ?? ''}"` };
    default:
      return null; // selection, pattern, recorded window: shown by pillText
  }
}

// ---------------------------------------------------------------- the search as one line of text

/** The time part of a search: a preset ("1h", "today", ...) or a span; `to` null = up to now, still moving. */
export interface TextRange {
  readonly preset?: string | null;
  readonly from?: number | null;
  readonly to?: number | null;
}

const PRESET_WORDS = ['15m', '1h', '6h', '24h', '7d'];

function quote(v: string): string {
  return /^[^\s"|()]+$/.test(v) && v.toUpperCase() !== 'OR' && v.toUpperCase() !== 'AND' ? v : `"${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/**
 * `message:"API request" OR level:ERROR|WARN AND -timeTaken>6000 message~timeout field:* "free text" @last:24h`
 * - `-` filters out, `|` = any of, `~` = contains, `:*` = exists, AND is implied; the time goes last as
 * `@last:1h`, `@2026-10-04T09:00:00.000Z..2026-10-04T12:00:00.000Z` or `@…..now`. Turned-off pills are left out.
 */
export function toQueryText(pills: readonly Pill[], range: TextRange | null): string {
  const parts: string[] = [];
  let first = true;
  for (const p of pills) {
    if (p.off) continue;
    const neg = excludes(p) ? '-' : '';
    // A field name with spaces or symbols is quoted, so it reads back as one name.
    const f = /^[\w.@$-]+$/.test(p.field ?? '') ? (p.field ?? '') : `"${(p.field ?? '').replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
    let t: string;
    switch (p.op) {
      case 'EQ':
      case 'NEQ':
        t = `${neg}${f}:${(p.values?.length ? p.values : [p.value ?? '']).map(quote).join('|')}`;
        break;
      case 'EXISTS':
      case 'NOT_EXISTS':
        t = `${neg}${f}:*`;
        break;
      case 'CONTAINS':
        t = `${neg}${f}~${quote(p.value ?? '')}`;
        break;
      case 'GT':
      case 'LT':
        t = `${neg}${f}${p.op === 'GT' ? '>' : '<'}${quote(p.value ?? '')}`;
        break;
      case 'TEXT':
        t = `${neg}"${(p.value ?? '').replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
        break;
      default:
        continue; // selection / pattern / recorded window have no text form
    }
    parts.push(first ? t : p.or ? `OR ${t}` : t);
    first = false;
  }
  if (range) {
    if (range.preset && PRESET_WORDS.includes(range.preset)) parts.push(`@last:${range.preset}`);
    else if (range.from != null || range.to != null) {
      const a = range.from != null ? new Date(range.from).toISOString() : '';
      const b = range.to != null ? new Date(range.to).toISOString() : 'now';
      parts.push(`@${a}..${b}`);
    }
  }
  return parts.join(' ');
}

export interface ParsedText {
  readonly pills: Pill[];
  readonly range: TextRange | null;
}

/** Splits on spaces outside quotes, keeping quotes (and \" escapes) inside tokens. */
function tokens(text: string): string[] {
  const out: string[] = [];
  let cur = '';
  let q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q && c === '\\' && i + 1 < text.length) {
      cur += c + text[++i];
      continue;
    }
    if (c === '"') q = !q;
    if (!q && /\s/.test(c)) {
      if (cur) out.push(cur);
      cur = '';
      continue;
    }
    cur += c;
  }
  if (q) throw new Error('A quote is not closed');
  if (cur) out.push(cur);
  return out;
}

function unquote(v: string): string {
  const m = v.match(/^"((?:[^"\\]|\\.)*)"$/);
  return m ? m[1].replace(/\\(.)/g, '$1') : v;
}

/** Splits "a"|b|"c d" on bars outside quotes. */
function alternatives(v: string): string[] {
  const out: string[] = [];
  let cur = '';
  let q = false;
  for (let i = 0; i < v.length; i++) {
    const c = v[i];
    if (q && c === '\\') {
      cur += c + (v[++i] ?? '');
      continue;
    }
    if (c === '"') q = !q;
    if (!q && c === '|') {
      out.push(unquote(cur));
      cur = '';
      continue;
    }
    cur += c;
  }
  out.push(unquote(cur));
  return out.filter((x) => x !== '');
}

/** The inverse of toQueryText. Throws an Error with a reason the user can act on. */
export function parseQueryText(text: string, knownFields: ReadonlySet<string>): ParsedText {
  const pills: Pill[] = [];
  let range: TextRange | null = null;
  let nextOr = false;
  const fields = [...knownFields].sort((a, b) => b.length - a.length);
  for (const tok of tokens(text.trim())) {
    if (tok === 'OR' || tok === 'or') {
      if (!pills.length) throw new Error('OR needs a filter before it');
      nextOr = true;
      continue;
    }
    if (tok === 'AND' || tok === 'and') continue;
    if (tok.startsWith('@')) {
      const t = tok.slice(1);
      const last = t.match(/^last:(\w+)$/);
      if (last) {
        if (!PRESET_WORDS.includes(last[1])) throw new Error(`Unknown range ${tok} - use ${PRESET_WORDS.map((w) => '@last:' + w).join(', ')}`);
        range = { preset: last[1] };
        continue;
      }
      const span = t.match(/^(.*)\.\.(.*)$/);
      const from = span && span[1] ? Date.parse(span[1]) : null;
      const to = span && span[2] && span[2] !== 'now' ? Date.parse(span[2]) : null;
      if (!span || (from !== null && Number.isNaN(from)) || (to !== null && Number.isNaN(to))) throw new Error(`Not a time range: ${tok}`);
      range = { from, to };
      continue;
    }
    const neg = tok.startsWith('-') && tok.length > 1;
    const body = neg ? tok.slice(1) : tok;
    let pill: Pill;
    const quotedField = body.match(/^"((?:[^"\\]|\\.)*)"([:~<>])(.*)$/);
    if (body.startsWith('"') && !quotedField) {
      pill = { op: 'TEXT', value: unquote(body), not: neg || null };
    } else {
      const field = quotedField ? quotedField[1].replace(/\\(.)/g, '$1') : fields.find((f) => body.startsWith(f) && /^[:~<>]/.test(body.slice(f.length)));
      if (!field || !knownFields.has(field)) throw new Error(`Unknown field in "${tok}"`);
      const sign = quotedField ? quotedField[2] : body[field.length];
      const rest = quotedField ? quotedField[3] : body.slice(field.length + 1);
      if (!rest) throw new Error(`No value in "${tok}"`);
      if (sign === ':' && rest === '*') pill = { op: neg ? 'NOT_EXISTS' : 'EXISTS', field };
      else if (sign === ':') {
        const vs = alternatives(rest);
        const op = neg ? 'NEQ' : 'EQ';
        pill = vs.length > 1 ? { op, field, values: vs } : { op, field, value: vs[0] ?? '' };
      } else if (sign === '~') pill = { op: 'CONTAINS', field, value: unquote(rest), not: neg || null };
      else pill = { op: sign === '>' ? 'GT' : 'LT', field, value: unquote(rest), not: neg || null };
    }
    pills.push(nextOr ? { ...pill, or: true } : pill);
    nextOr = false;
  }
  if (nextOr) throw new Error('OR needs a filter after it');
  return { pills, range };
}
