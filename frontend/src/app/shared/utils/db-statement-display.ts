import { CapturedStatement, DbFlag, NOT_READ_TYPE, TypedValue } from '../../core/models/db-capture.model';

/** How one captured statement reads in the window and in exports: its verb badge, its result line, its time. */

export function isTxEnd(s: CapturedStatement): boolean {
  return s.outcome.kind === 'TX_END' || s.kind === 'COMMIT' || s.kind === 'ROLLBACK';
}

export function isFailed(s: CapturedStatement): boolean {
  return s.outcome.kind === 'FAILED';
}

export function isDelete(s: CapturedStatement): boolean {
  return s.kind === 'DELETE';
}

export function isWrite(s: CapturedStatement): boolean {
  return s.kind === 'INSERT' || s.kind === 'UPDATE' || s.kind === 'DELETE' || s.kind === 'MERGE' || s.kind === 'DDL';
}

export function isRead(s: CapturedStatement): boolean {
  return !isWrite(s) && !isTxEnd(s);
}

export function isBatch(s: CapturedStatement): boolean {
  return s.params.length > 1;
}

export function verbOf(s: CapturedStatement): string {
  if (isFailed(s)) return 'FAILED';
  if (s.kind === 'ROLLBACK_TO_SAVEPOINT') return 'ROLLBACK TO';
  const base = s.kind === 'OTHER' ? (s.sql.trim().match(/^\{?\s*(\w+)/)?.[1] ?? 'SQL').toUpperCase() : s.kind;
  return base + (/\bFOR\s+UPDATE\b/i.test(s.sql) ? ' ⋯' : '');
}

export function verbClass(s: CapturedStatement): string {
  if (isFailed(s)) return 'v-fail';
  if (s.kind === 'ROLLBACK' || s.kind === 'ROLLBACK_TO_SAVEPOINT') return 'v-fail';
  if (isTxEnd(s) || s.kind === 'SAVEPOINT') return 'v-tx';
  if (s.kind === 'DELETE') return 'v-del';
  if (s.kind === 'CALL') return 'v-call';
  if (isWrite(s)) return 'v-write';
  return 'v-read';
}

const PAST: Record<string, string> = { INSERT: 'inserted', UPDATE: 'updated', DELETE: 'deleted', MERGE: 'merged', DDL: 'changed' };

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n.toLocaleString()} ${n === 1 ? one : many}`;
}

/** A short error label: the vendor code in the message (ORA-00001) or the SQLState. */
export function errorLabel(s: CapturedStatement): string {
  const o = s.outcome;
  const vendor = o.message?.match(/\b([A-Z]{2,4}-\d{3,5})\b/)?.[1];
  return vendor ?? o.sqlState ?? (o.vendorCode != null ? String(o.vendorCode) : 'error');
}

/** The result column: "1 row", "3 deleted", "1 inserted · key 99817", "OUT fee = 1.80", "ORA-00001", "committed". */
export function resultText(s: CapturedStatement): string {
  const o = s.outcome;
  let text: string;
  switch (o.kind) {
    case 'FAILED':
      text = errorLabel(s);
      break;
    case 'TX_END':
      text = o.txResult === 'ROLLED_BACK' ? 'rolled back' : 'committed';
      break;
    case 'PROCEDURE': {
      const outs = (o.outParams ?? []).filter((v) => v.value != null);
      text = outs.length ? `OUT ${outs.map((v) => v.value).join(', ')}` : 'called';
      if (o.rowsRead != null) text += ` · ${plural(o.rowsRead, 'row')}`;
      break;
    }
    case 'ROWS':
      text = plural(o.rowsRead ?? 0, 'row');
      if (o.partial) text += ' · stopped early';
      break;
    default: {
      const verb = PAST[s.kind] ?? 'affected';
      text = `${(o.affected ?? 0).toLocaleString()} ${verb}`;
      if (isBatch(s)) text += ` · batch of ${s.params.length}`;
      const key = o.generatedKeys?.[0]?.[0]?.value;
      if (key != null) text += ` · key ${key}`;
    }
  }
  if (s.undone && o.kind !== 'TX_END') text += ' · rolled back';
  return text;
}

/** How many rows a statement touched or returned. */
export function rowCountOf(s: CapturedStatement): number {
  const o = s.outcome;
  return o.kind === 'ROWS' || o.kind === 'PROCEDURE' ? o.rowsRead ?? 0 : o.affected ?? 0;
}

export function msText(micros: number): string {
  const ms = micros / 1000;
  return ms >= 100 ? `${ms.toFixed(0)} ms` : `${ms.toFixed(1)} ms`;
}

/** A cell or parameter as text. A column the application never read says so instead of looking like NULL. */
export function valueText(v: TypedValue | null | undefined): string {
  if (!v) return '';
  if (v.type === NOT_READ_TYPE) return '(not read by the app)';
  if (v.value == null) return 'NULL';
  return v.value;
}

/** "WalletRepository.debit(WalletRepository.java:112)" -> file and line, for the IDE links. */
export function codeFileLine(location: string | null | undefined): { readonly file: string; readonly line: number } | null {
  const m = location?.match(/\(([^():]+):(\d+)\)\s*$/);
  return m ? { file: m[1], line: Number(m[2]) } : null;
}

export function flagText(flag: DbFlag): string {
  const d = flag.detail ?? {};
  const at = (k: string) => (d[k] ? ` · ${d[k]}` : '');
  switch (flag.type) {
    case 'NO_WHERE': return `${d['verb'] ?? 'DELETE'} without WHERE${at('table')}${d['rows'] ? ` · ${d['rows']} rows` : ''}`;
    case 'FAILED_SWALLOWED': return `Failed and swallowed${at('error')}${d['status'] ? ` · call still returned ${d['status']}` : ''}`;
    case 'FAILED': return `Failed${at('error')}`;
    case 'ROLLED_BACK': return `Rolled back${at('tx')}`;
    case 'LOCK_DURING_SUPPLIER_CALL': return `Row lock held during supplier call${at('tx')}${d['ms'] ? ` · ${d['ms']} ms` : ''}`;
    case 'CASCADE': return `Cascade${d['table'] ? ` · ${d['table']} → ${d['children'] ?? 'children'}` : ''} not visible`;
    case 'BEFORE_NOT_CAPTURED': return `Not captured${d['count'] ? ` · ${d['count']} writes have no before-image` : ' · no before-image'}`;
    case 'REPEATED_QUERY': return `${d['cacheable'] === 'true' ? 'Cacheable' : 'N+1'}${at('table')}${d['count'] ? ` ×${d['count']}` : ''}`;
    case 'SLOW': return `Slow${d['ms'] ? ` · ${d['ms']} ms` : ''}${at('table')}`;
    case 'HUGE_RESULT': return `Huge result${d['rows'] ? ` · ${d['rows']} rows` : ''}`;
    case 'LARGE_DELETE': return `Large delete${at('table')}${d['rows'] ? ` · ${d['rows']} rows` : ''}`;
    default: return flag.type;
  }
}
