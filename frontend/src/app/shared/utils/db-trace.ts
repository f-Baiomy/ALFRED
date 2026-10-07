import { CapturedStatement, TraceHit } from '../../core/models/db-capture.model';
import type { DbDetailTab } from '../../components/db-capture/db-window-state';

/**
 * Value tracing (mock: "Tracing CHG-88213 · found in 4 places, in order: supplier #17 response → #19 payments ·
 * param ?4 → ..."): the server's hits in the call's statements and rows, plus hits in its supplier calls' bodies,
 * as one ordered list of places to jump to.
 */
export interface DbTraceLocation {
  readonly seq: number;
  readonly text: string;
  readonly tab?: DbDetailTab;
}

export function traceLocations(hits: readonly TraceHit[], statements: readonly CapturedStatement[]): DbTraceLocation[] {
  const bySeq = new Map(statements.map((s) => [s.seq, s]));
  const seen = new Set<string>();
  const out: DbTraceLocation[] = [];
  for (const h of hits) {
    const s = bySeq.get(h.seq);
    const table = s?.table ? ` ${s.table}` : '';
    let location: DbTraceLocation;
    switch (h.where) {
      case 'PARAM':
        location = { seq: h.seq, tab: 'params', text: `#${h.seq}${table} · param ?${h.index + 1}` };
        break;
      case 'OUT':
        location = { seq: h.seq, tab: 'params', text: `#${h.seq}${table} · OUT ?${h.index + 1}` };
        break;
      case 'KEY':
        location = { seq: h.seq, tab: 'keys', text: `#${h.seq}${table} · generated key` };
        break;
      case 'BEFORE_IMAGE':
        location = { seq: h.seq, tab: 'deleted', text: `#${h.seq}${table} · row before the ${s?.kind?.toLowerCase() ?? 'write'}` };
        break;
      // a Redis command (specs/011-redis-capture): its key, an argument, its reply or the value it replaced
      case 'REDIS_KEY':
        location = { seq: h.seq, text: `#${h.seq} Redis · key ${h.column ?? ''}`.trim() };
        break;
      case 'REDIS_ARG':
        location = { seq: h.seq, text: `#${h.seq} Redis · argument ${h.index}${h.column ? ' ' + h.column : ''}` };
        break;
      case 'REDIS_REPLY':
        location = { seq: h.seq, text: `#${h.seq} Redis · reply${h.column ? ' ' + h.column : ''}` };
        break;
      case 'REDIS_BEFORE':
        location = { seq: h.seq, text: `#${h.seq} Redis · value before the write` };
        break;
      default:
        location = { seq: h.seq, tab: 'rows', text: `#${h.seq}${table} · rows` };
    }
    // One chip per place: several matching cells of one result are one place to look.
    const key = `${location.seq}:${location.tab}:${h.where === 'PARAM' ? h.index : ''}`;
    if (!seen.has(key)) {
      seen.add(key);
      out.push(location);
    }
  }
  return out;
}

export function supplierBodyHits(
  bodies: readonly { readonly seq: number; readonly request: string; readonly response: string }[],
  value: string,
): DbTraceLocation[] {
  const out: DbTraceLocation[] = [];
  for (const b of bodies) {
    if (b.request.includes(value)) out.push({ seq: b.seq, text: `supplier #${b.seq} request` });
    if (b.response.includes(value)) out.push({ seq: b.seq, text: `supplier #${b.seq} response` });
  }
  return out;
}
