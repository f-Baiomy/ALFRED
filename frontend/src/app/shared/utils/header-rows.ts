/**
 * Header rows as the header editor edits them, and the two JSON shapes they travel in.
 *
 * There are deliberately TWO serializations, because they answer different questions:
 *
 *  - `headersToJsonText` / `rowsFromHeadersJson` - what a PERSON edits in the editor's JSON view:
 *    a pretty `{ "name": "value" }` object of the rows that are still being sent. Removed rows are
 *    absent from it, exactly as they will be absent from the wire, so deleting a line removes the
 *    header. Going back to rows needs the rows it was made from, to keep "removed" (struck through,
 *    undoable) and "added" (typed by hand) - an object alone cannot carry either.
 *
 *  - `serializeHeaderRows` / `parseHeaderRows` - what a PROGRAM hands to another tab (the /edit
 *    page, see EditTabService): the full row list, removed rows included, so nothing about the
 *    editing state is lost crossing tabs. Exact shape:
 *
 *        [{ "name": string, "value": string, "removed": boolean, "added": boolean }, ...]
 *
 *    as compact JSON, in row order. `added` is always written (false when absent); a reader
 *    accepts it missing.
 */
export interface HeaderRow {
  readonly name: string;
  readonly value: string;
  /** Kept on screen, struck through, rather than vanishing - see the header editor. */
  readonly removed: boolean;
  /** Typed in by hand rather than present in what the editor was given. */
  readonly added?: boolean;
}

/** The rows as a tab-to-tab payload - the full list, removed rows included. See the file header. */
export function serializeHeaderRows(rows: readonly HeaderRow[]): string {
  return JSON.stringify(
    rows.map((r) => ({ name: r.name, value: r.value, removed: r.removed, added: !!r.added }))
  );
}

/** Inverse of `serializeHeaderRows`. Null for anything that is not that exact shape. */
export function parseHeaderRows(text: string | null | undefined): HeaderRow[] | null {
  if (!text) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  const rows: HeaderRow[] = [];
  for (const item of parsed) {
    if (typeof item !== 'object' || item === null) return null;
    const { name, value, removed, added } = item as Record<string, unknown>;
    if (typeof name !== 'string' || typeof value !== 'string' || typeof removed !== 'boolean') return null;
    rows.push({ name, value, removed, added: added === true });
  }
  return rows;
}

/**
 * The rows still being sent, as the pretty object a person edits. A row with a blank name is left
 * out - it is a half-typed "+ Add header", and `"": ""` would read as a real header.
 */
export function headersToJsonText(rows: readonly HeaderRow[]): string {
  const object: Record<string, string> = {};
  for (const row of rows) {
    if (!row.removed && row.name.trim()) object[row.name] = row.value;
  }
  return JSON.stringify(object, null, 2);
}

export type HeadersJsonResult = { ok: true; rows: HeaderRow[] } | { ok: false; error: string };

/**
 * Reads an edited `{ name: value }` object back into rows, against the rows it was made from:
 *
 *  - a name still present keeps its place and its `added` flag, takes the new value, and is
 *    un-removed if it had been struck through;
 *  - a name from `previous` that is gone becomes `removed: true` - unless it was added by hand,
 *    in which case it never existed and simply goes;
 *  - a new name is appended, `added: true`, in the order the object lists it.
 *
 * Numbers and booleans are accepted as their text; nested objects, arrays and null are refused,
 * because a header value is one line of text and guessing a flattening would send something
 * nobody typed.
 */
export function rowsFromHeadersJson(text: string, previous: readonly HeaderRow[]): HeadersJsonResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, error: 'Not valid JSON - not applied' };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { ok: false, error: 'Expected an object of header name to value - not applied' };
  }
  const entries = Object.entries(parsed as Record<string, unknown>);
  for (const [name, value] of entries) {
    if (!['string', 'number', 'boolean'].includes(typeof value)) {
      return { ok: false, error: `"${name}" must be text, not ${value === null ? 'null' : typeof value} - not applied` };
    }
  }
  const incoming = new Map(entries.map(([name, value]) => [name, String(value)]));

  const rows: HeaderRow[] = [];
  const placed = new Set<string>();
  for (const row of previous) {
    if (!row.name.trim()) continue;
    if (incoming.has(row.name) && !placed.has(row.name)) {
      rows.push({ name: row.name, value: incoming.get(row.name)!, removed: false, added: !!row.added });
      placed.add(row.name);
    } else if (!row.added && !placed.has(row.name)) {
      rows.push({ name: row.name, value: row.value, removed: true, added: false });
    }
  }
  for (const [name, value] of incoming) {
    if (!placed.has(name)) rows.push({ name, value, removed: false, added: true });
  }
  return { ok: true, rows };
}
