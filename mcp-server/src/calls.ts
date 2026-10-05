import { seg, AlfredError, type AlfredClient } from './alfred-client.ts';
import { cyclesHolding, segmentOf } from './cycle-calls.ts';
import {
  supplierOf, toCallRecord,
  type CallDetail, type CallDetailPart, type CallEndpointSource, type CallRecord, type CallSummaryDto,
} from './frontend.ts';
import { chunkText, isBinary, notFound, type BodyChunk } from './reply.ts';

export type Direction = 'inbound' | 'outbound';

export function directionOf(source: CallEndpointSource | undefined): Direction {
  return source === 'internal' ? 'inbound' : 'outbound';
}

export function sourceOf(direction: Direction): CallEndpointSource {
  return direction === 'inbound' ? 'internal' : 'external';
}

/** Where a call is read from: the live log, or a cycle's copy of it. */
export interface CallRef {
  readonly id: string;
  readonly source: CallEndpointSource;
  readonly cycleId?: string;
}

function base(ref: CallRef): string {
  return ref.cycleId
    ? `/session-cycles/${seg(ref.cycleId)}/${segmentOf(ref.source)}/${seg(ref.id)}`
    : `/${segmentOf(ref.source)}/${seg(ref.id)}`;
}

/**
 * The live summary of a call whose direction may be unknown. Inbound is tried first: the calls a
 * user debugs from their app's project are mostly its inbound ones. Not found anywhere → the
 * error says inbound is a ring buffer and names the cycles that still hold a copy (G3).
 */
export async function liveSummary(client: AlfredClient, id: string, direction?: Direction): Promise<{ call: CallRecord; source: CallEndpointSource }> {
  const order: CallEndpointSource[] = direction ? [sourceOf(direction)] : ['internal', 'external'];
  for (const source of order) {
    try {
      const dto = await client.get<CallSummaryDto>(`/${segmentOf(source)}/${seg(id)}/summary`);
      return { call: toCallRecord(dto, source), source };
    } catch (error) {
      if (!(error instanceof AlfredError) || error.kind !== 'not_found') throw error;
    }
  }
  const holding = await cyclesHolding(client, id);
  const where = holding.length
    ? ` These cycles still hold a copy - read it with cycleId: ${holding.map((c) => `${c.name} (${c.id})`).join('; ')}.`
    : ' No session cycle holds a copy either.';
  throw notFound(`Call ${id} is not in the live log. Inbound calls are a ring buffer (the last ~1,500 are kept), so an older one has been dropped.${where}`);
}

const PART_FIELDS: Readonly<Record<string, CallDetailPart>> = {
  requestHeaders: 'request-headers',
  requestBody: 'request-body',
  responseHeaders: 'response-headers',
  responseBody: 'response-body',
};

/** Fetches only the named parts and merges them into the call - a selection of "method, url" costs no detail request at all. */
export async function withParts(client: AlfredClient, ref: CallRef, call: CallRecord, parts: readonly CallDetailPart[] | 'all'): Promise<CallRecord> {
  if (parts !== 'all' && parts.length === 0) return call;
  const details = parts === 'all'
    ? [await client.get<CallDetail>(`${base(ref)}/detail`, { notFound: `Call ${ref.id} not found${ref.cycleId ? ` in cycle ${ref.cycleId}` : ''}.` })]
    : await Promise.all(parts.map((part) => client.get<CallDetail>(`${base(ref)}/detail`, { query: { part }, notFound: `Call ${ref.id} not found.` })));
  let request = call.request;
  let response = call.response;
  for (const detail of details) {
    // A part request answers the other half of its side with explicit nulls (`?part=request-headers`
    // gives `{headers: {...}, body: null}`); merging those would wipe a body fetched by another part.
    if (detail.request) request = { ...request, ...present(detail.request) };
    if (detail.response) response = { ...response, ...present(detail.response) } as CallRecord['response'];
  }
  return { ...call, request, response };
}

function present<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== null && v !== undefined)) as Partial<T>;
}

/** The complete record - summary plus request and response - as copying into a cycle and exporting need it. */
export async function hydrate(client: AlfredClient, ref: CallRef, summary: CallRecord): Promise<CallRecord> {
  return withParts(client, ref, summary, 'all');
}

// ------------------------------------------------------------------------------------------------ rows and selection

export interface CallRow {
  readonly id: string;
  readonly direction: Direction;
  readonly method: string;
  readonly url: string;
  readonly status: number | null;
  readonly durationMs: number | null;
  readonly time: string;
  readonly project?: string;
  readonly error?: string;
}

/** The short row every list uses. Inbound shows the URL the caller used (original_url), outbound the supplier URL. */
export function toRow(call: CallRecord): CallRow {
  const direction = directionOf(call.source);
  return {
    id: call.id,
    direction,
    method: call.method,
    url: direction === 'inbound' ? (call.original_url || call.url) : (call.url || call.original_url),
    status: call.response?.status ?? null,
    durationMs: call.duration_ms ?? null,
    time: call.timestamp,
    ...(call.service_name ? { project: call.service_name } : {}),
    ...(call.error ? { error: call.error } : {}),
  };
}

