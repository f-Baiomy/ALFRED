import { CallOverlapCandidate, CallRecord, HttpMessageData } from '../../core/models/call.model';
import { CallDbAnalysis, CallDbCapture, DbColumn, DbFlag, ExportedDbStatement, StatementOrigin, TableIndex, TypedValue } from '../../core/models/db-capture.model';
import { Comment } from '../../core/models/comment.model';
import { ExportedCycle, ExportFormData } from '../../core/models/export-metadata.model';
import { buildBulkExportPayload } from './bulk-json-builder';
import { CallStatusFilter, isInProgress } from './call-utils';
import { flagText } from './db-flags';
import { analyzeCapture, suppliersOf } from './db-analysis';

/**
 * The .json export, version 2 ("alfred-calls/2") - the same data as version 1 (bulk-json-builder's event list), laid
 * out so the file is small and can be navigated without reading it whole:
 *
 *  - ONE RECORD PER LINE inside one valid JSON document, so jq/JSON.parse read it whole and grep/sed/an agent's
 *    line reader/a streaming importer read it line by line. A line is a record plus a trailing comma.
 *  - A `guide` (how to read this file, for an AI agent or a person), a `layout` (where each section is), `highlights`
 *    (failures, slow calls, database flags, comments - each with its line) and an `index` (one line per call: what it
 *    is and the line, byte offset and size of everything that belongs to it) come first. Byte offsets are written
 *    space-padded to a fixed width, so the header never changes length while they are filled in - and they stay exact
 *    for a file of any size.
 *  - Normalised, losslessly: bodies leave the call record (one per line, the same body written once, a body that is
 *    already compact JSON embedded as JSON rather than an escaped string); database rows are stored as values under
 *    their columns' types instead of a {type, value} object per cell; values every statement of a call shares are
 *    written once; an HQL origin shared by statements is written once.
 *
 * parseImportedCalls (import-parser.ts) reads both versions; the streaming reader is export-file-reader.ts.
 * Measured on a real capture (one inbound call, 12 supplier calls, 74 statements): 13.0 MB as version 1, 5.7 MB here.
 */

export const EXPORT_V2_FORMAT = 'alfred-calls/3';
export const EXPORT_V2_VERSION = 3;
/** Rows kept on a statement's own line; the rest go to `dbRows` (or, in a "sample only" export, nowhere). */
const ROW_SAMPLE = 5;
/** Bodies up to this many characters stay inside their call record - a line of their own would cost more than it saves. */
const INLINE_BODY_MAX = 256;
/** Space-padded width of every byte offset/size in the header: fixed, so filling them in never moves a byte. */
const NUM_WIDTH = 13;
/** Values hoisted out of a call's statements when every statement has the same one. */
const COMMON_STATEMENT_FIELDS = ['thread', 'dataSource', 'connectionId', 'runTag'] as const;
const MAX_HIGHLIGHTS = 300;

export interface JsonExportV2Input {
  readonly calls: readonly CallRecord[];
  readonly form: ExportFormData;
  readonly commentsByCallId: ReadonlyMap<string, readonly Comment[]>;
  readonly exportedAt: string;
  readonly overlapCandidates?: readonly CallOverlapCandidate[];
  readonly statusFilter?: CallStatusFilter;
  readonly redactedValueCount?: number;
  readonly cycle?: ExportedCycle | null;
  /**
   * Database result rows: 'all' (default - every stored row, in the `dbRows` section at the end) or 'sample' (the first
   * rows of each statement only - a smaller file, said so in the header the way redaction is).
   */
  readonly rows?: 'all' | 'sample';
}

// ------------------------------------------------------------------------------------------------ helpers

/** UTF-8 byte length without allocating an encoded copy - offsets must be in bytes, a JS string counts UTF-16 units. */
export function utf8Length(s: string): number {
  let bytes = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) bytes += 1;
    else if (c < 0x800) bytes += 2;
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
      const next = s.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        i++;
      } else bytes += 3;
    } else bytes += 3;
  }
  return bytes;
}

/** A number written in a fixed width (leading spaces are valid JSON whitespace). */
function pad(n: number): string {
  return String(n).padStart(NUM_WIDTH, ' ');
}

const OFFSET_TOKEN = '\u0000OFF';
/** A placeholder for a byte offset/size - replaced by `pad(value)` once every line's length is known. */
function slot(key: string): string {
  return `${OFFSET_TOKEN}${key}\u0000`;
}

function headerOf(headers: HttpMessageData['headers'], name: string): string | undefined {
  if (!headers) return undefined;
  const key = Object.keys(headers).find((k) => k.toLowerCase() === name);
  return key ? headers[key] : undefined;
}

