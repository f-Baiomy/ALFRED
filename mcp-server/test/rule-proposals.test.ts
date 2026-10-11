import assert from 'node:assert/strict';
import { test } from 'node:test';
import { draftFromCall, previewMatch, recipeActions, ruleMatch } from '../src/tools/rule-proposals.ts';
import type { CallRecord } from '../src/frontend.ts';
import { world } from './harness.ts';

const call = (source: 'external' | 'internal', method: string, url: string, service: string | null = null) =>
  ({ id: url, source, method, url, service_name: service, timestamp: '2026-10-11T10:00:00Z', response: { status: 200 } }) as unknown as CallRecord;

test('the preview catches only calls of the rule\'s direction, project, method, host and path', () => {
  const calls = [
    call('external', 'POST', 'https://api.galileo.com/search?x=1', 'odeysys'),
    call('external', 'GET', 'https://api.galileo.com/search'),
    call('external', 'POST', 'https://api.sabre.com/search'),
    call('internal', 'POST', '/odeysysadmin/search', 'odeysys'),
  ];
  const base = { source: 'outbound' as const, projects: [], methods: [], pathContains: '/search' };
  assert.equal(previewMatch({ ...base, host: '*.galileo.com' }, calls).length, 2);
  assert.equal(previewMatch({ ...base, host: 'api.galileo.com', methods: ['post'] }, calls).length, 1);
  assert.equal(previewMatch({ ...base, host: 'api.galileo.com', pathRegex: 'x=\\d' }, calls).length, 1);
  assert.equal(previewMatch({ source: 'inbound', projects: ['odeysys'], methods: [], pathContains: '/search' }, calls).length, 1);
});

test('recipes become valid backend actions, and a draft takes the call\'s own direction, host and path', () => {
  assert.deepEqual(recipeActions({ kind: 'status', status: 500 }), [{ type: 'MOCK_RESPONSE', status: 500, body: '' }]);
  assert.deepEqual(recipeActions({ kind: 'slow', ms: 8000 }), [{ type: 'DELAY_REQUEST', durationMs: 8000 }]);
  assert.deepEqual(recipeActions({ kind: 'drop_field', path: '$.price' }), [{ type: 'REMOVE_RESPONSE_JSON_FIELD', path: '$.price' }]);
  assert.deepEqual(recipeActions({ kind: 'recorded', callId: 'c', direction: 'outbound' }, 'a1'), [{ type: 'ANSWER_WITH_RECORDED_CALL', answerId: 'a1' }]);

  const draft = draftFromCall(call('external', 'POST', 'https://api.galileo.com/air/search?pcc=X', 'odeysys'));
  assert.deepEqual(draft.match, { source: 'outbound', projects: ['odeysys'], methods: ['POST'], host: 'api.galileo.com', pathContains: '/air/search' });
  assert.deepEqual(ruleMatch(draft.match), { source: 'outbound', serviceNames: ['odeysys'], methods: ['POST'], host: 'api.galileo.com', pathContains: '/air/search' });
});

test('create_rule proposes the rule as Claude, refuses a broad one, and links it to the card with a comment', async () => {
  const w = await world();
  try {
    const broad = await w.call('create_rule', { name: 'All', match: { source: 'outbound' }, recipe: { kind: 'status', status: 500 }, reason: 'x' });
    assert.equal(broad.isError, true);
    assert.match(broad.text, /host or a project/);

    await w.call('board_add', { project: 'p', kind: 'BUG', title: 'Blank list on 500' });
    const r = await w.call('create_rule', {
      name: 'Galileo search 500', match: { source: 'outbound', host: 'api.galileo.com', pathContains: '/search' },
      recipe: { kind: 'status', status: 500 }, reason: 'Reproduce #1', card: { project: 'p', number: 1 },
    });
    assert.equal(r.isError, false, r.text);
    assert.match(r.json.state, /^off/);
    const sent = w.fake.requests('POST', '/interception/rules')[0];
    assert.equal(sent.headers?.['x-alfred-actor'], 'claude');
    assert.equal(sent.body.enabled, false);
    assert.equal(sent.body.card, 'p#1');
    assert.deepEqual(sent.body.actions, [{ type: 'MOCK_RESPONSE', status: 500, body: '' }]);
    assert.equal(w.fake.requests('POST', '/board/cards/card-1/links')[0].body.type, 'rule');
    assert.match(w.fake.requests('POST', '/board/cards/card-1/comments')[0].body.reply, /@\[rule:rule-1\|Galileo search 500\] \(off\)/);
  } finally { await w.close(); }
});

test('a recorded answer is copied with its secrets stripped before the rule is proposed', async () => {
  const w = await world();
  try {
    const r = await w.call('create_rule', {
      name: 'Old search answer', match: { source: 'outbound', host: 'api.galileo.com', pathContains: '/search' },
      recipe: { kind: 'recorded', callId: 'c9', direction: 'outbound' }, reason: 'Replay a good answer',
    });
    assert.equal(r.isError, false, r.text);
    assert.equal(w.fake.requests('POST', '/interception/answers/from-call')[0].body.keepSecrets, false);
    assert.deepEqual(w.fake.requests('POST', '/interception/rules')[0].body.actions, [{ type: 'ANSWER_WITH_RECORDED_CALL', answerId: 'answer-1' }]);
  } finally { await w.close(); }
});
