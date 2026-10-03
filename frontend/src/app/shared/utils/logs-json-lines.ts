import { JsonToken } from './json-tokenizer';

/**
 * One rendered line of a log line's JSON view (FR-020, FR-042). Each value line carries the
 * flattened field path it belongs to - the same path rules as the backend's Flattener (dots between
 * keys, a one-element array shares its parent's path) - so a comment is anchored to the field, not
 * to a display line number, and shows on the same field in the Table view and across folding.
 */
export interface JsonLine {
  readonly depth: number;
  readonly tokens: readonly JsonToken[];
  /** Field path for value/opening lines; null for closing brackets. */
  readonly path: string | null;
  /** Set on lines that open an object/array below the root: the fold toggle's key. */
  readonly foldKey: string | null;
  readonly folded: boolean;
}

function scalarTokens(v: unknown): JsonToken[] {
  if (v === null) return [{ text: 'null', cls: 'z' }];
  if (typeof v === 'string') return [{ text: JSON.stringify(v), cls: 's' }];
  if (typeof v === 'number') return [{ text: String(v), cls: 'n' }];
  if (typeof v === 'boolean') return [{ text: String(v), cls: 'b' }];
  return [{ text: String(v), cls: '' }];
}

/** @param folded fold keys (`<path>`) the user has collapsed */
export function jsonLines(value: unknown, folded: ReadonlySet<string>): JsonLine[] {
  const out: JsonLine[] = [];
  walk(value, '', 0, null, '', folded, out, true);
  return out;
}

function walk(v: unknown, path: string, depth: number, key: string | null, comma: string, folded: ReadonlySet<string>,
              out: JsonLine[], root: boolean): void {
  const keyTokens: JsonToken[] = key === null ? [] : [{ text: JSON.stringify(key), cls: 'k' }, { text: ': ', cls: '' }];
  if (v === null || typeof v !== 'object') {
    out.push({ depth, tokens: [...keyTokens, ...scalarTokens(v), { text: comma, cls: '' }], path, foldKey: null, folded: false });
    return;
  }
  const isArray = Array.isArray(v);
  const entries: [string, unknown][] = isArray ? (v as unknown[]).map((x, i) => [String(i), x]) : Object.entries(v as object);
  const open = isArray ? '[' : '{';
  const close = isArray ? ']' : '}';
  const foldKey = root ? null : `${path}#${depth}`;
  if (foldKey && folded.has(foldKey)) {
    out.push({
      depth,
      tokens: [...keyTokens, { text: `${open} … ${entries.length} ${isArray ? 'items' : 'fields'} ${close}`, cls: '' }, { text: comma, cls: '' }],
      path,
      foldKey,
      folded: true,
    });
    return;
  }
  out.push({ depth, tokens: [...keyTokens, { text: open, cls: '' }], path, foldKey, folded: false });
  entries.forEach(([k, child], i) => {
    const childPath = isArray && entries.length === 1 ? path : path ? `${path}.${k}` : k;
    walk(child, childPath, depth + 1, isArray ? null : k, i < entries.length - 1 ? ',' : '', folded, out, false);
  });
  out.push({ depth, tokens: [{ text: close + comma, cls: '' }], path: null, foldKey: null, folded: false });
}

/** Comments hidden inside a folded block, so the folded line can say "💬 N inside". */
export function commentsInside(foldPath: string, commentPaths: readonly string[]): number {
  return commentPaths.filter((p) => p.startsWith(`${foldPath}.`)).length;
}
