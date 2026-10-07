import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { readExportFile } from '../../frontend/src/app/shared/utils/export-file-io.ts';
import { parseImportedCalls } from '../../frontend/src/app/shared/utils/import-parser.ts';
import { analyzeCapture, buildExportFile, suppliersOf, toCallRecord, type CallDbCapture, type CallRecord, type CallSummaryDto, type ExportedCycle } from '../src/frontend.ts';
import { summaryOf } from './fake-alfred.ts';
import { world } from './harness.ts';
import { CYCLE, IN1, OUT1, TOKEN } from './fixtures.ts';
import { session } from '../src/session.ts';

const dto = (v: unknown) => v as CallSummaryDto;

/** Generation time differs run to run - every timestamp within the last hour becomes NOW in both files. */
function normalise(text: string): string {
  const since = Date.now() - 3_600_000;
  return text.replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/g, (iso) => (Date.parse(iso) >= since ? 'NOW' : iso));
}

/**
 * What the UI's cycle export would build from the same fake data: cycle-export.service's inputs
 * (outbound then inbound, each in stored order, merged with detail), the dialog's DB attachment,
 * Redactions - fed to the same buildExportFile.
 */
function expectedCycleExport(fake: Awaited<ReturnType<typeof world>>['fake'], format: 'markdown' | 'json' | 'html', redactions = fake.state.redactions) {
  const entries = fake.state.cycleEntries.get(CYCLE)!;
  const ordered = [...entries.filter((e) => e.source === 'external'), ...entries.filter((e) => e.source === 'internal')];
  const calls: CallRecord[] = ordered.map((e) => {
    const call = { ...toCallRecord(dto(summaryOf(e.record)), e.source), request: e.record.request, response: e.record.response, relive: null } as CallRecord;
    if (e.source !== 'internal' || !fake.state.statements[call.id]) return call;
    const capture: CallDbCapture = { summary: fake.state.dbSummaries[call.id], transactions: [], supplierMarkers: [],
      statements: fake.state.statements[call.id].map((s) => ({ ...s, rows: fake.state.rows[s.id]?.rows ?? null })) };
    const children = fake.state.calls.filter((c) => c.record.parentCallId === call.id).map((c) => toCallRecord(dto(summaryOf(c.record)), 'external'));
    return { ...call, dbCapture: { ...capture, analysis: analyzeCapture(call, capture, suppliersOf(call.id, children)), layout: 'grouped' } };
  });
  const cycle = fake.state.cycles.find((c) => c.id === CYCLE)!;
  const exportedCycle: ExportedCycle = { id: cycle.id, name: cycle.name, assignedTo: cycle.assignedTo, status: cycle.status, createdAt: cycle.createdAt };
  return buildExportFile(format, {
    calls, form: { supplierName: '', credentialsUsed: '', apiKey: '', url: calls[0].url, environment: 'Staging', description: '' },
    commentsByCallId: new Map(calls.map((c) => [c.id, fake.state.comments.filter((x) => x.callId === c.id)])),
    overlapCandidates: [], statusFilter: 'all', cycle: exportedCycle, spacers: [], listOrder: 'chronological', redactions, rows: 'all',
    exportedAt: new Date().toISOString(), fileName: '',
  });
}

test('no path and no session folder: nothing is written, the reply asks', async () => {
  const w = await world();
  try {
    const r = await w.call('export_calls', { format: 'md', cycleId: CYCLE });
    assert.equal(r.json.needsPath, true);
    assert.equal(w.fake.log.filter((q) => q.path.includes('/detail')).length, 0, 'nothing fetched before a location is known');
  } finally { await w.close(); }
});

test('cycle export .md/.html/.json equal the UI builders\' output apart from the generation time (SC-008)', async () => {
  const w = await world();
  try {
    w.fake.state.comments.push({ id: 'cm1', callId: IN1, block: 'response-body', lineIndex: 1, lineText: 'x', comment: 'look here', createdAt: '' });
    const dir = await mkdtemp(join(tmpdir(), 'mcp-export-'));
    await w.call('session_settings', { exportFolder: dir });
    for (const [format, ext] of [['markdown', 'md'], ['html', 'html'], ['json', 'json']] as const) {
      const r = await w.call('export_calls', { format: ext, cycleId: CYCLE });
      assert.equal(r.isError, false, r.text);
      assert.ok(r.json.path.startsWith(dir));
      const written = await readFile(r.json.path, 'utf8');
      assert.equal(r.json.bytes, Buffer.byteLength(written));
      const expected = expectedCycleExport(w.fake, format);
      const expectedText = expected.kind === 'lines' ? expected.lines.join('\n') : expected.kind === 'text' ? expected.content : '';
      assert.equal(r.json.path, join(dir, expected.filename));
      assert.equal(normalise(written), normalise(expectedText), `${format} differs`);
    }
  } finally { await w.close(); }
});

