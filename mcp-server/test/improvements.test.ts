import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { CallRecord } from '../src/frontend.ts';
import { suggestSpacers } from '../src/tools/spacers.ts';
import { DEFAULT_REDACTIONS } from '../src/tools/redactions.ts';
import { world } from './harness.ts';
import { IN1, T0 } from './fixtures.ts';

// Bug report 2026-10-05, improvements 1-15.

const at = (ms: number) => new Date(T0 + ms).toISOString();

function call(id: string, source: 'internal' | 'external', ms: number, overrides: Partial<CallRecord> = {}): CallRecord {
  return {
    id, source, method: 'POST', timestamp: at(ms), duration_ms: 500, state: 'COMPLETED',
    original_url: `http://localhost:8080/odeysysadmin/Booking2/flight-search/${id}`, url: source === 'internal'
      ? `http://host.docker.internal:9001/odeysysadmin/Booking2/flight-search/${id}` : 'https://g94.example.test/webservices/AAResWebServices',
    service_name: source === 'internal' ? 'odeysys' : null,
    request: { headers: {}, body: '{}' }, response: { status: 200, headers: {}, body: '{"ok":true}' }, ...overrides,
  };
}

/** The Air Arabia story: a search answers 200 with nothing, because its supplier answered 200 with error 322. */
function searchStory() {
  const preflight = call('preflight', 'internal', 0, { method: 'OPTIONS', response: { status: 200, headers: {}, body: '' } });
  const search = call('search', 'internal', 10, { response: { status: 200, headers: {}, body: '{"searchOffers":{"offers":{},"journeys":{}}}' } });
  const supplier = call('supplier', 'external', 20, {
    parentCallId: 'search',
    response: { status: 200, headers: { 'content-type': 'text/xml' }, body: '<OTA_AirAvailRS><Errors><Error Code="322" ShortText="No availability"/></Errors></OTA_AirAvailRS>' },
  });
  return { preflight, search, supplier };
}

async function storyWorld() {
  const w = await world();
  const { preflight, search, supplier } = searchStory();
  w.fake.addCall('internal', search);
  w.fake.addCall('internal', preflight);
  w.fake.addCall('external', supplier);
  w.fake.addCycle({ id: 'cy-aa', name: 'air arabia no results' }, [
    { source: 'internal', record: preflight }, { source: 'internal', record: search }, { source: 'external', record: supplier },
  ]);
  return w;
}

