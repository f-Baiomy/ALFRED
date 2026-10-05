import assert from 'node:assert/strict';
import { test } from 'node:test';
import { detectAndFormatBody } from '../src/frontend.ts';
import { blockLines } from '../src/tools/comments.ts';
import { world } from './harness.ts';
import { IN1, IN2 } from './fixtures.ts';

test('lines are the call card\'s: pretty JSON, pretty XML, header object as JSON', () => {
  const call = {
    id: 'a', method: 'POST', url: '', original_url: '', timestamp: '', duration_ms: 0,
    request: { headers: { Accept: 'x', Authorization: 'y' }, body: '{"a":1,"b":[2,3]}' },
    response: { status: 200, body: '<r><a>1</a><b>2</b></r>' },
  };
  assert.deepEqual(blockLines(call, 'request-body'), JSON.stringify({ a: 1, b: [2, 3] }, null, 2).split('\n'));
  assert.deepEqual(blockLines(call, 'response-body'), detectAndFormatBody('<r><a>1</a><b>2</b></r>').body.split('\n'));
  assert.ok(blockLines(call, 'response-body').length > 1, 'XML was pretty-printed');
  assert.deepEqual(blockLines(call, 'request-headers'), ['{', '  "Accept": "x",', '  "Authorization": "y"', '}']);
});

test('add_comment by line number: prefix, block and the line\'s own text', async () => {
  const w = await world();
  try {
    const r = await w.call('add_comment', { callId: IN2, block: 'response-body', line: 2, comment: 'payment provider down' });
    assert.equal(r.isError, false, r.text);
    const posted = w.fake.requests('POST', '/comments')[0].body;
    assert.equal(posted.block, 'response-body');
    assert.equal(posted.lineIndex, 1);
    assert.equal(posted.lineText, '  "error": "payment failed"');
    assert.equal(posted.comment, '🤖 Claude: payment provider down');
    const list = await w.call('list_comments', { callId: IN2 });
    assert.equal(list.json.comments[0].byClaude, true);
    assert.equal(list.json.comments[0].line, 2);
  } finally { await w.close(); }
});

test('add_comment by text finds the line; a missing text is a clear error', async () => {
  const w = await world();
  try {
    const r = await w.call('add_comment', { callId: IN1, block: 'request-body', lineMatch: 'DXB', comment: 'route' });
    assert.match(r.json.lineText, /DXB/);
    const missing = await w.call('add_comment', { callId: IN1, block: 'request-body', lineMatch: 'nowhere-to-be-found', comment: 'x' });
    assert.equal(missing.json.error, 'invalid');
    const tooFar = await w.call('add_comment', { callId: IN1, block: 'request-body', line: 999, comment: 'x' });
    assert.equal(tooFar.json.error, 'invalid');
  } finally { await w.close(); }
});

test('delete_comment removes it; an unknown id is not_found', async () => {
  const w = await world();
  try {
    const added = await w.call('add_comment', { callId: IN1, comment: 'temp' });
    const del = await w.call('delete_comment', { commentId: added.json.id });
    assert.equal(del.json.deleted, true);
    assert.equal((await w.call('list_comments', { callId: IN1 })).json.comments.length, 0);
    assert.equal((await w.call('delete_comment', { commentId: added.json.id })).json.error, 'not_found');
  } finally { await w.close(); }
});
