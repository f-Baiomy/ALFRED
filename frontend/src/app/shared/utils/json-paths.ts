/**
 * The structure of a sample JSON body as the paths a rule can name - `currency`,
 * `passengers[*].type`, `passengers[0].type` - each with its JSON type, how many values it
 * resolves to and a few of them. What the smart path box suggests from, and what "Browse body…"
 * draws. The path syntax is the one proxy/interception.py's _parse_path reads: dotted names, `[n]`
 * and `[*]`.
 *
 * Pure, and bounded: a supplier response can be megabytes of offers, so the walk stops at
 * MAX_PATHS and a list is walked through its first MAX_ITEMS_WALKED items only.
 */

export type JsonType = 'text' | 'number' | 'boolean' | 'null' | 'object' | 'list';

export interface PathEntry {
  /** `passengers[*].type` */
  readonly path: string;
  readonly type: JsonType;
  /** How many values the path resolves to - 3 for a [*] path over three items. */
  readonly count: number;
  /** Up to five distinct values, as text. */
  readonly samples: readonly string[];
  /** Nesting depth, for the tree and for ranking (shallow first). */
  readonly depth: number;
}

const MAX_PATHS = 600;
const MAX_ITEMS_WALKED = 50;
const MAX_SAMPLES = 5;

export function jsonTypeOf(value: unknown): JsonType {
  if (value === null || value === undefined) return 'null';
  if (Array.isArray(value)) return 'list';
  if (typeof value === 'object') return 'object';
  if (typeof value === 'number') return 'number';
  if (typeof value === 'boolean') return 'boolean';
  return 'text';
}

export function parseJson(text: string | null | undefined): unknown | undefined {
  if (!text || !text.trim()) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** A value as a condition compares it: text as-is, anything else as JSON. */
export function asText(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value);
}

/**
 * Every path in `doc`. A list contributes `list[*].…` (all items together) and `list[0].…` (the
 * first) - the wildcard is almost always what a rule means, the index is there for the rest.
 */
export function jsonPathIndex(doc: unknown): PathEntry[] {
  const found = new Map<string, { type: JsonType; values: unknown[]; depth: number }>();
  const add = (path: string, value: unknown, depth: number) => {
    if (!path || (found.size >= MAX_PATHS && !found.has(path))) return;
    const entry = found.get(path) ?? { type: jsonTypeOf(value), values: [], depth };
    entry.values.push(value);
    found.set(path, entry);
  };
  const walk = (node: unknown, path: string, depth: number) => {
    if (found.size >= MAX_PATHS || depth > 12) return;
    if (Array.isArray(node)) {
      add(path, node, depth);
      const items = node.slice(0, MAX_ITEMS_WALKED);
      items.forEach((item) => walkInto(item, `${path}[*]`, depth + 1));
      if (items.length) walkInto(items[0], `${path}[0]`, depth + 1);
      return;
    }
    if (path) add(path, node, depth);
    if (node && typeof node === 'object') {
      for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
        walk(value, path ? `${path}.${key}` : key, depth + 1);
      }
    }
  };
  // An item of a list: record the item path itself only for scalars (`tags[*]`), then its fields.
  const walkInto = (item: unknown, path: string, depth: number) => {
    if (item && typeof item === 'object' && !Array.isArray(item)) {
      for (const [key, value] of Object.entries(item as Record<string, unknown>)) walk(value, `${path}.${key}`, depth + 1);
    } else {
      walk(item, path, depth);
    }
  };
  walk(doc, '', 0);

  return [...found.entries()].map(([path, e]) => {
    const distinct: string[] = [];
    for (const v of e.values) {
      if (Array.isArray(v) || (v && typeof v === 'object')) continue;
      const text = asText(v);
      if (!distinct.includes(text)) distinct.push(text);
      if (distinct.length >= MAX_SAMPLES) break;
    }
    return { path, type: e.type, count: e.values.length, samples: distinct, depth: e.depth };
  });
}

/**
 * The best matches for what is typed: the path starting with it first, then containing it,
 * then fuzzy (its characters in order) - shallow before deep, `[*]` before `[0]`.
 */
export function suggestPaths(index: readonly PathEntry[], typed: string, limit = 12): PathEntry[] {
  const q = typed.trim().toLowerCase();
  const score = (e: PathEntry): number => {
    const p = e.path.toLowerCase();
    const indexed = /\[\d+\]/.test(e.path) ? 0.5 : 0;
    if (!q) return e.depth + indexed;
    if (p === q) return -100;
    if (p.startsWith(q)) return 0 + e.depth * 0.1 + indexed;
    const last = p.split('.').pop() ?? p;
    if (last.startsWith(q.split('.').pop() ?? q)) return 10 + e.depth * 0.1 + indexed;
    if (p.includes(q)) return 20 + e.depth * 0.1 + indexed;
    let i = 0;
    for (const ch of p) if (ch === q[i]) i++;
    return i === q.length ? 40 + e.depth * 0.1 + indexed : Infinity;
  };
  return index
    .map((e) => ({ e, s: score(e) }))
    .filter((x) => Number.isFinite(x.s))
    .sort((a, b) => a.s - b.s || a.e.path.length - b.e.path.length)
    .slice(0, limit)
    .map((x) => x.e);
}

/** Every value at a path in `doc` - proxy get_json_field, for "was … in the call" and value suggestions. */
export function valuesAt(doc: unknown, path: string): unknown[] {
  const segments: (string | number)[] = [];
  for (const part of path.split('.')) {
    if (!part) continue;
    const bracket = part.indexOf('[');
    const name = bracket < 0 ? part : part.slice(0, bracket);
    if (name) segments.push(name);
    for (const m of (bracket < 0 ? '' : part.slice(bracket)).matchAll(/\[([^\]]*)\]/g)) {
      const index = m[1].trim();
      if (index === '*') segments.push('*');
      else if (/^-?\d+$/.test(index)) segments.push(Number(index));
    }
  }
  const collect = (node: unknown, rest: (string | number)[]): unknown[] => {
    if (!rest.length) return [node];
    const [head, ...tail] = rest;
    if (head === '*') return Array.isArray(node) ? node.flatMap((item) => collect(item, tail)) : [];
    if (typeof head === 'number') {
      if (!Array.isArray(node) || head >= node.length || head < -node.length) return [];
      return collect(node[head < 0 ? node.length + head : head], tail);
    }
    if (!node || typeof node !== 'object' || Array.isArray(node) || !(head in (node as object))) return [];
    return collect((node as Record<string, unknown>)[head], tail);
  };
  return collect(doc, segments);
}

/** "was "EUR"" / "was 12831.8, 13039.8, … (18 items)" - what an edit replaces, in the sample call. */
export function describeCurrent(values: readonly unknown[]): string {
  if (!values.length) return 'not in the call';
  const shown = values.slice(0, 3).map((v) => {
    const text = asText(v);
    return text.length > 40 ? text.slice(0, 37) + '…' : text;
  });
  return `was ${shown.join(', ')}${values.length > 3 ? `, … (${values.length} items)` : ''}`;
}
