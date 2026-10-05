import { CallRecord } from '../../core/models/call.model';
import { CapturedStatement, DbFlag, TypedValue } from '../../core/models/db-capture.model';
import { stmt } from './db-capture.fixtures.spec-helper';
import { buildOverview, timelineSuppliers } from './db-findings';
import { analyzeCapture } from './db-analysis';

const v = (value: string): TypedValue => ({ type: 'BIGINT', value });

function at(seq: number, atMs: number, ms: number, sql = `SELECT a FROM t${seq} WHERE id = ?`, param = String(seq), extra: Partial<CapturedStatement> = {}): CapturedStatement {
  return stmt(seq, 'SELECT', sql, { offsetMicros: atMs * 1000, durationMicros: ms * 1000, params: [[v(param)]], fingerprint: sql, table: `t${seq}`, ...extra });
}

const call = { timestamp: '2026-10-05T00:00:00.000Z', duration_ms: 10_000, response: { status: 200 } } as unknown as CallRecord;

function supplier(seq: number, atMs: number, ms: number, status = 200, host = 'ndc'): CallRecord {
  return { id: `c${seq}`, url: `https://${host}.example.com/search`, method: 'POST', timestamp: new Date(Date.parse(call.timestamp) + atMs).toISOString(),
    duration_ms: ms, response: { status }, parentCallId: 'in', parentSeq: seq } as unknown as CallRecord;
}

describe('db-findings', () => {
  it('builds the one summary line: total, the biggest share and the idle stretches', () => {
    // busy 0-100, 3000-3100; idle 100-3000 (2.9 s) and 3100-10000 (6.9 s, the end)
    const o = buildOverview(call, [at(1, 0, 100), at(2, 3000, 100)], [], new Map(), []);
    expect(o.appPct).toBe(98);
    expect(o.idle.map((g) => [g.ms, g.beforeSeq])).toEqual([[2900, 2], [6900, null]]);
    expect(o.summary).toBe('10.0 s · 98% inside the app - 2 idle stretches, the longest 6.9 s at the end');
    expect(o.findings[0].source).toBe('IDLE');
    expect(o.toFix).toBe(1);
  });

  it('stacks overlapping supplier calls on rows of their own', () => {
    const s = timelineSuppliers(call, [], new Map([[3, supplier(3, 100, 5000)], [4, supplier(4, 200, 2000)], [5, supplier(5, 6000, 100)]]));
    expect(s.map((c) => [c.seq, c.row])).toEqual([[3, 0], [4, 1], [5, 0]]);
    expect(s[0].host).toBe('ndc');
  });

  it('turns the backend flags into findings - errors first, then warnings by what they cost, then notes', () => {
    const statements = [
      at(1, 0, 40),
      at(2, 50, 300, 'SELECT * FROM tags WHERE x = ?', '1', { outcome: { kind: 'ROWS', rowsRead: 2 }, origin: { id: 'q1', kind: 'HQL', text: 'from Tag t' } }),
      at(3, 400, 100, 'SELECT * FROM tag_country WHERE tag_id = ?', '812', { origin: { id: 'q1', kind: 'HQL' } }),
      at(4, 520, 100, 'SELECT * FROM tag_country WHERE tag_id = ?', '843', { origin: { id: 'q1', kind: 'HQL' } }),
      at(5, 700, 10, 'SELECT a FROM t1 WHERE id = ?', '1'),
      stmt(6, 'INSERT', 'INSERT INTO log VALUES (?)', { offsetMicros: 800_000, durationMicros: 5000, txId: 'tx', outcome: { kind: 'FAILED', message: 'ORA-06550: procedure missing' } }),
      stmt(7, 'ROLLBACK', 'ROLLBACK', { offsetMicros: 810_000, durationMicros: 1000, txId: 'tx', outcome: { kind: 'TX_END' } }),
    ];
    const flags: DbFlag[] = [
      { type: 'FAILED_SWALLOWED', severity: 'BAD', seqs: [6], detail: { error: 'ORA-06550' } },
      { type: 'QUERY_FAN_OUT', severity: 'WARN', seqs: [2, 3, 4], group: 'q1', detail: { rows: '2', perRow: '1', extraMs: '200', tables: 'tag_country', query: 'from Tag t' } },
      { type: 'DUPLICATE', severity: 'WARN', seqs: [1, 5], group: 'SELECT a FROM t1 WHERE id = ?', detail: { duplicates: '1' } },
    ];
    const o = buildOverview({ ...call, duration_ms: 1000 }, statements, [], new Map(), flags);
    expect(o.findings.map((f) => f.source)).toEqual(['FAILED_SWALLOWED', 'QUERY_FAN_OUT', 'DUPLICATE']);
    const [error, fan, dup] = o.findings;
    expect(error.seqs).toEqual([6, 7]);
    expect(error.short).toBe('#6 failed, rolled back, the call still answered 200');
    expect(fan.title).toBe('1 HQL query → 3 SQL statements');
    expect(fan.short).toBe('its 2 rows loaded a query each, one by one');
    expect(fan.chips.map((c) => c.n)).toEqual(['#2', '#3', '#4']);
    expect(fan.impact).toBe('+200 ms');
    expect(fan.fingerprints).toEqual(['SELECT * FROM tags WHERE x = ?']);
    expect(dup.title).toBe('1 query run twice');
    expect(dup.chips[0].n).toBe('#1 → #5');
    expect(o.kinds.get(2)).toBe('fan');
    expect(o.kinds.get(5)).toBe('rep');
    expect(o.kinds.get(6)).toBe('err');
    expect(o.kinds.get(7)).toBe('tx');
    expect([o.errors, o.toFix]).toEqual([1, 2]);
  });

  it('names a failing supplier as an error and a slow one as a note', () => {
    const suppliers = new Map([[2, supplier(2, 100, 6000, 500, 'pay')], [3, supplier(3, 100, 5000, 200, 'ndc')]]);
    const o = buildOverview(call, [at(1, 0, 50), at(4, 6200, 50)], [], suppliers, []);
    const sources = o.findings.map((f) => `${f.severity}:${f.source}:${f.id}`);
    expect(sources[0]).toBe('bad:SUPPLIER_FAILED:supplier-failed-pay');
    expect(sources).toContain('note:SUPPLIER_TIME:supplier-time-ndc');
    expect(o.findings.find((f) => f.id === 'supplier-time-ndc')!.short).toBe('1 call, OK');
  });

  it('rides along in the analysis every export writes - the summary line and the findings without their chips', () => {
    const a = analyzeCapture(call, { statements: [at(1, 0, 100), at(2, 3000, 100)], transactions: [] }, new Map());
    expect(a.summary).toBe('10.0 s · 98% inside the app - 2 idle stretches, the longest 6.9 s at the end');
    expect(a.findings!.map((f) => [f.severity, f.source, f.impactMs])).toEqual([['warn', 'IDLE', 9800]]);
    expect(a.findings![0].seqs).toEqual([2]);
    expect(Object.keys(a.findings![0])).not.toContain('chips');
  });

  it('says nothing for a quick, clean call', () => {
    const o = buildOverview({ ...call, duration_ms: 200 }, [at(1, 0, 20), at(2, 30, 20)], [], new Map(), []);
    expect(o.findings).toEqual([]);
    expect(o.summary).toContain('DB 40 ms');
  });
});
