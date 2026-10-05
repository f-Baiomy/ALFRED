import { CallRecord } from '../../core/models/call.model';
import { CallDbCapture, ExportedDbStatement, StatementOrigin, TypedValue } from '../../core/models/db-capture.model';
import { Redaction } from '../../core/models/redaction.model';
import { buildBulkExportPayload } from './bulk-json-builder';
import { stmt } from './db-capture.fixtures.spec-helper';
import { nativeComparison, originBadge, originSummary, pagingText, queryKeyOf } from './db-origin';
import { buildStatementTree } from './db-statement-tree';
import { buildExportHtml } from './html-builder';
import { parseImportedCalls } from './import-parser';
import { buildExportMarkdown } from './markdown-builder';
import { REDACTED, redactCalls } from './redact';
import { buildSqlScript } from './sql-export-builder';
import { renderQueryText } from './sql-render';

/** Where a statement came from - HQL, native SQL, Hibernate events, plain JDBC (specs/006-db-capture/hql-mock.html). */
const FORM = { supplierName: '', credentialsUsed: '', apiKey: '', url: '', environment: 'Staging' as const, description: '' };
const v = (type: string, value: string | null): TypedValue => ({ type, value });

const HQL: StatementOrigin = {
  id: 'a:q1', kind: 'HQL', text: 'from Organization o left join fetch o.products where o.group.id = :groupId',
  name: 'Organization.byGroup', method: 'list', params: [{ name: ':groupId', value: '948' }],
};
const LAZY: StatementOrigin = { id: 'a:q2', kind: 'LAZY_LOAD', role: 'UserGroup.supplierSettings', entity: 'UserGroup', entityId: '948' };
const FETCH: StatementOrigin = { id: 'a:q3', kind: 'LOAD', entity: 'OrgFinDetail', entityId: '948', parentId: 'a:q1' };
const NATIVE: StatementOrigin = {
  id: 'a:q4', kind: 'NATIVE', text: 'select gm.GROUP_ID from TT_GROUP_MEMBER gm where gm.GROUP_ID = :groupId',
  method: 'getResultList', params: [{ name: ':groupId', value: '948' }], firstResult: 100, maxResults: 50,
};
const FLUSH: StatementOrigin = { id: 'a:q5', kind: 'FLUSH', action: 'UPDATE', entity: 'UserGroup', entityId: '948', changed: ['lastLogin'] };

function statements(): ExportedDbStatement[] {
  return [
    stmt(1, 'SELECT', 'SELECT o.ID FROM TT_ORGANIZATION o WHERE o.GROUP_ID = ?', { params: [[v('BIGINT', '948')]], origin: HQL, codeLocation: 'OrgDao.byGroup(OrgDao.java:41)' }),
    stmt(2, 'SELECT', 'SELECT * FROM TT_ORG_PRODUCTS_MAP WHERE ORG_ID = ?', { params: [[v('BIGINT', '948')]], origin: HQL }),
    stmt(3, 'SELECT', 'SELECT * FROM TT_ORG_FIN_DETAIL WHERE ORGANIZATION_ID = ?', { params: [[v('BIGINT', '948')]], origin: FETCH }),
    stmt(4, 'SELECT', 'SELECT * FROM TT_SUPPLIER_SETTINGS WHERE GROUP_ID = ?', { params: [[v('BIGINT', '948')]], origin: LAZY }),
    stmt(5, 'SELECT', 'select * from ( select gm.GROUP_ID from TT_GROUP_MEMBER gm where gm.GROUP_ID = ? ) where rownum <= ?', {
      params: [[v('BIGINT', '948'), v('INTEGER', '150')]], origin: NATIVE,
    }),
    stmt(6, 'UPDATE', 'UPDATE TT_USER_GROUP SET LAST_LOGIN = ? WHERE GROUP_ID = ?', { params: [[v('TIMESTAMP', '2026-10-05 02:12:44'), v('BIGINT', '948')]], origin: FLUSH }),
    stmt(7, 'UPDATE', 'UPDATE TT_USER SET PASSWORD = ? WHERE USER_ID = ?', { params: [[v('VARCHAR', 'hunter2'), v('BIGINT', '1042')]] }),
  ];
}

function call(list = statements()): CallRecord {
  const capture: CallDbCapture = { summary: null, transactions: [], supplierMarkers: [], statements: list };
  return {
    id: 'in-1', original_url: 'http://localhost:9001/groups', url: 'http://host.docker.internal:8080/groups', method: 'GET',
    request: { headers: {}, body: '' }, timestamp: '2026-10-05T02:12:44.000Z', duration_ms: 420,
    response: { status: 200, headers: {}, body: '[]' }, state: 'COMPLETED', source: 'internal', service_name: 'odeysys',
    dbCapture: capture,
  };
}

