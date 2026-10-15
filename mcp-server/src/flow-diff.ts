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
 *
 * Small ids (`branchId: 948`, `agencyIds: [949, 10646]`) are anchors too, but WEAK ones: a small number means nothing
 * on its own (status 1, type 2), so it links only under its own name (`branchid=948` - a list `agencyIds` gives
 * `agencyid=949` per item), and only across calls: never a request against its own response (a filter against the rows
 * it returned), never two requests to the same endpoint (two searches with other filters are not a flow) and never
 * a row of a list (a result row and the next request share field names, not meaning) - those still link the flow.
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
  /** The call's endpoint (METHOD /pattern), when known: weak anchors never link two requests of one endpoint. */
  readonly endpoint?: string;
}

/** Where a snapshot sits - a side without its body, so the index never keeps a whole body alive. */
export type SideMeta = Omit<Side, 'root'>;

export interface Snapshot {
  readonly side: SideMeta;
  /** Path of the object holding the anchor, e.g. `offers[0]`, or the table for a row. */
  readonly path: string;
  readonly anchorKey: string;
  readonly leaves: ReadonlyMap<string, { readonly path: string; readonly value: Prim }>;
  readonly counts: ReadonlyMap<string, { readonly path: string; readonly count: number }>;
  /** Anchored by a small id (see the header): compared only across calls, never request→request of one endpoint. */
  readonly weak?: boolean;
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
/** An anchor is "context" (in most calls, so it links nothing) only once at least this many calls are indexed. */
const CONTEXT_MIN_CALLS = 30;

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

/**
 * A small id under its own name (`branchid=948`), or null: an integer 1..999 under a key that ends in "id" and names
 * the thing (not a bare `id`, which is every entity's).
 */
function weakAnchor(key: string, value: Prim): string | null {
  const k = normKey(key);
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value >= 1000) return null;
  return k.length > 2 && k.endsWith('id') ? `${k}=${value}` : null;
}

/** The items of an id list (`agencyIds: [949, 10646]`) as weak anchors (`agencyid=949`); none for another list. */
function listAnchors(key: string, value: unknown[]): string[] {
  const k = normKey(key);
  if (!(k.length > 3 && k.endsWith('ids')) || value.length === 0 || value.length > 50) return [];
  const one = k.slice(0, -1);
  const out: string[] = [];
  for (const v of value) {
    if (typeof v === 'number' && Number.isInteger(v) && v >= 1) out.push(`${one}=${v}`);
    else if (typeof v === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(v.trim()) && v.trim().toLowerCase() !== 'all') out.push(`${one}=${normValue(v)}`);
    else return []; // not a list of ids
  }
  return out;
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
  const meta: SideMeta = { callId: side.callId, kind: side.kind, at: side.at, ...(side.table ? { table: side.table } : {}),
    ...(side.endpoint ? { endpoint: side.endpoint } : {}) };
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
    const snapshot = (anchor: string, key: string, weak: boolean) => {
      if (!leaves) {
        leaves = new Map();
        counts = new Map();
        collect(obj, path, '', 1, leaves, counts);
      }
      out.push({ anchor, snapshot: { side: meta, path: path || '(root)', anchorKey: normKey(key), leaves, counts: counts!, ...(weak ? { weak } : {}) } });
    };
    for (const [key, value] of Object.entries(obj)) {
      if (Array.isArray(value)) {
        for (const a of listAnchors(key, value)) snapshot(a, key, true);
        continue;
      }
      if (value !== null && typeof value === 'object') continue;
      if (isAnchor(key, value as Prim)) {
        snapshot(normValue(value as Prim), key, false);
        continue;
      }
      const weak = weakAnchor(key, value as Prim);
      if (weak) snapshot(weak, key, true);
    }
    for (const [key, value] of Object.entries(obj)) {
      if (value !== null && typeof value === 'object') walk(value, join(path, key), depth + 1);
    }
  };
  walk(side.root, '', 0);
  return out;
}

const KIND_ORDER: Record<SideKind, number> = { req: 0, db: 1, res: 2 };

function before(a: SideMeta, b: SideMeta): boolean {
  return a.at !== b.at ? a.at < b.at : KIND_ORDER[a.kind] < KIND_ORDER[b.kind];
}

