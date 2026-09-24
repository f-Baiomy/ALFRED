import { CallRecord } from '../../core/models/call.model';
import { supplierOf } from './call-utils';

/**
 * The answer picker's search box, as fields. `GET /calls` and `GET /internal-calls` take one
 * substring `search` (over method, URLs, status, headers and bodies) and nothing finer, so a typed
 * `method:` / `status:` / `host:` / `path:` is applied here, on the page the server returned - see
 * toServerSearch for which part of the text the server still gets. The box is always the truth:
 * chips edit its text through toggleToken rather than keeping a second state beside it.
 */
export interface AnswerQuery {
  /** Plain words and anything typed as `key:value` for a key this does not know. */
  readonly free: string;
  /** Substring of the hostname, or a leading `*.` suffix - the same shape a rule's host takes. */
  readonly host: string | null;
  /** Substring of the path and query, case-insensitive. */
  readonly path: string | null;
  /** Upper-case, any of. */
  readonly methods: readonly string[];
  /** `2xx`..`5xx`, an exact code such as `404`, or `failed` (no response at all) - any of. */
  readonly statuses: readonly string[];
  /** Text in a header or body. Summary rows carry neither, so only the server can check this. */
  readonly body: string | null;
}

export const EMPTY_ANSWER_QUERY: AnswerQuery = { free: '', host: null, path: null, methods: [], statuses: [], body: null };

export type AnswerListField = 'methods' | 'statuses';

const TOKEN = /(\w+):"([^"]*)"|(\w+):(\S+)|"([^"]*)"|(\S+)/g;
const STATUS = /^([1-5]xx|[1-5]\d\d|failed)$/;

export function parseAnswerQuery(text: string): AnswerQuery {
  const free: string[] = [];
  const methods: string[] = [];
  const statuses: string[] = [];
  let host: string | null = null;
  let path: string | null = null;
  let body: string | null = null;

  for (const m of text.matchAll(TOKEN)) {
    const key = (m[1] ?? m[3])?.toLowerCase();
    const value = m[2] ?? m[4];
    if (key === undefined || value === undefined) {
      free.push(m[5] ?? m[6]);
      continue;
    }
    const raw = m[0];
    switch (key) {
      case 'host':
        host = value;
        break;
      case 'path':
      case 'url':
        path = value;
        break;
      case 'body':
        body = value;
        break;
      case 'method':
        for (const part of splitList(value)) addOnce(methods, part.toUpperCase());
        break;
      case 'status': {
        const parts = splitList(value).map((p) => p.toLowerCase());
        if (parts.length === 0 || !parts.every((p) => STATUS.test(p))) {
          free.push(raw);
        } else {
          for (const part of parts) addOnce(statuses, part);
        }
        break;
      }
      default:
        free.push(raw);
    }
  }
  return { free: free.join(' '), host, path, methods, statuses, body };
}

/** The inverse of parseAnswerQuery, in one fixed order - free text first, then the fields. */
export function formatAnswerQuery(query: AnswerQuery): string {
  const parts: string[] = [];
  if (query.free) parts.push(query.free);
  if (query.host) parts.push(`host:${quote(query.host)}`);
  if (query.path) parts.push(`path:${quote(query.path)}`);
  if (query.methods.length) parts.push(`method:${query.methods.join(',')}`);
  if (query.statuses.length) parts.push(`status:${query.statuses.join(',')}`);
  if (query.body) parts.push(`body:${quote(query.body)}`);
  return parts.join(' ');
}

/** A chip click: flips one value of a list field in the typed text. */
export function toggleToken(text: string, field: AnswerListField, value: string): string {
  const query = parseAnswerQuery(text);
  const current = query[field];
  const next = current.includes(value) ? current.filter((v) => v !== value) : [...current, value];
  return formatAnswerQuery({ ...query, [field]: next });
}

/**
 * The one substring the server gets. Body text first, because nothing else can check it; then free
 * text, which the server also matches against headers and bodies; then path, then host, since a
 * URL contains both and narrowing server-side means fewer pages to scan here.
 */
export function toServerSearch(query: AnswerQuery): string {
  return query.body || query.free || query.path || query.host || '';
}

/** Whether anything is left to check here once the server has answered - drives page size and the count's wording. */
export function hasClientFilters(query: AnswerQuery, windowMinutes: number | null): boolean {
  return (
    windowMinutes !== null ||
    query.host !== null ||
    query.path !== null ||
    query.methods.length > 0 ||
    query.statuses.length > 0 ||
    (query.body !== null && query.free !== '')
  );
}

export function matchesAnswerFilters(call: CallRecord, query: AnswerQuery, windowMinutes: number | null, now: number): boolean {
  if (query.host && !hostMatches(query.host, supplierOf(call))) return false;
  if (query.path && !pathAndQuery(call.url).toLowerCase().includes(query.path.toLowerCase())) return false;
  if (query.methods.length && !query.methods.includes((call.method || '').toUpperCase())) return false;
  if (query.statuses.length && !query.statuses.some((s) => statusMatches(s, call))) return false;
  // Free text only goes unchecked by the server when body text took the server's one search.
  if (query.body && query.free && !`${call.method} ${call.url}`.toLowerCase().includes(query.free.toLowerCase())) return false;
  if (windowMinutes !== null) {
    const at = Date.parse(call.timestamp);
    if (!Number.isFinite(at) || now - at > windowMinutes * 60_000) return false;
  }
  return true;
}

function hostMatches(pattern: string, host: string): boolean {
  const p = pattern.toLowerCase();
  const h = host.toLowerCase();
  return p.startsWith('*.') ? h.endsWith(p.slice(1)) : h.includes(p);
}

function statusMatches(filter: string, call: CallRecord): boolean {
  const status = call.response?.status;
  if (filter === 'failed') return status == null;
  if (status == null) return false;
  if (filter.endsWith('xx')) return Math.floor(status / 100) === Number(filter[0]);
  return status === Number(filter);
}

function pathAndQuery(url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.pathname + parsed.search;
  } catch {
    return url;
  }
}

function splitList(value: string): string[] {
  return value.split(',').map((v) => v.trim()).filter(Boolean);
}

function addOnce(list: string[], value: string): void {
  if (!list.includes(value)) list.push(value);
}

function quote(value: string): string {
  return /\s/.test(value) ? `"${value}"` : value;
}
