import { CallRecord } from '../../core/models/call.model';
import { CallDbCapture, ExportedDbStatement, TypedValue } from '../../core/models/db-capture.model';
import { Redaction } from '../../core/models/redaction.model';
import { buildBulkExportPayload } from './bulk-json-builder';
import { stmt } from './db-capture.fixtures.spec-helper';
import { buildBulkExportHtml, buildExportHtml } from './html-builder';
import { parseImportedCalls } from './import-parser';
import { buildBulkExportMarkdown, buildExportMarkdown } from './markdown-builder';
import { REDACTED, redactCalls } from './redact';

/**
 * Database capture in every export (contracts/export-format.md). Fixtures go through buildBulkExportPayload and
 * JSON, never by hand - the importer's rule.
 */
const FORM = { supplierName: '', credentialsUsed: '', apiKey: '', url: '', environment: 'Staging' as const, description: '' };
const v = (type: string, value: string | null): TypedValue => ({ type, value });

function bigRows(n: number): TypedValue[][] {
  return Array.from({ length: n }, (_, i) => [v('BIGINT', String(i)), v('VARCHAR', `row ${i}`)]);
}

function capture(): CallDbCapture {
  const select: ExportedDbStatement = {
    ...stmt(1, 'SELECT', 'SELECT id, name FROM users WHERE id > ?', { params: [[v('BIGINT', '0')]] }),
    outcome: { kind: 'ROWS', rowsRead: 5000, columns: [{ name: 'id', type: 'BIGINT' }, { name: 'name', type: 'VARCHAR' }] },
    storedRows: 5000,
    rows: bigRows(5000),
  };
  const batch: ExportedDbStatement = {
    ...stmt(2, 'INSERT', 'INSERT INTO ledger (payment_id, card_token) VALUES (?, ?)', {
      txId: 'tx-7', params: [[v('BIGINT', '99817'), v('VARCHAR', 'tok_live_1')], [v('BIGINT', '99817'), v('VARCHAR', 'tok_live_2')]],
    }),
    outcome: { kind: 'UPDATED', affected: 2, perSet: [1, 1] },
  };
  const proc: ExportedDbStatement = {
    ...stmt(3, 'CALL', '{call calc_fees(?, ?)}', { params: [[v('DECIMAL', '120.00'), { type: 'DECIMAL', value: '1.80', direction: 'OUT' }]] }),
    outcome: { kind: 'PROCEDURE', outParams: [{ type: 'DECIMAL', value: '1.80', direction: 'OUT' }] },
  };
  const hostile: ExportedDbStatement = {
    ...stmt(4, 'INSERT', 'INSERT INTO notes (body) VALUES (?)', { params: [[v('VARCHAR', '<script>alert(1)</script> | ``` break')]] }),
    outcome: { kind: 'FAILED', sqlState: '23000', vendorCode: 1, message: 'ORA-00001: unique constraint (<b>X</b>) violated', swallowed: true },
  };
  return {
    summary: null,
    transactions: [{ callId: 'in-1', txId: 'tx-7', firstSeq: 2, lastSeq: 2, outcome: 'COMMITTED', heldMicros: 5000, statementCount: 1, writeCount: 1 }],
    supplierMarkers: [{ seq: 5, method: 'POST', url: 'https://pay.example/charge' }],
    statements: [select, batch, proc, hostile],
  };
}

function inbound(): CallRecord {
  return {
    id: 'in-1', original_url: 'http://localhost:9001/pay', url: 'http://host.docker.internal:8080/pay', method: 'POST',
    request: { headers: {}, body: '{}' }, timestamp: '2026-10-04T18:02:43.000Z', duration_ms: 420,
    response: { status: 200, headers: {}, body: '{"ok":true}' }, state: 'COMPLETED', source: 'internal', service_name: 'wallet-app',
    dbCapture: capture(),
  };
}

describe('database capture in exports', () => {
  it('round-trips through the .json export and import with every row', () => {
    const call = inbound();
    const payload = JSON.parse(JSON.stringify(buildBulkExportPayload([call], FORM, new Map(), '2026-10-05T00:00:00Z')));
    const events = payload.events.filter((e: { dbCapture?: unknown }) => e.dbCapture);
    expect(events.length).toBe(1); // once per call, on the event that completes it

    const back = parseImportedCalls(payload).calls.find((c) => c.id === 'in-1')!;
    expect(back.dbCapture?.statements.length).toBe(4);
    expect(back.dbCapture?.statements[0].rows?.length).toBe(5000);
    expect(back.dbCapture?.statements[1].params.length).toBe(2);
    expect(back.dbCapture?.statements[2].outcome.outParams?.[0].value).toBe('1.80');
    expect(back.dbCapture?.supplierMarkers?.[0].url).toBe('https://pay.example/charge');
    expect(back.dbCapture).toEqual(call.dbCapture);
  });

  it('puts the database section in .md and .html without cutting a row, and escapes captured text', () => {
    const md = buildExportMarkdown(inbound(), FORM);
    expect(md).toContain('🗄 Database');
    expect(md).toContain('| 4999 | row 4999 |');
    expect(md).toContain("INSERT INTO ledger (payment_id, card_token) VALUES (99817, 'tok_live_2');");
    expect(md).toContain('unique constraint (&lt;b&gt;X&lt;/b&gt;) violated'); // captured text never becomes markup
    expect(md).toContain("````sql"); // a fence longer than the captured backtick run
    expect(md).not.toMatch(/\n```\s*break/); // the captured backticks cannot close the fence

    const html = buildExportHtml(inbound(), FORM);
    expect(html).toContain('<td>row 4999</td>');
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).not.toContain('(<b>X</b>)');
    expect(html).toContain('↗ supplier call');

    const bulk = buildBulkExportMarkdown([inbound()], FORM, new Map(), '2026-10-05T00:00:00Z');
    expect(bulk).toContain('| 4999 | row 4999 |');
    expect(buildBulkExportHtml([inbound()], FORM, new Map(), '2026-10-05T00:00:00Z')).toContain('<td>row 4999</td>');
  });

  it('says so in the About section', () => {
    const payload = buildBulkExportPayload([inbound()], FORM, new Map(), '2026-10-05T00:00:00Z');
    expect(payload.about.description).toContain('database statements');
  });

  it('masks a db-column redaction in rows and bound parameters, counts it, and leaves the call untouched otherwise', () => {
    const rules: Redaction[] = [
      { id: 'r1', scope: 'all', callId: null, kind: 'db-column', name: 'Card_Token', createdAt: '' },
      { id: 'r2', scope: 'all', callId: null, kind: 'db-column', name: 'name', createdAt: '' },
    ];
    const original = inbound();
    const { calls, redactedValueCount } = redactCalls([original], rules);
    const statements = calls[0].dbCapture!.statements;
    expect(statements[1].params.map((set) => set[1].value)).toEqual([REDACTED, REDACTED]);
    expect(statements[1].params[0][0].value).toBe('99817');
    expect(statements[0].rows!.every((r) => r[1].value === REDACTED && r[0].value !== REDACTED)).toBeTrue();
    expect(redactedValueCount).toBe(2 + 5000);
    expect(original.dbCapture!.statements[1].params[0][1].value).toBe('tok_live_1'); // the window's data is not touched

    const md = buildExportMarkdown(calls[0], FORM);
    expect(md).not.toContain('tok_live_1');
    expect(md).not.toContain('row 17 |');
  });
});
