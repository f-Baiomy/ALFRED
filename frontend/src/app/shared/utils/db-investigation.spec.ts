import { DbFlag } from '../../core/models/db-capture.model';
import { stmt } from './db-capture.fixtures.spec-helper';
import { flagTarget, flagText } from './db-flags';
import { rowQueryExamples, statementQueryExamples } from './db-row-query-examples';
import { supplierBodyHits, traceLocations } from './db-trace';

describe('database window investigation helpers', () => {
  it('sends each flag to the right place', () => {
    const flag = (type: DbFlag['type'], extra: Partial<DbFlag> = {}): DbFlag => ({ type, severity: 'WARN', seqs: [7], ...extra });
    expect(flagTarget(flag('NO_WHERE'))).toEqual({ seq: 7, tab: 'deleted' });
    expect(flagTarget(flag('FAILED_SWALLOWED'))).toEqual({ seq: 7, tab: 'error' });
    expect(flagTarget(flag('HUGE_RESULT'))).toEqual({ seq: 7, tab: 'rows' });
    expect(flagTarget(flag('ROLLED_BACK', { group: 'tx-9' }))).toEqual({ seq: 7, groupTxId: 'tx-9' });
    expect(flagTarget(flag('SLOW'))).toEqual({ seq: 7, tab: undefined });
    expect(flagText(flag('REPEATED_QUERY', { detail: { table: 'fare_rules', count: '12', cacheable: 'false' } }))).toBe('N+1 · fare_rules ×12');
    expect(flagText(flag('NO_WHERE', { detail: { verb: 'DELETE', table: 'rate_cache', rows: '212' } }))).toBe('DELETE without WHERE · rate_cache · 212 rows');
  });

  it('turns trace hits into ordered places, one chip per place', () => {
    const statements = [stmt(3, 'INSERT', 'INSERT INTO payments VALUES (?)', { table: 'payments' }), stmt(5, 'SELECT', 'SELECT 1', { table: 'payments' })];
    const places = traceLocations([
      { seq: 3, where: 'PARAM', index: 3 },
      { seq: 5, where: 'ROW', index: 0, column: '1' },
      { seq: 5, where: 'ROW', index: 4, column: '1' },
    ], statements);
    expect(places.map((p) => p.text)).toEqual(['#3 payments · param ?4', '#5 payments · rows']);
    expect(places[1].tab).toBe('rows');
    expect(supplierBodyHits([{ seq: 4, request: '{"amount":1}', response: '{"chargeId":"CHG-88213"}' }], 'CHG-88213'))
      .toEqual([{ seq: 4, text: 'supplier #4 response' }]);
  });

  it('builds runnable examples from the result itself', () => {
    const examples = rowQueryExamples(['id', 'amount', 'kind'], [['1', '120.00', 'PAY'], ['2', '5.00', 'TOPUP']]);
    expect(examples.map((e) => e.label)).toEqual(["kind = 'PAY'", 'amount > 500', 'count by kind', 'top 10 amount']);
    expect(examples[2].sql).toBe('SELECT kind, COUNT(*), SUM(amount) FROM result GROUP BY kind ORDER BY COUNT(*) DESC');
    expect(rowQueryExamples(['weird name'], [["O'Brien"]])[0].sql).toBe(`SELECT * FROM result WHERE "weird name" = 'O''Brien'`);
    expect(statementQueryExamples('wallet', 'tx-7', 'Ledger').map((e) => e.label))
      .toEqual(['slowest', 'writes to wallet', 'time per table', 'failed or rolled back', 'deletes', 'inside tx-7', 'from Ledger code']);
  });
});
