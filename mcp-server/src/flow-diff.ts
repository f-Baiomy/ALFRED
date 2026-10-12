/**
 * Flows and hop diffs (check_calls): which calls of a cycle carry the same thing, and where a value of that thing
 * changed, went missing or changed count between them - worked out in code, so Claude reads a short list of
 * candidates instead of every body. Pure: no I/O, no masking (the caller masks what it shows).
 *
 * A thing is followed by its ANCHOR - an id-like value (offerId OF-1, a PNR, an order id) that appears in more than
 * one call. Every object holding an anchor is a snapshot of that thing at one point of the flow: a request, a response,
 * or a row a call wrote. Snapshots are compared by normalised key (`fare.total`, `fareTotal` and the column `FARE_TOTAL`
 * are one key), each against the latest earlier snapshot that has the key. Different names on two sides (our
 * `departure`, the supplier's `dep.at`) are not matched - the diff is a list of candidates for Claude, who reads the
 * code, not a verdict.
 */

export type Prim = string | number | boolean | null;

export type SideKind = 'req' | 'db' | 'res';

/** One body (or one written row) of one call, placed on the flow's timeline. */
export interface Side {
  readonly callId: string;
  readonly kind: SideKind;
  /** Epoch ms - a request at the call's start, a write at its statement's offset, a response at its end. */
  readonly at: number;
  readonly root: unknown;
  /** For a written row: the table. */
  readonly table?: string;
}

export interface Snapshot {
  readonly side: Side;
  /** Path of the object holding the anchor, e.g. `offers[0]`, or the table for a row. */
  readonly path: string;
  readonly anchorKey: string;
  readonly leaves: ReadonlyMap<string, { readonly path: string; readonly value: Prim }>;
  readonly counts: ReadonlyMap<string, { readonly path: string; readonly count: number }>;
}

export type DiffKind = 'changed' | 'count' | 'missing';

export interface HopDiff {
  readonly kind: DiffKind;
  readonly anchor: string;
  readonly key: string;
  readonly from: { readonly callId: string; readonly side: SideKind; readonly path: string; readonly value: string };
  readonly to: { readonly callId: string; readonly side: SideKind; readonly path: string; readonly value: string };
}

export interface Flow {
  readonly callIds: readonly string[];
  readonly anchors: readonly string[];
}

const MAX_DEPTH = 12;
/** How deep inside a snapshot object a leaf still belongs to it (`fare.total` yes, `segments[0].legs[1].x` no). */
const LEAF_DEPTH = 3;
const MAX_VALUE = 200;

/** Keys that change on every request or say nothing about the thing itself. */
const NOISE = new Set([
  'requestid', 'xrequestid', 'traceid', 'spanid', 'correlationid', 'transactionid', 'messageid', 'nonce', 'token', 'accesstoken',
  'refreshtoken', 'sessionid', 'etag', 'signature', 'timestamp', 'createdat', 'updatedat', 'created', 'updated', 'modified',
  'lastmodified', 'servertime', 'responsetime', 'processingtime', 'elapsed', 'durationms', 'version', 'echotoken',
]);

const ID_KEYS = new Set(['ref', 'reference', 'pnr', 'locator', 'recordlocator', 'confirmation', 'confirmationnumber', 'bookingref', 'ordernumber']);

export function normKey(path: string): string {
  return path.toLowerCase().replace(/\[\d+\]/g, '').replace(/[^a-z0-9]/g, '');
}

