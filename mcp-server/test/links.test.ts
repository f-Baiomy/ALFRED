import assert from 'node:assert/strict';
import { test } from 'node:test';
import { splitRef } from '../src/tools/links.ts';
import { world } from './harness.ts';

const LINK = { id: 'L1', slug: 'stg-83', name: 'STG 83', peerName: 'Alfred b', address: 'http://b:3000', online: true, rttMs: 4,
  peerVersion: '1.53.0', lastError: null, skewed: false, lastSeen: null };
const STREAM = { id: 'S1', mine: false, linkId: 'L1', kind: 'BOARD', target: 'b1', targetName: 'dashboard', project: 'odeysys', mode: 'COMMENT',
  autoAccept: false, passOn: false, passMode: 'VIEW', unmasked: false, env: null, createdAt: '2026-10-19T08:00:00Z', endedAt: null };

test('a ref names another Alfred only with a real tag', () => {
  assert.deepEqual(splitRef('8f1c@stg-83'), { inner: '8f1c', slug: 'stg-83' });
  assert.deepEqual(splitRef('8f1c@stg-83@pc-1'), { inner: '8f1c@stg-83', slug: 'pc-1' });
  assert.equal(splitRef('plain-id'), null);
  assert.equal(splitRef('a@b.com'), null);
});

test('links_streams lists the refs streamed here and never offers to answer requests', async () => {
  const w = await world();
  try {
    w.fake.extra = (method, parts) => {
      if (method !== 'GET' || parts[0] !== 'links') return null;
      if (parts.length === 1) return [200, [LINK]];
      if (parts[1] === 'streams') return [200, [STREAM, { ...STREAM, id: 'S2', mine: true, kind: 'CYCLE', target: 'c9', targetName: 'run 2', mode: 'VIEW' }]];
      if (parts[1] === 'requests') return [200, [{ id: 'R1', streamId: 'S2', linkId: 'L1', incoming: true, kind: 'CALL_NOTE', target: 'k', targetLabel: 'GET /x',
        text: 'why?', author: 'STG 83', state: 'WAITING', note: null, createdAt: '' }]];
      return null;
    };
    const r = await w.call('links_streams');
    assert.equal(r.isError, false, r.text);
    assert.equal(r.json.streamedToHere[0].ref, 'b1@stg-83');
    assert.match(r.json.streamedToHere[0].youMay, /links_request/);
    assert.equal(r.json.streamedFromHere[0].id, 'c9');
    assert.match(r.json.requests[0].direction, /asked of this Alfred/);
    assert.match(r.json.note, /never answer them yourself/);
  } finally { await w.close(); }
});

test('links_request sends a request as Claude over the stream that carries it; a view-only stream refuses', async () => {
  const w = await world();
  try {
    let mode = 'COMMENT';
    w.fake.extra = (method, parts, _q, body) => {
      if (parts[0] !== 'links') return null;
      if (method === 'GET' && parts.length === 1) return [200, [LINK]];
      if (method === 'GET' && parts[1] === 'streams') return [200, [{ ...STREAM, mode }]];
      if (method === 'POST' && parts[1] === 'requests') return [200, { id: 'R9', state: 'WAITING', ...(body as object) }];
      return null;
    };
    const r = await w.call('links_request', { ref: 'card-7@stg-83', kind: 'CARD_COMMENT', text: 'total off by the fee', label: '#7 Refund' });
    assert.equal(r.isError, false, r.text);
    const sent = w.fake.requests('POST', '/links/requests')[0].body;
    assert.deepEqual({ via: sent.via, streamId: sent.streamId, kind: sent.kind, target: sent.target, claude: sent.claude },
      { via: 'stg-83', streamId: 'S1', kind: 'CARD_COMMENT', target: 'card-7', claude: true });
    assert.match(r.json.said, /waiting for STG 83/);

    mode = 'VIEW';
    const refused = await w.call('links_request', { ref: 'card-7@stg-83', kind: 'CARD_COMMENT', text: 'x' });
    assert.equal(refused.json.error, 'invalid');
    const local = await w.call('links_request', { ref: 'card-7', kind: 'CARD_COMMENT', text: 'x' });
    assert.equal(local.json.error, 'invalid');
  } finally { await w.close(); }
});

test('env_mark needs evidence and marks as Claude; clear takes it back', async () => {
  const w = await world();
  try {
    w.fake.extra = (method, parts) => {
      if (parts[0] !== 'links' || parts[1] !== 'env') return null;
      if (method === 'PUT') return [200, { mark: 'FAIL' }];
      if (method === 'DELETE') return [204, undefined];
      return null;
    };
    const none = await w.call('env_mark', { host: 'pc-1', boardId: 'b1', fileName: 'spec.md', itemKey: 'AC1', mark: 'FAIL' });
    assert.equal(none.json.error, 'invalid');
    const r = await w.call('env_mark', { host: 'pc-1', boardId: 'b1', fileName: 'spec.md', itemKey: 'AC1', mark: 'FAIL', evidence: 'POST /refunds → 500' });
    assert.equal(r.isError, false, r.text);
    const put = w.fake.requests('PUT', '/links/env/pc-1/b1/marks')[0].body;
    assert.equal(put.claude, true);
    assert.equal(put.evidence, 'POST /refunds → 500');
    const c = await w.call('env_mark', { host: 'pc-1', boardId: 'b1', fileName: 'spec.md', itemKey: 'AC1', clear: true });
    assert.equal(c.json.cleared, 'spec.md#AC1');
  } finally { await w.close(); }
});

test("a reply about another Alfred's thing opens with where it came from; this Alfred's own stays as it was", async () => {
  const w = await world();
  try {
    w.fake.extra = (method, parts) => {
      if (method === 'GET' && parts[0] === 'links' && parts.length === 1) return [200, [{ ...LINK, online: false }]];
      if (method === 'GET' && parts[0] === 'comments') return [200, []];
      return null;
    };
    const remote = await w.call('list_comments', { callId: 'abc@stg-83' });
    assert.equal(remote.isError, false, remote.text);
    assert.match(remote.text.split('\n')[0], /^⇇ From STG 83 \(offline\) - another Alfred's, streamed here: read only/);
    const own = await w.call('list_comments', { callId: 'abc' });
    assert.doesNotMatch(own.text, /⇇ From/);
    const unknown = await w.call('list_comments', { callId: 'abc@pc-77' });
    assert.doesNotMatch(unknown.text, /⇇ From/);
  } finally { await w.close(); }
});