test('.json re-imports with the same calls, bodies intact', async () => {
  const w = await world();
  try {
    const dir = await mkdtemp(join(tmpdir(), 'mcp-export-'));
    const r = await w.call('export_calls', { format: 'json', cycleId: CYCLE, path: join(dir, 'cycle.json') });
    const parsed = parseImportedCalls(await readExportFile(new Blob([await readFile(r.json.path)])));
    assert.deepEqual(parsed.calls.map((c) => c.id).sort(), w.fake.state.cycleEntries.get(CYCLE)!.map((e) => e.record.id).sort());
    const out1 = parsed.calls.find((c) => c.id === OUT1)!;
    assert.equal(out1.response?.body, '{"offers":[]}');
    assert.equal(parsed.cycleName, 'booking fails at payment');
  } finally { await w.close(); }
});

test('relative path and generated name go under the session folder; an existing file is not overwritten unless asked', async () => {
  const w = await world();
  try {
    const dir = await mkdtemp(join(tmpdir(), 'mcp-export-'));
    await w.call('session_settings', { exportFolder: dir });
    const named = await w.call('export_calls', { format: 'md', calls: [{ id: IN1 }], path: 'repro.md' });
    assert.equal(named.json.path, join(dir, 'repro.md'));
    const again = await w.call('export_calls', { format: 'md', calls: [{ id: IN1 }], path: 'repro.md' });
    assert.equal(again.json.error, 'invalid');
    assert.match(again.json.message, /already exists/);
    const forced = await w.call('export_calls', { format: 'md', calls: [{ id: IN1 }], path: 'repro.md', overwrite: true });
    assert.equal(forced.isError, false);
    const fromSearch = await w.call('export_calls', { format: 'html', search: { text: 'payment failed' } });
    assert.equal(fromSearch.json.calls, 1);
    assert.ok((await readdir(dir)).length >= 2);
    assert.ok(!(await readdir(dir)).some((f) => f.includes('.tmp-')), 'no temp file left behind');
  } finally { await w.close(); }
});

test('exports are always masked, whatever the session says about replies', async () => {
  const w = await world();
  try {
    w.fake.state.redactions = [{ id: 'r', scope: 'all', callId: null, kind: 'request-header', name: 'Authorization', createdAt: '' }];
    const dir = await mkdtemp(join(tmpdir(), 'mcp-export-'));
    const r = await w.call('export_calls', { format: 'json', cycleId: CYCLE, path: join(dir, 'masked.json') });
    assert.ok(r.json.redactedValues > 0);
    assert.ok(!(await readFile(r.json.path, 'utf8')).includes(TOKEN));
  } finally { await w.close(); }
});

test('exactly one source is required', async () => {
  const w = await world();
  try {
    const dir = await mkdtemp(join(tmpdir(), 'mcp-export-'));
    await writeFile(join(dir, 'x'), '');
    const r = await w.call('export_calls', { format: 'md', cycleId: CYCLE, calls: [{ id: IN1 }], path: join(dir, 'a.md') });
    assert.equal(r.json.error, 'invalid');
  } finally { await w.close(); }
});

test('on a server reached over HTTP, exports stay in the pinned folder and come back as a download link', async () => {
  const w = await world();
  try {
    const dir = await mkdtemp(join(tmpdir(), 'mcp-pinned-'));
    session.exportPin = dir;
    session.exportFolder = dir;
    const saved = await w.call('export_calls', { format: 'md', calls: [{ id: IN1 }], fileName: 'repro one.md' });
    assert.equal(saved.isError, false, saved.text);
    assert.equal(saved.json.download, '/mcp-exports/repro%20one.md');
    assert.equal(saved.json.path, undefined, 'the server path is not handed out');
    assert.deepEqual(await readdir(dir), ['repro one.md']);

    const outside = await w.call('export_calls', { format: 'md', calls: [{ id: IN1 }], path: join(tmpdir(), 'elsewhere.md') });
    assert.match(outside.json.message, /saved in .* only/);
    const climbing = await w.call('export_calls', { format: 'md', calls: [{ id: IN1 }], fileName: '../up.md' });
    assert.match(climbing.json.message, /saved in .* only/);
    const moved = await w.call('session_settings', { exportFolder: tmpdir() });
    assert.equal(moved.isError, true);
    const rooted = await w.call('session_settings', { sourceRoot: tmpdir() });
    assert.equal(rooted.isError, true);
  } finally {
    session.exportPin = null;
    await w.close();
  }
});