/** A body that JSON.stringify(JSON.parse(body)) reproduces byte for byte - embedding it as JSON loses nothing. */
function compactJson(body: string): unknown | undefined {
  const first = body.trimStart()[0];
  if (first !== '{' && first !== '[') return undefined;
  try {
    const parsed = JSON.parse(body);
    return JSON.stringify(parsed) === body ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/**
 * A JSON body's outline - keys, value types, array lengths - so a reader sees what a multi-megabyte body holds from the
 * first few hundred bytes of its line. Arrays: ["array", length, outline of the first item].
 */
export function jsonShape(value: unknown, depth = 0): unknown {
  if (value === null) return 'null';
  if (Array.isArray(value)) return ['array', value.length, ...(value.length && depth < 4 ? [jsonShape(value[0], depth + 1)] : [])];
  if (typeof value !== 'object') return typeof value;
  if (depth >= 4) return 'object';
  const out: Record<string, unknown> = {};
  const keys = Object.keys(value as object);
  for (const k of keys.slice(0, 40)) out[k] = jsonShape((value as Record<string, unknown>)[k], depth + 1);
  if (keys.length > 40) out['…'] = `${keys.length - 40} more keys`;
  return out;
}

// ------------------------------------------------------------------------------------------------ database rows

/** One cell as the file stores it: just the value when its type is its column's, else the whole object. */
function encodeCell(cell: TypedValue | null | undefined, column: DbColumn | undefined): unknown {
  if (cell === null || cell === undefined) return {};
  const keys = Object.keys(cell);
  const plain = keys.every((k) => k === 'type' || k === 'value') && 'value' in cell && (typeof cell.value === 'string' || cell.value === null);
  if (plain && column && cell.type === column.type) return cell.value;
  return cell;
}

function decodeCell(cell: unknown, column: DbColumn | undefined): TypedValue | null {
  if (typeof cell === 'string' || cell === null) return { type: column?.type, value: cell } as TypedValue;
  if (cell && typeof cell === 'object' && 'type' in (cell as object)) return cell as TypedValue;
  return null; // {} - a cell that was null itself
}

function encodeRows(rows: readonly (readonly (TypedValue | null)[])[], columns: readonly DbColumn[] | null | undefined): unknown[][] {
  return rows.map((row) => row.map((cell, i) => encodeCell(cell, columns?.[i])));
}

function decodeRows(rows: readonly (readonly unknown[])[], columns: readonly DbColumn[] | null | undefined): TypedValue[][] {
  return rows.map((row) => row.map((cell, i) => decodeCell(cell, columns?.[i]) as TypedValue));
}

/** A call's statements, written one per line: values all of them share hoisted, shared origins referenced by id. */
function encodeCapture(callId: string, capture: CallDbCapture): { header: Record<string, unknown>; statements: Record<string, unknown>[] } {
  const { statements, layout: _layout, detail: _detail, ...rest } = capture; // `analysis` rides along in `rest`: written, never read back
  const common: Record<string, unknown> = {};
  for (const field of COMMON_STATEMENT_FIELDS) {
    const first = statements[0]?.[field];
    if (statements.length > 1 && typeof first === 'string' && statements.every((s) => s[field] === first)) common[field] = first;
  }
  const origins: Record<string, StatementOrigin> = {};
  // Call chains repeat across a call's statements (one service runs dozens of queries) - each written once.
  const stacks: Record<string, readonly string[]> = {};
  const stackIds = new Map<string, string>();
  const tableIndexes: Record<string, readonly TableIndex[]> = {};
  const encoded = statements.map((s) => {
    const { rows, beforeImageRows, origin, callId: ownCallId, callers, indexes: ownIndexes, ...fields } = s;
    const out: Record<string, unknown> = { of: callId };
    for (const [k, v] of Object.entries(fields)) {
      if (!(k in common)) out[k] = v;
    }
    if (ownCallId === undefined) out['noCallId'] = true;
    else if (ownCallId !== callId) out['callId'] = ownCallId;
    if (origin) {
      const known = origins[origin.id];
      if (!known) origins[origin.id] = origin;
      out['origin'] = !known || JSON.stringify(known) === JSON.stringify(origin) ? origin.id : origin;
    }
    if (callers) {
      const key = JSON.stringify(callers);
      let id = stackIds.get(key);
      if (!id) {
        id = `s${stackIds.size + 1}`;
        stackIds.set(key, id);
        stacks[id] = callers;
      }
      out['stack'] = id;
    }
    if (ownIndexes) {
      // a table's index list, once per call: the statement names the table it belongs to
      const key = (s.table ?? '').toLowerCase() || `#${s.seq}`;
      const known = tableIndexes[key];
      if (!known || JSON.stringify(known) === JSON.stringify(ownIndexes)) {
        tableIndexes[key] = ownIndexes;
        out['indexes'] = key;
      } else {
        out['indexes'] = ownIndexes;
      }
    }
    if (rows) out['rowValues'] = encodeRows(rows, s.outcome.columns);
    if (beforeImageRows) out['beforeValues'] = encodeRows(beforeImageRows, s.beforeImage?.columns);
    return out;
  });
  const header: Record<string, unknown> = { callId, ...rest };
  if (Object.keys(common).length) header['common'] = common;
  if (Object.keys(origins).length) header['origins'] = origins;
  if (Object.keys(stacks).length) header['stacks'] = stacks;
  if (Object.keys(tableIndexes).length) header['indexes'] = tableIndexes;
  return { header, statements: encoded };
}

export function decodeCapture(header: Record<string, unknown>, lines: readonly Record<string, unknown>[],
                              fullRows: ReadonlyMap<number, unknown[][]> = new Map()): CallDbCapture {
  // `analysis` is derived (db-analysis.ts) - recomputed by whoever needs it, never imported.
  const { callId, common, origins, stacks, indexes: tableIndexes, statements: _range, analysis: _analysis, ...rest } = header as {
    callId: string; common?: Record<string, unknown>; origins?: Record<string, StatementOrigin>; stacks?: Record<string, string[]>;
    indexes?: Record<string, TableIndex[]>; statements?: unknown;
  } & Record<string, unknown>;
  const statements = lines.map((line) => {
    const { of, noCallId, rowValues, beforeValues, origin, stack, indexes, rowSample, rowsAt: _at, rowsSampled: _sampled, ...fields } = line as Record<string, unknown> & {
      rowSample?: unknown[][]; rowsAt?: unknown; rowsSampled?: boolean;
      of: string; noCallId?: boolean; rowValues?: unknown[][]; beforeValues?: unknown[][]; origin?: string | StatementOrigin; stack?: string;
      indexes?: string | TableIndex[];
    };
    const s: Record<string, unknown> = { ...(common ?? {}), ...fields };
    if (!noCallId && !('callId' in fields)) s['callId'] = of;
    if (origin !== undefined) s['origin'] = typeof origin === 'string' ? origins?.[origin] : origin;
    if (stack !== undefined) s['callers'] = stacks?.[stack];
    if (indexes !== undefined) s['indexes'] = typeof indexes === 'string' ? tableIndexes?.[indexes] : indexes;
    const outcome = s['outcome'] as ExportedDbStatement['outcome'];
    const rows = rowValues ?? fullRows.get(fields['seq'] as number) ?? rowSample;
    if (rows) s['rows'] = decodeRows(rows, outcome?.columns);
    if (beforeValues) s['beforeImageRows'] = decodeRows(beforeValues, (s['beforeImage'] as ExportedDbStatement['beforeImage'])?.columns);
    return s as unknown as ExportedDbStatement;
  });
  return { ...(rest as Omit<CallDbCapture, 'statements'>), statements };
}

// ------------------------------------------------------------------------------------------------ the guide

/** What an AI agent (or a person with a terminal) needs to read this file without loading it whole. */
function guide(counts: { calls: number; bodies: number; dbStatements: number }): Record<string, unknown> {
  return {
    what: 'An Alfred capture: HTTP calls into an application (inbound) and the calls it made (outbound/supplier), with bodies, comments, interception and the database statements each inbound call ran. Nothing is truncated.',
    readFirst: 'Lines 1-6 (this guide, layout, about, metadata), then `highlights` and `index`. Do NOT read the whole file: use the index to jump to what you need.',
    lines: 'One record per line. A record line is JSON followed by a comma (except the last line of a section): strip a trailing "," and JSON.parse it. Section lines are `"name":[` ... `],`. Line numbers are 1-based.',
    jump: {
      byLine: 'Read the line given as `line` (e.g. a line-offset/limit read, or `sed -n "<line>p" file`).',
      byOffset: '`offset` + `bytes` are exact byte positions of that line (UTF-8): seek and read exactly that many bytes - works for any file size, e.g. python: f=open(p,"rb"); f.seek(offset); json.loads(f.read(bytes).rstrip(b",")).',
      byId: 'grep -n \'"callId":"<id>"\' finds a call; bodies and statements name their call too ("refs"/"of").',
      big: 'Body lines can be megabytes - check `bytes`/`chars` in the index before reading one; read part of it with jq or python (e.g. jq a path inside `json`) instead of the whole line.',
    },
    sections: {
      layout: 'first/last line, byte offset and size of every section below',
      highlights: `what deserves attention first: failed or slow calls, database flags, comments - each with the line to read (at most ${MAX_HIGHLIGHTS}; the index has every call)`,
      index: 'one line per call, in time order: id, direction, method, url, status, ms, parent link, comment count, where its call record, request/response bodies and database statements are, and for a call with statements `time` (db/outbound/gap/edge ms), db counts (transactions, duplicates, queries, roundTripMs) and `findings` (severity, title, impactMs, the first 20 statement seqs - the full text is in its dbCalls `analysis.findings`)',
      calls: 'one call per line: headers, status, timing, comments, interception, WebSocket messages, parent link. A body under 257 characters is inline; a longer one is `bodyRef` → `bodies`',
      bodies: 'one body per line: `shape` (a JSON body\'s outline - keys, types, array lengths - written BEFORE the body, so the first bytes of the line tell you what it holds), then `json` (the body was compact JSON - embedded as is) or `text` (verbatim); `refs` = which calls/sides use it (the same body is stored once)',
      dbCalls: 'one line per inbound call with captured database statements: summary (counts, flags), transactions, supplier calls in order (`supplierMarkers`), values all its statements share (`common`), HQL/query origins by id (`origins`), application call chains by id (`stacks`: innermost first, past the project pass-through classes), table index lists (`indexes`, by table - when the project turned the Index check on), and `analysis`: `time` (where the call\'s time went - dbMs, outboundMs, gapMs between statements, edgeMs, gap count/median/max, the largest gaps with the code that ran next, the database round trip) `queries` (one entry per query, costliest first: runs, distinct params, exact duplicates, total ms, rows, called from, statement seqs), `summary` (the one line the database window opens with) and `findings` (what to fix, worst first: severity bad/warn/note, title, short and full why, fix, impact, the statements by seq - errors, idle stretches, one HQL query fanning out into many SQL statements, huge reads, exact duplicates, slow queries, supplier time). Start here for "why is this call slow".',
      dbStatements: 'one statement per line, `of` = its call, in run order (`seq`): SQL with `?` placeholders and `params` (one list per batch set), outcome, timing, transaction, where in code, `origin` (the HQL it came from, an id into its dbCalls `origins`), `stack` (the application code that issued it, an id into `stacks` - `codeLocation` is only the first application frame), `indexes` (its table, a key into `indexes`). In `outcome`: `acquireMicros` (connection checkout before it), and on a COMMIT/ROLLBACK line `via` (JDBC/JTA), `beginMicros`, `commitMicros`, `closeMicros`; `transactions[].lifecycle` has the same per transaction. `analysis.time.overheadMs` sums them. `rowValues`/`beforeValues` = rows as values under `outcome.columns`/`beforeImage.columns` types; a cell that is an object is a full {type,value,...}; {} = a null cell. A statement with more than ${ROW_SAMPLE} rows carries `rowSample` (its first ${ROW_SAMPLE}) and `rowsAt` (line/offset/bytes/count of its full rows in `dbRows`) - or `rowsSampled: true` when this export kept samples only',
      dbRows: 'one line per statement with more than ' + ROW_SAMPLE + ' rows: `of`, `seq`, `rowValues` (every stored row). Last section on purpose - most questions never need it',
    },
    glossary: {
      inbound: 'a request INTO the application, logged by Alfred\'s reverse proxy ("source":"internal")',
      outbound: 'a call the application made to another system ("source":"external")',
      parentCallId: 'on an outbound call: the inbound call that made it; parentSeq = its place in that call\'s sequence, shared with the database statements\' seq',
      redactedValueCount: 'values hidden before export (shown as ***REDACTED***); non-zero means the file is deliberately incomplete',
      rowsSampled: 'present when the export kept only the first rows of that many statements (`outcome.rowsRead` is still the true count)',
    },
    counts,
  };
}

// ------------------------------------------------------------------------------------------------ build

interface BodyRecord {
  readonly id: string;
  readonly body: string;
  readonly refs: { call: string; side: 'request' | 'response' }[];
  readonly contentType?: string;
}

/**
 * The file's lines (without newlines - join with "\n"). An array of strings rather than one string: a large export
 * goes into a Blob part by part and never has to exist as a single string.
 */
export function buildJsonExportV2(input: JsonExportV2Input): string[] {
  const calls = [...input.calls].sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
  const v1 = buildBulkExportPayload(calls, input.form, input.commentsByCallId, input.exportedAt, input.overlapCandidates ?? [],
    input.statusFilter ?? 'all', input.redactedValueCount ?? 0, input.cycle ?? null);

  // ---- bodies: long ones leave the call, each distinct body once
  const bodies: BodyRecord[] = [];
  const bodyIds = new Map<string, BodyRecord>();
  const bodyRef = (callId: string, side: 'request' | 'response', msg: HttpMessageData | undefined): BodyRecord | null => {
    const body = msg?.body;
    if (typeof body !== 'string' || body.length <= INLINE_BODY_MAX) return null;
    let record = bodyIds.get(body);
    if (!record) {
      record = { id: `b${bodies.length + 1}`, body, refs: [], contentType: headerOf(msg?.headers, 'content-type') };
      bodies.push(record);
      bodyIds.set(body, record);
    }
    record.refs.push({ call: callId, side });
    return record;
  };
  const refsByCall = new Map<string, { request?: BodyRecord; response?: BodyRecord }>();
  for (const call of calls) {
    refsByCall.set(call.id, {
      request: bodyRef(call.id, 'request', call.request) ?? undefined,
      response: bodyRef(call.id, 'response', call.response) ?? undefined,
    });
  }

  // ---- database captures - each with where its time went (db-analysis.ts): attached by the export dialog, which
  // also fetched the supplier calls, or derived from the supplier calls that are in this export.
  const analyses = new Map(calls.filter((c) => c.dbCapture).map((c) => [c.id,
    c.dbCapture!.analysis ?? (c.duration_ms ? analyzeCapture(c, c.dbCapture!, suppliersOf(c.id, calls)) : undefined)]));
  const captured = calls.filter((c) => c.dbCapture);
  const dbHeaders: Record<string, unknown>[] = [];
  const dbStatementsByCall = new Map<string, Record<string, unknown>[]>();
  for (const call of captured) {
    const { header, statements } = encodeCapture(call.id, { ...call.dbCapture!, analysis: analyses.get(call.id) });
    dbHeaders.push(header);
    dbStatementsByCall.set(call.id, statements);
  }
  const dbStatements = captured.flatMap((c) => dbStatementsByCall.get(c.id)!);
  // Rows past the first few leave the statement's line: reading statements never loads them. 'all' keeps them, one
  // line per statement at the end (`dbRows`); 'sample' drops them and says so.
  const dbRows: { of: string; seq: number; rowValues: unknown[][] }[] = [];
  const rowsLineKey = new Map<Record<string, unknown>, number>();
  let rowsSampled = 0;
  for (const s of dbStatements) {
    const rows = s['rowValues'] as unknown[][] | undefined;
    if (!rows || rows.length <= ROW_SAMPLE) continue;
    delete s['rowValues'];
    s['rowSample'] = rows.slice(0, ROW_SAMPLE);
    if (input.rows === 'sample') {
      s['rowsSampled'] = true;
      rowsSampled++;
    } else {
      rowsLineKey.set(s, dbRows.length);
      dbRows.push({ of: s['of'] as string, seq: s['seq'] as number, rowValues: rows });
    }
  }

  // ---- line numbers: every section's size is known now, so every record's line is too
  const highlights = buildHighlights(calls, input, analyses);
  const HEADER_LINES = 5; // first line, guide, layout, about, metadata
  const sectionSizes: [string, number][] = [
    ['highlights', Math.min(highlights.length, MAX_HIGHLIGHTS)], ['index', calls.length], ['calls', calls.length],
    ['bodies', bodies.length], ['dbCalls', dbHeaders.length], ['dbStatements', dbStatements.length], ['dbRows', dbRows.length],
  ];
  const firstLine = new Map<string, number>();
  let line = HEADER_LINES + 1;
  for (const [name, size] of sectionSizes) {
    firstLine.set(name, line + 1); // the `"name":[` line comes first
    line += size + 2;
  }
  const callLine = new Map(calls.map((c, i) => [c.id, firstLine.get('calls')! + i]));
  const bodyLine = new Map(bodies.map((b, i) => [b.id, firstLine.get('bodies')! + i]));
  const dbHeaderLine = new Map(captured.map((c, i) => [c.id, firstLine.get('dbCalls')! + i]));
  const dbFirstStatementLine = new Map<string, number>();
  {
    let next = firstLine.get('dbStatements')!;
    for (const c of captured) {
      dbFirstStatementLine.set(c.id, next);
      next += dbStatementsByCall.get(c.id)!.length;
    }
  }
  const statementLine = (callId: string, seq: number): number | undefined => {
    const list = dbStatementsByCall.get(callId);
    const i = list?.findIndex((s) => s['seq'] === seq) ?? -1;
    return i >= 0 ? dbFirstStatementLine.get(callId)! + i : undefined;
  };

  // ---- record lines
  const commentsOf = (id: string) => input.commentsByCallId.get(id) ?? [];
  const message = (msg: HttpMessageData | undefined, ref: BodyRecord | undefined): unknown => {
    if (!msg) return undefined;
    if (!ref) return msg;
    const { body: _body, ...rest } = msg;
    return { ...rest, bodyRef: ref.id };
  };
  const callRecords = calls.map((call) => {
    const refs = refsByCall.get(call.id)!;
    return {
      callId: call.id,
      source: call.source ?? 'external',
      service_name: call.service_name,
      method: call.method,
      original_url: call.original_url,
      url: call.url,
      timestamp: call.timestamp,
      duration_ms: call.duration_ms,
      status: call.response?.status,
      error: call.error,
      request: message(call.request, refs.request),
      response: message(call.response, refs.response),
      session_id: call.session_id,
      operation_id: call.operation_id,
      state: call.state,
      supplierName: call.supplierName,
      parentCallId: call.parentCallId ?? undefined,
      parentSeq: call.parentSeq ?? undefined,
      comments: commentsOf(call.id),
      interception: call.interception ?? undefined,
      wsMessages: call.wsMessages,
      db: dbHeaderLine.has(call.id) ? { line: dbHeaderLine.get(call.id) } : undefined,
    };
  });
  const bodyRecords = bodies.map((b) => {
    const json = compactJson(b.body);
    // the outline first, so the head of a multi-megabyte line already says what is in it
    return { body: b.id, refs: b.refs, contentType: b.contentType, chars: b.body.length,
      ...(json !== undefined ? { shape: jsonShape(json), json } : { text: b.body }) };
  });
  for (const [s, i] of rowsLineKey) {
    const at = firstLine.get('dbRows')! + i;
    s['rowsAt'] = { line: at, offset: `@@OFF:L${at}@@`, bytes: `@@OFF:B${at}@@`, count: (dbRows[i].rowValues).length };
  }
  const dbHeaderRecords = dbHeaders.map((h) => {
    const id = h['callId'] as string;
    const first = dbFirstStatementLine.get(id)!;
    return { ...h, statements: { count: dbStatementsByCall.get(id)!.length, lines: [first, first + dbStatementsByCall.get(id)!.length - 1] } };
  });

  const callTexts = callRecords.map((r) => JSON.stringify(r));
  const bodyTexts = bodyRecords.map((r) => JSON.stringify(r));
  const dbHeaderTexts = dbHeaderRecords.map((r) => JSON.stringify(r));
  const dbStatementTexts = dbStatements.map((r) => JSON.stringify(r));
  const dbRowTexts = dbRows.map((r) => JSON.stringify(r));

  const indexTexts = calls.map((call, i) => {
    const refs = refsByCall.get(call.id)!;
    const side = (msg: HttpMessageData | undefined, ref: BodyRecord | undefined) => {
      if (!msg?.body) return undefined;
      return ref
        ? `{"line":${bodyLine.get(ref.id)},"offset":${slot(`L${bodyLine.get(ref.id)}`)},"bytes":${slot(`B${bodyLine.get(ref.id)}`)},"chars":${msg.body.length}${ref.refs.length > 1 ? ',"shared":true' : ''}}`
        : `{"inline":true,"chars":${msg.body.length}}`;
    };
    const head = {
      n: i + 1, callId: call.id, dir: call.source === 'internal' ? 'inbound' : 'outbound', service: call.service_name ?? undefined,
      method: call.method, url: call.url, status: call.response?.status, error: call.error ? call.error.slice(0, 120) : undefined,
      ms: call.duration_ms, at: call.timestamp, state: call.state, parent: call.parentCallId ?? undefined, parentSeq: call.parentSeq ?? undefined,
      comments: commentsOf(call.id).length || undefined,
      // what the database window says about the call, worst first - the full text is in its dbCalls line
      findings: analyses.get(call.id)?.findings?.length
        ? analyses.get(call.id)!.findings!.map((f) => ({ severity: f.severity, title: f.title, impactMs: f.impactMs ?? undefined, seqs: f.seqs.slice(0, 20) }))
        : undefined,
    };
    const parts = [JSON.stringify(head).slice(0, -1)];
    const cl = callLine.get(call.id)!;
    parts.push(`"line":${cl},"offset":${slot(`L${cl}`)},"bytes":${slot(`B${cl}`)}`);
    const req = side(call.request, refs.request);
    const res = side(call.response, refs.response);
    if (req) parts.push(`"req":${req}`);
    if (res) parts.push(`"res":${res}`);
    if (call.dbCapture) {
      const hl = dbHeaderLine.get(call.id)!;
      const first = dbFirstStatementLine.get(call.id)!;
      const count = dbStatementsByCall.get(call.id)!.length;
      const flags = call.dbCapture.summary?.flags?.length ?? 0;
      const a = analyses.get(call.id);
      const extra = a ? `,"transactions":${a.time.transactions},"duplicates":${a.queries.reduce((n, q) => n + q.duplicates, 0)},"queries":${a.queries.length}` +
        `${a.time.baselineMs ? `,"roundTripMs":${a.time.baselineMs}` : ''}` : '';
      parts.push(`"db":{"line":${hl},"offset":${slot(`L${hl}`)},"statements":${count},"lines":[${count ? `${first},${first + count - 1}` : ''}]` +
        (count ? `,"statementsOffset":${slot(`L${first}`)},"statementsBytes":${slot(`R${first}-${first + count - 1}`)}` : '') +
        `${flags ? `,"flags":${flags}` : ''}${extra}}`);
      if (a) {
        const t = a.time;
        parts.push(`"time":${JSON.stringify({ dbMs: t.dbMs, outboundMs: t.outboundMs, gapMs: t.gapMs, edgeMs: t.edgeMs, gaps: t.gaps, appTimeDominant: t.appTimeDominant || undefined })}`);
      }
    }
    return `${parts.join(',')}}`;
  });

  const highlightTexts = highlights.slice(0, MAX_HIGHLIGHTS).map((h) => {
    const line = h.statementSeq != null ? statementLine(h.callId, h.statementSeq) ?? callLine.get(h.callId) : callLine.get(h.callId);
    return JSON.stringify({ what: h.what, callId: h.callId, line, note: h.note });
  });

  const counts = { calls: calls.length, bodies: bodies.length, dbStatements: dbStatements.length, dbRows: dbRows.length };
  const sections: [string, string[]][] = [
    ['highlights', highlightTexts], ['index', indexTexts], ['calls', callTexts],
    ['bodies', bodyTexts], ['dbCalls', dbHeaderTexts], ['dbStatements', dbStatementTexts], ['dbRows', dbRowTexts],
  ];
  const layoutText = `"layout":{${sections.map(([name, texts]) => {
    const first = firstLine.get(name)!;
    const last = first + texts.length - 1;
    if (!texts.length) return `"${name}":{"lines":[],"count":0}`;
    return `"${name}":{"lines":[${first},${last}],"count":${texts.length},"offset":${slot(`L${first}`)},"bytes":${slot(`R${first}-${last}`)}}`;
  }).join(',')}},`;

  const lines: string[] = [
    `{"alfredExport":${EXPORT_V2_VERSION},"format":"${EXPORT_V2_FORMAT}","exportedAt":${JSON.stringify(v1.exportedAt)},`,
    `"guide":${JSON.stringify(guide(counts))},`,
    layoutText,
    `"about":${JSON.stringify(v1.about)},`,
    `"metadata":${JSON.stringify(v1.metadata)},"redactedValueCount":${v1.redactedValueCount},${rowsSampled ? `"rowsSampled":${rowsSampled},` : ''}"summary":${JSON.stringify(v1.summary)},`,
  ];
  sections.forEach(([name, texts], s) => {
    lines.push(`"${name}":[`);
    texts.forEach((t, i) => lines.push(i < texts.length - 1 ? `${t},` : t));
    lines.push(s < sections.length - 1 ? '],' : ']}');
  });

  // ---- byte offsets: every slot has a fixed width, so measuring now gives the final positions
  const offsets: number[] = [];
  const sizes: number[] = [];
  let at = 0;
  for (const text of lines) {
    const bytes = utf8Length(text.replace(/\u0000OFF[^\u0000]*\u0000|"@@OFF:[^@]*@@"/g, ' '.repeat(NUM_WIDTH)));
    offsets.push(at);
    sizes.push(bytes);
    at += bytes + 1;
  }
  const lineOffset = (n: number) => offsets[n - 1];
  const lineBytes = (n: number) => sizes[n - 1];
  return lines.map((text) => text.includes(OFFSET_TOKEN) || text.includes('"@@OFF:')
    ? text.replace(/\u0000OFF([LBR])(\d+)(?:-(\d+))?\u0000|"@@OFF:([LBR])(\d+)(?:-(\d+))?@@"/g, (_m, k1?: string, a1?: string, b1?: string, k2?: string, a2?: string, b2?: string) => {
      const kind = (k1 ?? k2)!;
      const a = (a1 ?? a2)!;
      const b = b1 ?? b2;
      const from = Number(a);
      if (kind === 'L') return pad(lineOffset(from));
      if (kind === 'B') return pad(lineBytes(from));
      const to = Number(b);
      return pad(lineOffset(to) + lineBytes(to) - lineOffset(from));
    })
    : text);
}

interface Highlight {
  readonly what: string;
  readonly callId: string;
  readonly note: string;
  readonly statementSeq?: number;
  readonly rank: number;
}

/** What to look at first, most important first. */
function buildHighlights(calls: readonly CallRecord[], input: JsonExportV2Input, analyses: ReadonlyMap<string, CallDbAnalysis | undefined>): Highlight[] {
  const out: Highlight[] = [];
  const label = (c: CallRecord) => `${c.method} ${c.url}`;
  for (const c of calls) {
    if (c.error) out.push({ what: 'FAILED', callId: c.id, note: `${label(c)} - ${c.error.slice(0, 200)}`, rank: 0 });
    else if ((c.response?.status ?? 0) >= 500) out.push({ what: 'HTTP_5XX', callId: c.id, note: `${label(c)} → ${c.response!.status}`, rank: 1 });
    else if ((c.response?.status ?? 0) >= 400) out.push({ what: 'HTTP_4XX', callId: c.id, note: `${label(c)} → ${c.response!.status}`, rank: 2 });
    if (isInProgress(c)) out.push({ what: 'IN_PROGRESS', callId: c.id, note: `${label(c)} - still running when exported`, rank: 3 });
    // The database window's findings (db-findings.ts) when the call has them - the notes left out - else one line per
    // flag, a call's flags of one type a single line when there are more than 3 (20 "slow" lines would bury the rest).
    const findings = analyses.get(c.id)?.findings;
    for (const f of findings ?? []) {
      if (f.severity === 'note') continue;
      out.push({ what: `DB_${f.source}`, callId: c.id, statementSeq: f.seqs[0], rank: f.severity === 'bad' ? 1 : 4,
        note: `${label(c)} - ${f.title} - ${f.short}${f.impact ? ` (${f.impact})` : ''}${f.seqs.length ? ` · statements #${f.seqs.slice(0, 10).join(', #')}${f.seqs.length > 10 ? ' …' : ''}` : ''}` });
    }
    const byType = new Map<string, DbFlag[]>();
    for (const flag of findings ? [] : c.dbCapture?.summary?.flags ?? []) byType.set(flag.type, [...(byType.get(flag.type) ?? []), flag]);
    for (const [type, flags] of byType) {
      const rank = flags.some((f) => f.severity === 'BAD') ? 1 : 4;
      const seqList = (seqs: readonly number[]) => `${seqs.slice(0, 10).map((s) => '#' + s).join(', ')}${seqs.length > 10 ? ' …' : ''}`;
      if (flags.length > 3) {
        const seqs = flags.flatMap((f) => f.seqs);
        out.push({ what: `DB_${type}`, callId: c.id, statementSeq: seqs[0], note: `${flags.length} × ${flagText(flags[0]).split(' · ')[0]} - e.g. ${flagText(flags[0])} (statements ${seqList(seqs)})`, rank });
      } else {
        for (const flag of flags) out.push({ what: `DB_${type}`, callId: c.id, statementSeq: flag.seqs[0], note: `${flagText(flag)} (statements ${seqList(flag.seqs)})`, rank });
      }
    }
    const t = analyses.get(c.id)?.time;
    if (t?.appTimeDominant) {
      const top = t.topGaps[0];
      out.push({ what: 'APP_TIME_DOMINANT', callId: c.id, statementSeq: top?.beforeSeq ?? undefined, rank: 2,
        note: `${label(c)} - ${Math.round(((t.gapMs + t.edgeMs) / t.totalMs) * 100)}% of ${Math.round(t.totalMs)} ms is neither DB (${Math.round(t.dbMs)} ms) nor supplier calls: ` +
          `${t.gaps.count} gaps between statements, median ${t.gaps.medianMs} ms${top ? `, largest ${top.ms} ms before #${top.beforeSeq}${top.callers?.length ? ` (${top.callers[0]})` : ''}` : ''}` });
    }
    for (const comment of input.commentsByCallId.get(c.id) ?? []) {
      out.push({ what: 'COMMENT', callId: c.id, note: `${comment.block}: ${comment.comment.slice(0, 200)}`, rank: 2 });
    }
  }
  const slowest = [...calls].filter((c) => (c.duration_ms ?? 0) > 0).sort((a, b) => (b.duration_ms ?? 0) - (a.duration_ms ?? 0)).slice(0, 5);
  for (const c of slowest) out.push({ what: 'SLOW', callId: c.id, note: `${label(c)} - ${Math.round(c.duration_ms ?? 0)} ms`, rank: 5 });
  return out.sort((a, b) => a.rank - b.rank);
}

// ------------------------------------------------------------------------------------------------ read

/** Version 2 back into version 1's call-shaped records - what import-parser's merge already understands. */
export function v2ToCallRecords(file: Record<string, unknown>): Record<string, unknown>[] {
  const bodies = new Map<string, string>();
  for (const b of (file['bodies'] as Record<string, unknown>[] | undefined) ?? []) {
    const text = typeof b['text'] === 'string' ? (b['text'] as string) : JSON.stringify(b['json']);
    bodies.set(b['body'] as string, text);
  }
  const statementsByCall = new Map<string, Record<string, unknown>[]>();
  for (const s of (file['dbStatements'] as Record<string, unknown>[] | undefined) ?? []) {
    const of = s['of'] as string;
    if (!statementsByCall.has(of)) statementsByCall.set(of, []);
    statementsByCall.get(of)!.push(s);
  }
  const rowsByCall = new Map<string, Map<number, unknown[][]>>();
  for (const r of (file['dbRows'] as Record<string, unknown>[] | undefined) ?? []) {
    const of = r['of'] as string;
    if (!rowsByCall.has(of)) rowsByCall.set(of, new Map());
    rowsByCall.get(of)!.set(r['seq'] as number, r['rowValues'] as unknown[][]);
  }
  const captures = new Map<string, CallDbCapture>();
  for (const h of (file['dbCalls'] as Record<string, unknown>[] | undefined) ?? []) {
    const id = h['callId'] as string;
    captures.set(id, decodeCapture(h, statementsByCall.get(id) ?? [], rowsByCall.get(id)));
  }
  const message = (msg: unknown): unknown => {
    if (!msg || typeof msg !== 'object') return msg;
    const { bodyRef, ...rest } = msg as Record<string, unknown>;
    return typeof bodyRef === 'string' ? { ...rest, body: bodies.get(bodyRef) } : rest;
  };
  return ((file['calls'] as Record<string, unknown>[] | undefined) ?? []).map((c) => {
    const { db: _db, request, response, ...rest } = c;
    const id = c['callId'] as string;
    return { ...rest, request: message(request), response: message(response), dbCapture: captures.get(id) };
  });
}
