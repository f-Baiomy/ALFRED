/**
 * The board-drawn data blocks (specs/017 R18-R20): ```calls```, ```statement```, ```call-logs``` and ```compare```.
 * Their text is a few `key: value` lines (or call mentions) - what Claude writes and reads - and the board draws them
 * from Alfred's live data, so a number in a comment never goes stale.
 */
import { parseMentions } from './mention-syntax';

/** `key: value` lines; `#` starts a comment; keys are lower case. */
export function queryFields(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = /^([A-Za-z][\w-]*)\s*:\s*(.*)$/.exec(line);
    if (m) out[m[1].toLowerCase()] = m[2].trim();
  }
  return out;
}

/** Every call this text names - a mention `@[call:in:x|…]`, or a bare `in:x` / `out:x@cycle` on its own. */
export function callRefsIn(text: string): string[] {
  const refs: string[] = [];
  for (const m of parseMentions(text)) if ('mention' in m && m.mention.type.toUpperCase() === 'CALL') refs.push(m.mention.ref);
  if (!refs.length) {
    for (const m of text.matchAll(/(?:^|[\s:])((?:in|out):[A-Za-z0-9._-]+(?:@[A-Za-z0-9._-]+)?)/g)) refs.push(m[1]);
  }
  return [...new Set(refs)];
}

export type CallField = 'at' | 'status' | 'durationMs' | 'statements' | 'writes' | 'failedStatements' | 'dbMs' | 'errors' | 'warnings'
  | 'endpoint' | 'project' | 'signal';

export const CALL_FIELDS: Readonly<Record<CallField, string>> = {
  at: 'When', status: 'Status', durationMs: 'ms', statements: 'SQL', writes: 'Writes', failedStatements: 'Failed SQL', dbMs: 'DB ms',
  errors: 'Errors', warnings: 'Warnings', endpoint: 'Endpoint', project: 'Project', signal: 'Signal',
};

const ALIASES: Readonly<Record<string, CallField>> = {
  time: 'at', when: 'at', ms: 'durationMs', duration: 'durationMs', sql: 'statements', db: 'dbMs', dbms: 'dbMs', error: 'errors',
  warn: 'warnings', failed: 'failedStatements',
};

export function callField(name: string): CallField | null {
  const n = name.trim();
  if (n in CALL_FIELDS) return n as CallField;
  return ALIASES[n.toLowerCase()] ?? null;
}

export interface ShowSpec {
  readonly kind: 'table' | 'chart';
  readonly fields: readonly CallField[];
  readonly chart: 'line' | 'bar' | 'area';
  readonly error: string | null;
}

export const DEFAULT_COLUMNS: readonly CallField[] = ['at', 'status', 'durationMs', 'statements', 'dbMs', 'errors'];

/** `show: table(status, ms, sql)` · `show: chart(ms)` · `show: chart(ms, bar)` - the default is the table. */
export function parseShow(v: string | undefined): ShowSpec {
  const m = /^\s*(table|chart)\s*(?:\(([^)]*)\))?\s*$/i.exec(v ?? 'table');
  if (!m) return { kind: 'table', fields: DEFAULT_COLUMNS, chart: 'line', error: `show is table(fields…) or chart(field) - not "${v}"` };
  const kind = m[1].toLowerCase() as 'table' | 'chart';
  const parts = (m[2] ?? '').split(',').map((x) => x.trim()).filter(Boolean);
  const chart = (parts.find((p) => /^(line|bar|area)$/i.test(p))?.toLowerCase() ?? 'line') as ShowSpec['chart'];
  const names = parts.filter((p) => !/^(line|bar|area)$/i.test(p));
  const fields: CallField[] = [];
  for (const n of names) {
    const f = callField(n);
    if (!f) return { kind, fields: DEFAULT_COLUMNS, chart, error: `"${n}" is not a call field - use ${Object.keys(CALL_FIELDS).join(', ')}` };
    fields.push(f);
  }
  if (kind === 'chart') return { kind, fields: fields.length ? fields.slice(0, 3) : ['durationMs'], chart, error: null };
  return { kind, fields: fields.length ? fields : DEFAULT_COLUMNS, chart, error: null };
}

/** The value at the given share (0..1) of sorted numbers - median is 0.5. Null for none. */
export function percentile(values: readonly number[], share: number): number | null {
  const v = values.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  const i = Math.min(v.length - 1, Math.max(0, Math.ceil(share * v.length) - 1));
  return v[i];
}

/** A chart spec (the ```chart``` JSON) of fields over time, oldest first. */
export function rowsChart(rows: readonly Record<string, unknown>[], show: ShowSpec, title: string): string {
  const ordered = [...rows].reverse();
  const colors = ['purple', 'green', 'amber'];
  return JSON.stringify({
    type: show.chart, title,
    labels: ordered.map((r) => (typeof r['at'] === 'string' ? new Date(r['at'] as string).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '')),
    series: show.fields.map((f, i) => ({ name: CALL_FIELDS[f], values: ordered.map((r) => Number(r[f]) || 0), color: colors[i % 3] })),
    unit: show.fields.length === 1 && (show.fields[0] === 'durationMs' || show.fields[0] === 'dbMs') ? 'ms' : '',
  });
}