/** The same side of the same call - comparing a snapshot with itself (or its own list items) says nothing. */
function sameSide(a: SideMeta, b: SideMeta): boolean {
  return a.callId === b.callId && a.kind === b.kind && a.table === b.table;
}

export interface FlowAnalysis {
  readonly flows: readonly Flow[];
  readonly diffs: readonly HopDiff[];
  /** Anchors left out because they are in most calls (an agency or user id): they link everything and so nothing. */
  readonly contextAnchors: readonly string[];
}

/** Rough bytes a snapshot holds - for the index's memory cap, not exact. */
function sizeOf(s: Snapshot): number {
  let n = 64 + s.path.length;
  for (const [k, l] of s.leaves) n += 48 + k.length + l.path.length + (typeof l.value === 'string' ? l.value.length : 8);
  for (const [k, c] of s.counts) n += 40 + k.length + c.path.length;
  return n;
}

/**
 * The snapshots of a cycle's calls, kept between batches: each call's bodies are parsed once, only the small snapshots
 * are kept (never the bodies), and a batch is compared against what is already indexed - so checking batch 300 of a
 * 9,000-call cycle costs what batch 3 cost.
 */
export class FlowIndex {
  private readonly byAnchor = new Map<string, Snapshot[]>();
  private readonly callsOfAnchor = new Map<string, Set<string>>();
  private readonly anchorsOfCall = new Map<string, Set<string>>();
  private readonly indexed = new Set<string>();
  bytes = 0;

  has(callId: string): boolean {
    return this.indexed.has(callId);
  }

  get calls(): number {
    return this.indexed.size;
  }

  /**
   * Indexes one call's sides (its bodies and written rows) - once; a call indexed again is ignored. Returns the calls
   * indexed earlier whose snapshot now directly follows one of this call's on the timeline: a call that arrives late
   * (its writes were still being captured) slots in before them, so they are compared with it now and their diffs
   * against it are new.
   */
  add(callId: string, sides: readonly Side[]): string[] {
    if (this.indexed.has(callId)) return [];
    this.indexed.add(callId);
    const successors = new Set<string>();
    const anchors = new Set<string>();
    for (const side of sides) {
      for (const { anchor, snapshot } of snapshotsOf(side)) {
        anchors.add(anchor);
        const list = this.byAnchor.get(anchor) ?? [];
        // keep each anchor's snapshots in timeline order (a binary insert: calls mostly arrive in order)
        let lo = 0;
        let hi = list.length;
        while (lo < hi) {
          const mid = (lo + hi) >> 1;
          if (before(snapshot.side, list[mid].side)) hi = mid; else lo = mid + 1;
        }
        list.splice(lo, 0, snapshot);
        const next = list[lo + 1];
        if (next && next.side.callId !== callId) successors.add(next.side.callId);
        this.byAnchor.set(anchor, list);
        this.bytes += sizeOf(snapshot);
        this.callsOfAnchor.set(anchor, (this.callsOfAnchor.get(anchor) ?? new Set()).add(callId));
      }
    }
    this.anchorsOfCall.set(callId, anchors);
    return [...successors];
  }

  /**
   * An id in most calls (an agency, a user): it links everything and so nothing. Not before there are calls enough to
   * tell: in a short cycle the booking that all of its calls carry IS the flow.
   */
  isContext(anchor: string): boolean {
    const n = this.callsOfAnchor.get(anchor)?.size ?? 0;
    return this.indexed.size >= CONTEXT_MIN_CALLS && n >= 6 && n > this.indexed.size / 2;
  }

  private linking(anchor: string): boolean {
    return (this.callsOfAnchor.get(anchor)?.size ?? 0) >= 2 && !this.isContext(anchor);
  }

  contextAnchors(): string[] {
    return [...this.callsOfAnchor.keys()].filter((a) => (this.callsOfAnchor.get(a)?.size ?? 0) >= 2 && this.isContext(a));
  }