const DATE_TIME = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})(?::(\d{2})(?:\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$/;

/** The value as compared: numbers by value ("412.00" = 412), date-times to one shape, text case-blind. */
export function normValue(value: Prim): string {
  if (value === null) return 'null';
  if (typeof value === 'boolean') return String(value);
  if (typeof value === 'number') return String(value);
  const s = value.trim();
  if (/^-?\d+(\.\d+)?$/.test(s) && !/^0\d/.test(s)) return String(Number(s));
  const dt = DATE_TIME.exec(s);
  if (dt) {
    const tz = !dt[4] || dt[4] === 'Z' || /^[+-]00:?00$/.test(dt[4]) ? '' : dt[4].replace(':', '');
    return `${dt[1]}T${dt[2]}${dt[3] && dt[3] !== '00' ? `:${dt[3]}` : ''}${tz}`;
  }
  return s.toLowerCase();
}

function isAnchor(key: string, value: Prim): value is string | number {
  const k = normKey(key);
  if (typeof value === 'number') return Number.isInteger(value) && value >= 1000 && (k.endsWith('id') || ID_KEYS.has(k));
  if (typeof value !== 'string') return false;
  const v = value.trim();
  if (v.length < 3 || v.length > 64 || /\s/.test(v) || DATE_TIME.test(v) || /^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  if (k.endsWith('id') || ID_KEYS.has(k)) return v.length >= 3 && !/^(true|false|null)$/i.test(v);
  // An id by its look: letters and digits mixed, 5+ characters (OF-1 is too short to be one by look alone).
  return /^(?=.*\d)(?=.*[A-Za-z])[A-Za-z0-9_-]{5,}$/.test(v);
}

function shown(value: Prim): string {
  const s = value === null ? 'null' : typeof value === 'string' ? JSON.stringify(value) : String(value);
  return s.length > MAX_VALUE ? `${s.slice(0, MAX_VALUE)}…` : s;
}

function join(path: string, key: string | number): string {
  return typeof key === 'number' ? `${path}[${key}]` : path ? `${path}.${key}` : key;
}

/** Leaves and counts of one object, up to LEAF_DEPTH levels into its sub-objects (not into lists of objects). */
function collect(node: Record<string, unknown>, path: string, prefix: string, depth: number,
                 leaves: Map<string, { path: string; value: Prim }>, counts: Map<string, { path: string; count: number }>): void {
  for (const [key, value] of Object.entries(node)) {
    const rel = prefix ? `${prefix}.${key}` : key;
    const k = normKey(rel);
    if (!k || NOISE.has(normKey(key))) continue;
    if (Array.isArray(value)) {
      counts.set(k, { path: join(path, key), count: value.length });
    } else if (value !== null && typeof value === 'object') {
      if (depth < LEAF_DEPTH) collect(value as Record<string, unknown>, join(path, key), rel, depth + 1, leaves, counts);
    } else if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) {
      if (typeof value === 'string' && value.length > 2_000) continue;
      leaves.set(k, { path: join(path, key), value: value as Prim });
    }
  }
}

/** Every snapshot in one side: each object (at any depth) that holds an anchor value directly. */
export function snapshotsOf(side: Side): { anchor: string; snapshot: Snapshot }[] {
  const out: { anchor: string; snapshot: Snapshot }[] = [];
  const walk = (node: unknown, path: string, depth: number) => {
    if (depth > MAX_DEPTH || node === null || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      node.forEach((item, i) => walk(item, join(path, i), depth + 1));
      return;
    }
    const obj = node as Record<string, unknown>;
    let leaves: Map<string, { path: string; value: Prim }> | null = null;
    let counts: Map<string, { path: string; count: number }> | null = null;
    for (const [key, value] of Object.entries(obj)) {
      if (Array.isArray(value) || (value !== null && typeof value === 'object')) continue;
      if (!isAnchor(key, value as Prim)) continue;
      if (!leaves) {
        leaves = new Map();
        counts = new Map();
        collect(obj, path, '', 1, leaves, counts);
      }
      out.push({ anchor: normValue(value as Prim), snapshot: { side, path: path || '(root)', anchorKey: normKey(key), leaves, counts: counts! } });
    }
    for (const [key, value] of Object.entries(obj)) {
      if (value !== null && typeof value === 'object') walk(value, join(path, key), depth + 1);
    }
  };
  walk(side.root, '', 0);
  return out;
}

const KIND_ORDER: Record<SideKind, number> = { req: 0, db: 1, res: 2 };

function before(a: Side, b: Side): boolean {
  return a.at !== b.at ? a.at < b.at : KIND_ORDER[a.kind] < KIND_ORDER[b.kind];
}

/** The same side of the same call - comparing a snapshot with itself (or its own list items) says nothing. */
function sameSide(a: Side, b: Side): boolean {
  return a.callId === b.callId && a.kind === b.kind && a.table === b.table;
}

export interface FlowAnalysis {
  readonly flows: readonly Flow[];
  readonly diffs: readonly HopDiff[];
  /** Anchors left out because they are in most calls (an agency or user id): they link everything and so nothing. */
  readonly contextAnchors: readonly string[];
}

/**
 * Flows and diffs over the given sides. `report(callId)` says which calls' diffs to return (the window being
 * checked) - earlier calls still serve as the "from" side.
 */
export function analyseFlows(sides: readonly Side[], report: (callId: string) => boolean = () => true): FlowAnalysis {
  const byAnchor = new Map<string, Snapshot[]>();
  for (const side of sides) {
    for (const { anchor, snapshot } of snapshotsOf(side)) {
      byAnchor.set(anchor, [...(byAnchor.get(anchor) ?? []), snapshot]);
    }
  }
  const callCount = new Set(sides.map((s) => s.callId)).size;
  const contextAnchors: string[] = [];
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    while (parent.get(x) !== x) {
      parent.set(x, parent.get(parent.get(x)!)!);
      x = parent.get(x)!;
    }
    return x;
  };
  for (const side of sides) parent.set(side.callId, side.callId);
  const flowAnchors = new Map<string, Set<string>>();
  const diffs: HopDiff[] = [];
  const seen = new Set<string>();
  const push = (d: HopDiff) => {
    const key = `${d.kind}|${d.key}|${d.from.callId}|${d.from.side}|${d.to.callId}|${d.to.side}`;
    if (seen.has(key)) return;
    seen.add(key);
    diffs.push(d);
  };

  for (const [anchor, all] of byAnchor) {
    const calls = new Set(all.map((s) => s.side.callId));
    if (calls.size < 2) continue;
    if (calls.size >= 6 && calls.size > callCount / 2) {
      contextAnchors.push(anchor);
      continue;
    }
    const ids = [...calls];
    for (const id of ids.slice(1)) parent.set(find(id), find(ids[0]));
    const snaps = [...all].sort((a, b) => (before(a.side, b.side) ? -1 : before(b.side, a.side) ? 1 : 0));
    for (let i = 1; i < snaps.length; i++) {
      const y = snaps[i];
      if (!report(y.side.callId)) continue;
      const earlier = snaps.slice(0, i).filter((x) => !sameSide(x.side, y.side));
      if (!earlier.length) continue;
      const latestWith = (key: string, inCounts: boolean) => {
        for (let j = earlier.length - 1; j >= 0; j--) {
          const x = earlier[j];
          if (inCounts ? x.counts.has(key) : x.leaves.has(key)) return x;
        }
        return null;
      };
      // changed values
      for (const [key, leaf] of y.leaves) {
        if (key === y.anchorKey) continue;
        const x = latestWith(key, false);
        if (!x) continue;
        const from = x.leaves.get(key)!;
        if (normValue(from.value) === normValue(leaf.value)) continue;
        push({ kind: 'changed', anchor, key, from: { callId: x.side.callId, side: x.side.kind, path: from.path, value: shown(from.value) },
          to: { callId: y.side.callId, side: y.side.kind, path: leaf.path, value: shown(leaf.value) } });
      }
      // counts: a list against a list, or a list against a number of the same name (passengers: [2] → passengers: 1)
      const countKeys = new Set([...y.counts.keys(), ...[...y.leaves].filter(([, l]) => typeof l.value === 'number').map(([k]) => k)]);
      for (const key of countKeys) {
        const yCount = y.counts.get(key)?.count ?? (y.leaves.get(key)?.value as number);
        const yPath = y.counts.get(key)?.path ?? y.leaves.get(key)!.path;
        const x = latestWith(key, true);
        if (!x) continue;
        const from = x.counts.get(key)!;
        if (from.count === yCount) continue;
        push({ kind: 'count', anchor, key, from: { callId: x.side.callId, side: x.side.kind, path: from.path, value: `${from.count} items` },
          to: { callId: y.side.callId, side: y.side.kind, path: yPath, value: y.counts.has(key) ? `${yCount} items` : String(yCount) } });
      }
      // missing: only against an earlier snapshot this one mirrors (most of its keys come back), so a short request
      // that names the thing by its id is not read as "everything went missing".
      const x = earlier[earlier.length - 1];
      const xKeys = [...x.leaves.keys()].filter((k) => k !== x.anchorKey);
      if (xKeys.length >= 4) {
        const back = xKeys.filter((k) => y.leaves.has(k) || y.counts.has(k));
        if (back.length / xKeys.length >= 0.6) {
          for (const k of xKeys) {
            if (y.leaves.has(k) || y.counts.has(k)) continue;
            const from = x.leaves.get(k)!;
            push({ kind: 'missing', anchor, key: k, from: { callId: x.side.callId, side: x.side.kind, path: from.path, value: shown(from.value) },
              to: { callId: y.side.callId, side: y.side.kind, path: y.path, value: '(absent)' } });
          }
        }
      }
    }
  }
  for (const [anchor, all] of byAnchor) {
    if (contextAnchors.includes(anchor)) continue;
    const calls = new Set(all.map((s) => s.side.callId));
    if (calls.size < 2) continue;
    const root = find(all[0].side.callId);
    flowAnchors.set(root, (flowAnchors.get(root) ?? new Set()).add(anchor));
  }
  const members = new Map<string, string[]>();
  for (const side of sides) {
    const root = find(side.callId);
    if (!flowAnchors.has(root)) continue;
    const list = members.get(root) ?? [];
    if (!list.includes(side.callId)) list.push(side.callId);
    members.set(root, list);
  }
  const flows = [...members].map(([root, callIds]) => ({ callIds, anchors: [...flowAnchors.get(root)!] }));
  return { flows, diffs, contextAnchors };
}

// ------------------------------------------------------------------------------------------------ parsing sides

/** A body as a tree: JSON as is, XML as elements with their attributes and text; anything else is not compared. */
export function parseBody(body: string | null | undefined): unknown | undefined {
  if (!body) return undefined;
  const text = body.trim();
  if (!text || text.length > 5_000_000) return undefined;
  if (text.startsWith('{') || text.startsWith('[')) {
    try { return JSON.parse(text); } catch { return undefined; }
  }
  if (text.startsWith('<')) return parseXml(text);
  return undefined;
}

function parseXml(text: string): unknown | undefined {
  const Parser = (globalThis as { DOMParser?: new () => { parseFromString(s: string, t: string): Document } }).DOMParser;
  if (!Parser) return undefined;
  const doc = new Parser().parseFromString(text, 'application/xml');
  if (doc.getElementsByTagName('parsererror').length) return undefined;
  const toObject = (el: Element): unknown => {
    const out: Record<string, unknown> = {};
    for (const attr of Array.from(el.attributes)) out[attr.localName] = attr.value;
    const children = Array.from(el.children);
    if (!children.length) {
      const t = el.textContent?.trim() ?? '';
      if (!Object.keys(out).length) return t;
      if (t) out['text'] = t;
      return out;
    }
    for (const child of children) {
      const name = child.localName;
      const value = toObject(child);
      if (name in out) out[name] = Array.isArray(out[name]) ? [...(out[name] as unknown[]), value] : [out[name], value];
      else out[name] = value;
    }
    return out;
  };
  return { [doc.documentElement.localName]: toObject(doc.documentElement) };
}

/** The columns a write sets, in parameter order: INSERT INTO t (a, b) VALUES (?, ?) / UPDATE t SET a = ?, b = ? WHERE c = ?. */
export function writtenColumns(sql: string): { table: string; columns: string[] } | null {
  const s = sql.replace(/\s+/g, ' ').trim();
  const insert = /^(?:insert|merge) into ([\w."$]+)\s*\(([^)]*)\)\s*values\s*\(([^)]*)\)/i.exec(s);
  if (insert) {
    const cols = insert[2].split(',').map((c) => c.trim().replace(/"/g, ''));
    const vals = insert[3].split(',').map((v) => v.trim());
    return { table: insert[1].replace(/"/g, ''), columns: cols.filter((_, i) => vals[i] === '?') };
  }
  const update = /^update ([\w."$]+) set (.+?)(?: where (.+))?$/i.exec(s);
  if (update) {
    const set = update[2].split(',').map((a) => /^\s*([\w."$]+)\s*=\s*\?\s*$/.exec(a)?.[1]?.replace(/"/g, '') ?? null);
    const where = [...(update[3] ?? '').matchAll(/([\w."$]+)\s*=\s*\?/g)].map((m) => m[1].replace(/"/g, ''));
    return { table: update[1].replace(/"/g, ''), columns: [...set.filter((c): c is string => !!c), ...where] };
  }
  return null;
}
