import { CallRecord } from '../../core/models/call.model';
import { CapturedStatement, TypedValue } from '../../core/models/db-capture.model';
import { stmt } from './db-capture.fixtures.spec-helper';
import { indexHint, queryTotals, roundTripMs, suppliersOf, timeBreakdown } from './db-analysis';

const v = (value: string): TypedValue => ({ type: 'BIGINT', value });

/** A statement at `atMs` into the call, running `ms`. */
function at(seq: number, atMs: number, ms: number, sql = `SELECT a FROM t${seq} WHERE id = ?`, param = String(seq), extra: Partial<CapturedStatement> = {}): CapturedStatement {
  return stmt(seq, 'SELECT', sql, { offsetMicros: atMs * 1000, durationMicros: ms * 1000, params: [[v(param)]], fingerprint: sql, ...extra });
}

describe('db-analysis', () => {
  it('splits a call into database, supplier calls, gaps between statements and before/after', () => {
    const call = { timestamp: '2026-10-05T00:00:00.000Z', duration_ms: 1000 };
    const statements = [at(1, 100, 50), at(2, 300, 50, undefined, undefined, { codeLocation: 'Svc.next(Svc.java:9)' }), at(4, 800, 100)];
    const supplier = { id: 'out', timestamp: '2026-10-05T00:00:00.400Z', duration_ms: 200, parentCallId: 'in', parentSeq: 3 } as CallRecord;
    const t = timeBreakdown(call, statements, [{ seq: 3, method: 'POST', url: 'https://x' }], new Map([[3, supplier]]), 2);
    expect([t.dbMs, t.outboundMs]).toEqual([200, 200]);
    // busy 100-150, 300-350, 400-600, 800-900: gaps 150 + 50 + 200 = 400 between; 100 before + 100 after = 200 edge
    expect([t.gapMs, t.edgeMs]).toEqual([400, 200]);
    expect(t.gaps).toEqual({ count: 3, medianMs: 150, maxMs: 200 });
    expect(t.topGaps[0]).toEqual({ ms: 200, afterSeq: 3, beforeSeq: 4, callers: [] });
    expect(t.topGaps[1]).toEqual(jasmine.objectContaining({ ms: 150, afterSeq: 1, beforeSeq: 2, callers: ['Svc.next(Svc.java:9)'] }));
    expect(t.appTimeDominant).toBeTrue(); // 600 of 1000 ms neither DB nor supplier
    expect(t.transactions).toBe(2);
  });

  it('measures the round trip like the backend does: 10th percentile of 5+ successful SELECTs', () => {
    expect(roundTripMs([at(1, 0, 55), at(2, 0, 56), at(3, 0, 3449), at(4, 0, 57), at(5, 0, 58)])).toBe(55);
    expect(roundTripMs([at(1, 0, 55), at(2, 0, 56)])).toBe(0);
  });

  it('totals each query: runs, distinct params, exact duplicates, time, rows and where it ran from - costliest first', () => {
    const sql = 'SELECT v FROM credential_values WHERE credential_id = ?';
    const statements = [
      at(1, 0, 10, sql, '394', { codeLocation: 'Org.cred(Org.java:452)', outcome: { kind: 'ROWS', rowsRead: 4 } }),
      at(2, 0, 10, sql, '394', { codeLocation: 'Org.cred(Org.java:452)', outcome: { kind: 'ROWS', rowsRead: 4 } }),
      at(3, 0, 10, sql, '395', { codeLocation: 'Agency.set(Agency.java:126)', outcome: { kind: 'ROWS', rowsRead: 1 } }),
      at(4, 0, 100, 'SELECT * FROM organization WHERE branch_id = ?', '948'),
    ];
    const [slowest, cred] = queryTotals(statements);
    expect(slowest.table ?? slowest.sql).toContain('organization');
    expect(cred).toEqual(jasmine.objectContaining({ count: 3, distinctParams: 2, duplicates: 1, totalMs: 30, rows: 9, seqs: [1, 2, 3] }));
    expect(cred.callers).toEqual(['Org.cred(Org.java:452)', 'Agency.set(Agency.java:126)']);
  });

  it('prefers the agent\'s call chain over the single code location', () => {
    const s = at(1, 0, 10, undefined, undefined, { codeLocation: 'GenericDAOImpl.fetch(GenericDAOImpl.java:425)', callers: ['OrgService.get(OrgService.java:452)', 'Agency.set(Agency.java:126)'] });
    expect(queryTotals([s])[0].callers).toEqual(['OrgService.get(OrgService.java:452)']);
  });

  it('finds a call\'s supplier calls among the exported calls by their parent link', () => {
    const calls = [{ id: 'a', parentCallId: 'in', parentSeq: 5 }, { id: 'b', parentCallId: 'other', parentSeq: 1 }, { id: 'c' }] as CallRecord[];
    expect([...suppliersOf('in', calls).keys()]).toEqual([5]);
  });

  it('sums the connection and transaction overhead the agent timed', () => {
    const call = { timestamp: '2026-10-05T00:00:00.000Z', duration_ms: 1000 };
    const statements = [
      at(1, 0, 10, undefined, undefined, { outcome: { kind: 'ROWS', rowsRead: 1, acquireMicros: 54_000 } }),
      stmt(2, 'COMMIT', 'COMMIT', { outcome: { kind: 'TX_END', txResult: 'COMMITTED', via: 'JTA', beginMicros: 1_000, commitMicros: 56_000, closeMicros: 200 } }),
    ];
    const t = timeBreakdown(call, statements, [], new Map(), 1);
    expect(t.overheadMs).toBe(111.2);
    expect(t.checkouts).toBe(1);
  });

  it('says when no index starts with a column the statement filters by', () => {
    const hint = indexHint('SELECT * FROM tt_organization WHERE branch_id = ? AND status = ?', [
      { name: 'PK', unique: true, columns: ['ORGANIZATION_ID'] }, { name: 'IX_STATUS', unique: false, columns: ['STATUS', 'NAME'] }]);
    expect(hint.filterColumns).toEqual(['branch_id', 'status']);
    expect(hint.unindexed).toEqual(['branch_id']);
  });
});