describe('statement origins', () => {
  it('labels each row by where it came from - JDBC only in a call where an ORM made other statements', () => {
    const all = statements();
    expect(all.map((s) => originBadge(s, true)?.label)).toEqual(['HQL', 'HQL', 'LOAD', 'LAZY LOAD', 'NATIVE', 'FLUSH', 'JDBC']);
    expect(originBadge(all[6], false)).toBeNull();
    expect(originBadge(stmt(8, 'COMMIT', 'COMMIT'), true)).toBeNull();
    expect(originSummary(LAZY)).toBe('UserGroup.supplierSettings of UserGroup#948');
    expect(originSummary(FLUSH)).toBe('update UserGroup#948 · changed: lastLogin');
    expect(pagingText(NATIVE)).toBe('first 50, from row 101');
  });

  it('tells a native query sent as written from one Hibernate rewrote', () => {
    const o: StatementOrigin = { id: 'x', kind: 'NATIVE', text: 'select a from t where b = :b and c = ?2' };
    expect(nativeComparison(o, 'select a from t where b = :b and c = ?2')).toBe('same');
    expect(nativeComparison(o, 'select a   from t where b = ? and c = ?')).toBe('params');
    expect(nativeComparison(o, 'select * from (select a from t where b = ? and c = ?) where rownum <= ?')).toBe('changed');
  });

  it('marks keywords and named or numbered parameters in the code\'s query', () => {
    const tokens = renderQueryText('from Org o where o.id = :id and o.x = ?12 and o.t = \'a:b\'', true);
    expect(tokens.filter((t) => t.kind === 'np').map((t) => t.text)).toEqual([':id', '?12']);
    expect(tokens.filter((t) => t.kind === 'kw').map((t) => t.text)).toEqual(['from', 'where', 'and', 'and']);
  });

  it('groups the SQL one query produced under it, events during it included, only when it produced more than one', () => {
    const all = statements();
    expect(queryKeyOf(all[2])).toBe('a:q1');
    expect(queryKeyOf(all[3])).toBeNull();
    const tree = buildStatementTree(all, [], [], 5, true);
    expect(tree[0].type).toBe('query');
    expect(tree[0].type === 'query' && tree[0].children.map((c) => c.seq)).toEqual([1, 2, 3]);
    expect(tree[0].type === 'query' && tree[0].origin?.name).toBe('Organization.byGroup');
    expect(tree.slice(1).map((n) => n.type)).toEqual(['stmt', 'stmt', 'stmt', 'stmt']);
    expect(buildStatementTree(all, [], [], 5).every((n) => n.type === 'stmt')).toBeTrue();
  });

  it('shows the HQL above the SQL it became in .html and .md, and as a comment in the .sql script', () => {
    const html = buildExportHtml(call(), FORM);
    expect(html).toContain('<span class="orig hql"');
    expect(html).toContain('HQL - named query Organization.byGroup · :groupId = 948 · OrgDao.byGroup(OrgDao.java:41) · list()');
    expect(html).toContain('<pre class="sql hql">from Organization o left join fetch o.products where o.group.id = :groupId</pre>');
    expect(html).toContain('SQL sent (after transformation)');
    expect(html).toContain('class="grp qry"');
    expect(html).toContain('Lazy load of UserGroup.supplierSettings for UserGroup#948');
    expect(html).toContain('SQL - written in the code and sent as written (JDBC)');

    const md = buildExportMarkdown(call(), FORM);
    expect(md).toContain('**HQL - named query Organization.byGroup');
    expect(md).toContain(['```sql', 'from Organization o left join fetch o.products where o.group.id = :groupId', '```', '', 'SQL sent (after transformation):'].join('\n'));
    expect(md).toContain('<summary>#4 LAZY LOAD SELECT');

    const script = buildSqlScript(statements());
    expect(script).toContain('-- HQL - named query Organization.byGroup · :groupId = 948 · list():\n--   from Organization o left join fetch o.products');
    expect(script).toContain('-- Flush - update of UserGroup#948, fields changed: lastLogin.');
    expect(script).toContain("UPDATE TT_USER SET PASSWORD = 'hunter2' WHERE USER_ID = 1042;");
  });

  it('round-trips the origin through the .json export and import', () => {
    const payload = JSON.parse(JSON.stringify(buildBulkExportPayload([call()], FORM, new Map(), '2026-10-05T00:00:00Z')));
    const back = parseImportedCalls(payload).calls.find((c) => c.id === 'in-1')!;
    expect(back.dbCapture?.statements[0].origin).toEqual(HQL);
    expect(back.dbCapture?.statements[4].origin).toEqual(NATIVE);
  });

  it('masks a redacted value in the query\'s named parameters too', () => {
    const list = statements();
    list[0] = { ...list[0], sql: 'SELECT * FROM TT_USER WHERE PASSWORD = ?', params: [[v('VARCHAR', 'hunter2')]],
      origin: { ...HQL, params: [{ name: ':pwd', value: "'hunter2'" }, { name: ':password', value: "'other'" }] } };
    const rules: Redaction[] = [{ id: 'r1', scope: 'all', callId: null, kind: 'db-column', name: 'password', createdAt: '' }];
    const { calls } = redactCalls([call(list)], rules);
    const first = calls[0].dbCapture!.statements[0];
    expect(first.params[0][0].value).toBe(REDACTED);
    expect(first.origin?.params?.map((p) => p.value)).toEqual([REDACTED, REDACTED]);
    expect(buildExportHtml(calls[0], FORM)).not.toContain('hunter2');
  });
});
