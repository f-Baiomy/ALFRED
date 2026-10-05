import assert from 'node:assert/strict';
import { test } from 'node:test';
import { world } from './harness.ts';
import { BIG, BIN, CYCLE, IN1, OUT1, OUT2, TOKEN } from './fixtures.ts';

test('get_call default: headers, bodies with sizes, children with ids, comments, db summary', async () => {
  const w = await world();
  try {
    const r = await w.call('get_call', { id: IN1 });
    assert.equal(r.isError, false, r.text);
    assert.equal(r.json.direction, 'inbound');
    assert.equal(r.json.request.headers.Authorization, TOKEN);
    assert.equal(r.json.response.body.totalLength, r.json.response.body.text.length);
    assert.deepEqual(r.json.children.map((c: { id: string }) => c.id).sort(), [OUT1, OUT2].sort());
    assert.deepEqual(r.json.comments, []);
    assert.equal(r.json.db.statements, 40);
    assert.ok(r.json.db.findings.some((f: { seqs: number[] }) => f.seqs.includes(42)));
  } finally { await w.close(); }
});

test('a body larger than one page is read to the end with get_call_body', async () => {
  const w = await world();
  try {
    const first = await w.call('get_call', { id: BIG, fields: ['responseBody'], bodyLength: 4000 });
    const total: number = first.json.responseBody.totalLength;
    assert.ok(total > 100_000);
    // At most 4000 characters as sent (escaped quotes count), so the next page starts at or before 4000.
    assert.ok(first.json.responseBody.nextOffset > 0 && first.json.responseBody.nextOffset <= 4000);
    let text = '';
    for (let offset: number | null = 0; offset !== null;) {
      const page = await w.call('get_call_body', { id: BIG, part: 'response-body', offset, length: 15000, pretty: false });
      assert.equal(page.isError, false, page.text);
      assert.ok(page.text.length <= 16000);
      text += page.json.text;
      offset = page.json.nextOffset;
    }
    assert.equal(text.length, total);
  } finally { await w.close(); }
});

test('a binary body is reported by type and size only', async () => {
  const w = await world();
  try {
    const r = await w.call('get_call', { id: BIN, direction: 'outbound', fields: ['responseBody'] });
    assert.equal(r.json.responseBody.binary, true);
    assert.equal(r.json.responseBody.contentType, 'image/png');
    assert.equal(r.json.responseBody.text, undefined);
  } finally { await w.close(); }
});

test('fields method+url cost no detail request at all', async () => {
  const w = await world();
  try {
    const r = await w.call('get_call', { id: IN1, fields: ['method', 'url'] });
    assert.deepEqual(Object.keys(r.json).filter((k) => !['masked', 'maskedValues'].includes(k)).sort(), ['id', 'method', 'url']);
    assert.equal(w.fake.requests('GET', '/detail').length, 0);
  } finally { await w.close(); }
});

test('cycleId reads the cycle copy endpoints', async () => {
  const w = await world();
  try {
    const r = await w.call('get_call', { id: OUT1, cycleId: CYCLE, fields: ['responseHeaders'] });
    assert.equal(r.isError, false, r.text);
    assert.ok(w.fake.requests('GET', `/session-cycles/${CYCLE}/calls/${OUT1}/detail`).length > 0);
  } finally { await w.close(); }
});