  /** The diffs whose later side is one of `callIds` - each against the latest earlier snapshot of the same thing. */
  diffsFor(callIds: ReadonlySet<string>): HopDiff[] {
    const diffs: HopDiff[] = [];
    const seen = new Set<string>();
    const push = (d: HopDiff) => {
      const key = `${d.kind}|${d.key}|${d.from.callId}|${d.from.side}|${d.to.callId}|${d.to.side}`;
      if (seen.has(key)) return;
      seen.add(key);
      diffs.push(d);
    };
    const anchors = new Set<string>();
    for (const id of callIds) for (const a of this.anchorsOfCall.get(id) ?? []) anchors.add(a);
    for (const anchor of anchors) {
      if (!this.linking(anchor)) continue;
      const snaps = this.byAnchor.get(anchor)!;
      for (let i = 1; i < snaps.length; i++) {
        const y = snaps[i];
        if (!callIds.has(y.side.callId)) continue;
        compare(anchor, y, snaps.slice(0, i).filter((x) => !sameSide(x.side, y.side) && (!y.weak || weakPair(x, y))), push);
      }
    }
    return diffs;
  }

  /** The flows (calls linked through ids they share) that hold any of `callIds`. */
  flowsFor(callIds: Iterable<string>): Flow[] {
    const done = new Set<string>();
    const flows: Flow[] = [];
    for (const start of callIds) {
      if (done.has(start) || !this.indexed.has(start)) continue;
      const members: string[] = [];
      const anchors = new Set<string>();
      const queue = [start];
      done.add(start);
      while (queue.length) {
        const id = queue.shift()!;
        members.push(id);
        for (const a of this.anchorsOfCall.get(id) ?? []) {
          if (!this.linking(a)) continue;
          anchors.add(a);
          for (const other of this.callsOfAnchor.get(a)!) {
            if (!done.has(other)) { done.add(other); queue.push(other); }
          }
        }
      }
      if (anchors.size) flows.push({ callIds: members, anchors: [...anchors] });
    }
    return flows;
  }
}

/**
 * A weak anchor compares two snapshots only across calls, never two requests to one endpoint, and never a row of a
 * list (a search result) - those link calls into a flow, but their fields are other things that share a name.
 */
function weakPair(x: Snapshot, y: Snapshot): boolean {
  if (x.side.callId === y.side.callId || x.path.includes('[') || y.path.includes('[')) return false;
  return !(x.side.kind === 'req' && y.side.kind === 'req' && x.side.endpoint !== undefined && x.side.endpoint === y.side.endpoint);
}

/** One later snapshot against the earlier ones of the same thing: values that changed, counts that changed, keys gone. */
function compare(anchor: string, y: Snapshot, earlier: readonly Snapshot[], push: (d: HopDiff) => void): void {
  if (!earlier.length) return;
  const latestWith = (key: string, inCounts: boolean) => {
    for (let j = earlier.length - 1; j >= 0; j--) {
      const x = earlier[j];
      if (inCounts ? x.counts.has(key) : x.leaves.has(key)) return x;
    }
    return null;
  };
  for (const [key, leaf] of y.leaves) {
    if (key === y.anchorKey) continue;
    const x = latestWith(key, false);
    if (!x) continue;
    const from = x.leaves.get(key)!;
    if (normValue(from.value) === normValue(leaf.value)) continue;
    if (y.weak && from.value === null) continue; // an empty filter that was filled in later is a choice, not a drift
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
  if (xKeys.length < 4) return;
  const back = xKeys.filter((k) => y.leaves.has(k) || y.counts.has(k));
  if (back.length / xKeys.length < 0.6) return;
  for (const k of xKeys) {
    if (y.leaves.has(k) || y.counts.has(k)) continue;
    const from = x.leaves.get(k)!;
    push({ kind: 'missing', anchor, key: k, from: { callId: x.side.callId, side: x.side.kind, path: from.path, value: shown(from.value) },
      to: { callId: y.side.callId, side: y.side.kind, path: y.path, value: '(absent)' } });
  }
}

/**
 * Flows and diffs over the given sides, in one go. `report(callId)` says which calls' diffs to return (the window being
 * checked) - earlier calls still serve as the "from" side.
 */
export function analyseFlows(sides: readonly Side[], report: (callId: string) => boolean = () => true): FlowAnalysis {
  const index = new FlowIndex();
  const byCall = new Map<string, Side[]>();
  for (const side of sides) byCall.set(side.callId, [...(byCall.get(side.callId) ?? []), side]);
  for (const [id, list] of byCall) index.add(id, list);
  const ids = [...byCall.keys()];
  return { flows: index.flowsFor(ids), diffs: index.diffsFor(new Set(ids.filter(report))), contextAnchors: index.contextAnchors() };
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