export const FIELD_NAMES = [
  'id', 'direction', 'method', 'url', 'originalUrl', 'status', 'duration', 'time', 'state', 'error', 'project', 'supplier',
  'parentCallId', 'requestHeaders', 'requestBody', 'responseHeaders', 'responseBody', 'timing', 'children', 'comments', 'db',
] as const;
export type FieldName = (typeof FIELD_NAMES)[number];

/** The detail parts a selection needs - free paths into request/response need that whole side. */
export function partsFor(fields: readonly FieldName[] | undefined, paths: readonly string[] | undefined): CallDetailPart[] {
  const parts = new Set<CallDetailPart>();
  for (const f of fields ?? []) {
    if (!PART_FIELDS[f]) continue;
    parts.add(PART_FIELDS[f]);
    // A body is judged (binary? which type?) by its Content-Type - a few hundred bytes worth fetching with it.
    if (f === 'requestBody') parts.add('request-headers');
    if (f === 'responseBody') parts.add('response-headers');
  }
  for (const p of paths ?? []) {
    const head = p.split('.')[0].toLowerCase();
    if (head === 'request') { parts.add('request-headers'); parts.add('request-body'); }
    if (head === 'response') { parts.add('response-headers'); parts.add('response-body'); }
  }
  return [...parts];
}

export interface BodyView extends Partial<BodyChunk> {
  readonly binary?: true;
  readonly contentType?: string;
  readonly totalLength: number;
}

function header(headers: Readonly<Record<string, string>> | undefined, name: string): string | undefined {
  if (!headers) return undefined;
  const key = Object.keys(headers).find((k) => k.toLowerCase() === name.toLowerCase());
  return key ? headers[key] : undefined;
}

/** A body as Claude sees it: a chunk with its full size and where the next one starts, or just type and size for binary. */
export function bodyView(body: string | undefined, headers: Readonly<Record<string, string>> | undefined, offset: number, length: number): BodyView {
  const value = body ?? '';
  const contentType = header(headers, 'content-type');
  if (isBinary(contentType, value)) return { binary: true, ...(contentType ? { contentType } : {}), totalLength: value.length };
  return { ...chunkText(value, offset, length), ...(contentType ? { contentType } : {}) };
}

/** Dot-path lookup; object keys match case-insensitively so `response.headers.content-type` finds `Content-Type`. */
export function lookupPath(root: unknown, path: string): { found: boolean; value?: unknown } {
  let node: unknown = root;
  for (const part of path.split('.')) {
    if (node === null || typeof node !== 'object') return { found: false };
    const obj = node as Record<string, unknown>;
    const key = part in obj ? part : Object.keys(obj).find((k) => k.toLowerCase() === part.toLowerCase());
    if (key === undefined) return { found: false };
    node = obj[key];
  }
  return { found: true, value: node };
}

export interface Extras {
  readonly children?: unknown;
  readonly comments?: unknown;
  readonly db?: unknown;
}

export interface Selection {
  readonly values: Record<string, unknown>;
  readonly missing: string[];
}

export function select(call: CallRecord, fields: readonly FieldName[] | undefined, paths: readonly string[] | undefined,
                       extras: Extras, bodyOffset: number, bodyLength: number): Selection {
  const values: Record<string, unknown> = {};
  const missing: string[] = [];
  const row = toRow(call);
  for (const f of fields ?? []) {
    switch (f) {
      case 'id': values[f] = call.id; break;
      case 'direction': values[f] = row.direction; break;
      case 'method': values[f] = call.method; break;
      case 'url': values[f] = row.url; break;
      case 'originalUrl': values[f] = call.original_url; break;
      case 'status': values[f] = row.status; break;
      case 'duration': values[f] = call.duration_ms ?? null; break;
      case 'time': values[f] = call.timestamp; break;
      case 'state': values[f] = call.state ?? null; break;
      case 'error': values[f] = call.error ?? null; break;
      case 'project': values[f] = call.service_name ?? null; break;
      case 'supplier':
        // An inbound call has no supplier: its URL host is the app Alfred forwarded it to (e.g. host.docker.internal).
        if (call.source === 'internal') values['appHost'] = supplierOf(call);
        else values[f] = call.supplierName ?? supplierOf(call);
        break;
      case 'parentCallId': values[f] = call.parentCallId ?? null; break;
      case 'requestHeaders': values[f] = call.request?.headers ?? {}; break;
      case 'responseHeaders': values[f] = call.response?.headers ?? {}; break;
      case 'requestBody': values[f] = bodyView(call.request?.body, call.request?.headers, bodyOffset, bodyLength); break;
      case 'responseBody': values[f] = bodyView(call.response?.body, call.response?.headers, bodyOffset, bodyLength); break;
      case 'timing': values[f] = call.timing ?? null; break;
      case 'children': case 'comments': case 'db':
        if (extras[f] === undefined) missing.push(f); else values[f] = extras[f];
        break;
    }
  }
  for (const p of paths ?? []) {
    const hit = lookupPath(call, p);
    if (!hit.found) {
      missing.push(p);
    } else if (typeof hit.value === 'string' && hit.value.length > bodyLength) {
      values[p] = chunkText(hit.value, bodyOffset, bodyLength);
    } else {
      values[p] = hit.value;
    }
  }
  return { values, missing };
}