test('get_cycle flags an error inside a 200, an empty result, and lists supplier calls under the inbound call', async () => {
  const w = await storyWorld();
  try {
    const r = await w.call('get_cycle', { cycle: 'cy-aa', includeDb: false });
    assert.match(r.text, /#1 .*id=search ∅ empty: searchOffers\.offers, searchOffers\.journeys/);
    assert.match(r.text, /↳ supplier calls: #2 POST g94\.example\.test → 200 ✖ 322: No availability/);
    assert.match(r.text, /#2 .*id=supplier ✖ 322: No availability/);
  } finally { await w.close(); }
});

test('OPTIONS preflights are hidden and counted by default, shown on request', async () => {
  const w = await storyWorld();
  try {
    const hidden = await w.call('get_cycle', { cycle: 'cy-aa', includeDb: false });
    assert.ok(!hidden.text.includes('id=preflight'));
    assert.match(hidden.text, /\+1 OPTIONS preflights hidden/);
    assert.equal(hidden.json.hiddenOptions, 1);
    const shown = await w.call('get_cycle', { cycle: 'cy-aa', includeDb: false, includeOptions: true });
    assert.match(shown.text, /#1 .*OPTIONS .*id=preflight/);
  } finally { await w.close(); }
});

test('with fields, one compact line per call - no repeated summary row', async () => {
  const w = await storyWorld();
  try {
    const r = await w.call('get_cycle', { cycle: 'cy-aa', includeDb: false, includeComments: false, fields: ['method', 'status'] });
    const callLines = r.text.split('\n').filter((l) => l.startsWith('#'));
    assert.equal(callLines.length, 2);
    assert.match(callLines[0], /^#1 \{"method":"POST","status":200\} ∅ empty/);
    assert.ok(!r.text.includes(' IN  POST'), 'no story line next to the selection');
  } finally { await w.close(); }
});

test('bodyPreview shows the start of each response body', async () => {
  const w = await storyWorld();
  try {
    const r = await w.call('get_cycle', { cycle: 'cy-aa', includeDb: false, bodyPreview: 30 });
    assert.match(r.text, /⤷ body: <OTA_AirAvailRS><Errors><Error… \(97 chars - get_call_body id supplier\)/);
  } finally { await w.close(); }
});

test('get_call reports the soft failure and empty result; an inbound call has an appHost, not a supplier', async () => {
  const w = await storyWorld();
  try {
    const supplier = await w.call('get_call', { id: 'supplier', direction: 'outbound' });
    assert.deepEqual(supplier.json.softFailure, { kind: 'xml-error', code: '322', message: 'No availability' });
    const search = await w.call('get_call', { id: 'search', direction: 'inbound', fields: ['responseBody', 'supplier'] });
    assert.deepEqual(search.json.emptyResult, ['searchOffers.offers', 'searchOffers.journeys']);
    assert.equal(search.json.supplier, undefined);
    assert.equal(search.json.appHost, 'host.docker.internal');
  } finally { await w.close(); }
});

test('search_calls failed:true finds an error hidden in a 200', async () => {
  const w = await storyWorld();
  try {
    const r = await w.call('search_calls', { direction: 'outbound', failed: true });
    assert.deepEqual(r.json.calls.map((c: { id: string }) => c.id), ['supplier']);
  } finally { await w.close(); }
});

test('add_comment defaults to a whole-call note; add_comments adds many and reports each', async () => {
  const w = await storyWorld();
  try {
    const one = await w.call('add_comment', { callId: 'search', comment: 'search empty because the supplier answered 322' });
    assert.equal(one.json.block, 'call');
    assert.equal(w.fake.requests('POST', '/comments')[0].body.lineText, '');
    const many = await w.call('add_comments', { comments: [
      { callId: 'search', comment: 'a' },
      { callId: 'supplier', block: 'response-body', lineMatch: '322', comment: 'here' },
      { callId: 'no-such-call', comment: 'x' },
    ] });
    assert.equal(many.json.added, 2);
    assert.equal(many.json.failed, 1);
    assert.equal(many.json.results[2].ok, false);
    const story = await w.call('get_cycle', { cycle: 'cy-aa', includeDb: false });
    assert.match(story.text, /💬 \[call\] 🤖 Claude: search empty/);
  } finally { await w.close(); }
});

test('suggest_spacers splits at pauses and area changes, never at a supplier call', () => {
  const calls = [
    call('login', 'internal', 0, { original_url: 'http://localhost:8080/odeysysadmin/Admin2/login/do' }),
    call('menu', 'internal', 600, { original_url: 'http://localhost:8080/odeysysadmin/Admin2/login/menu' }),
    call('search', 'internal', 5000, { original_url: 'http://localhost:8080/odeysysadmin/Booking2/flight-search/search' }),
    call('supplier', 'external', 5200),
    call('book', 'internal', 5900, { original_url: 'http://localhost:8080/odeysysadmin/v2/booking/fare-confirmation' }),
  ];
  const s = suggestSpacers(calls, 2000);
  assert.deepEqual(s.map((x) => [x.label, x.afterCallId, x.from, x.to]), [
    ['Admin2 login', 'top', 1, 2],
    ['Booking2 flight search', 'menu', 3, 4],
    ['v2 booking', 'supplier', 5, 5],
  ]);
  assert.match(s[1].reason, /pause/);
  assert.match(s[2].reason, /moved to v2/);
});

test('suggest_spacers merges pauses inside one page into one step', () => {
  const page = (id: string, ms: number) => call(id, 'internal', ms, { original_url: `http://localhost:8080/odeysysadmin/Booking2/flight-search/${id}` });
  const s = suggestSpacers([page('cai', 0), page('dxb', 4000), page('search', 9000)], 3000);
  assert.deepEqual(s.map((x) => [x.label, x.from, x.to]), [['Booking2 flight search', 1, 3]]);
});

test('wait_for_calls returns at once what is already past sinceCallId, and times out cleanly otherwise', async () => {
  const w = await storyWorld();
  try {
    const now = await w.call('wait_for_calls', { cycleId: 'cy-aa', sinceCallId: 'search', timeoutSec: 5 });
    assert.deepEqual(now.json.newCalls.map((c: { id: string }) => c.id), ['supplier']);
    assert.equal(now.json.lastCallId, 'supplier');
    const started = Date.now();
    const none = await w.call('wait_for_calls', { cycleId: 'cy-aa', sinceCallId: 'supplier', timeoutSec: 1 });
    assert.equal(none.json.timedOut, true);
    assert.equal(none.json.recording, false);
    assert.ok(Date.now() - started < 4000);
  } finally { await w.close(); }
});

test('add_default_redactions adds only what is missing, and dryRun adds nothing', async () => {
  const w = await world();
  try {
    w.fake.state.redactions = [{ id: 'r', scope: 'all', callId: null, kind: 'request-header', name: 'authorization', createdAt: '' }];
    const dry = await w.call('add_default_redactions', { dryRun: true });
    assert.equal(dry.json.wouldAdd.length, DEFAULT_REDACTIONS.length - 1);
    assert.equal(w.fake.requests('POST', '/redactions').length, 0);
  } finally { await w.close(); }
});

test('export: includeDb summary leaves statements out and says so; refused for .json; Local environment', async () => {
  const w = await world();
  try {
    const dir = await mkdtemp(join(tmpdir(), 'mcp-export-'));
    const full = await w.call('export_calls', { format: 'md', calls: [{ id: IN1 }], path: join(dir, 'full.md') });
    const summary = await w.call('export_calls', { format: 'md', calls: [{ id: IN1 }], path: join(dir, 'summary.md'), includeDb: 'summary', environment: 'Local' });
    assert.equal(summary.isError, false, summary.text);
    const text = await readFile(summary.json.path, 'utf8');
    assert.match(text, /Summary only: the 40 statements themselves/);
    assert.match(text, /Local/);
    assert.ok(summary.json.bytes < full.json.bytes);
    const json = await w.call('export_calls', { format: 'json', calls: [{ id: IN1 }], path: join(dir, 'x.json'), includeDb: 'summary' });
    assert.equal(json.json.error, 'invalid');
  } finally { await w.close(); }
});
