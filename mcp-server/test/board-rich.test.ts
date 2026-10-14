import assert from 'node:assert/strict';
import { test } from 'node:test';
import { world } from './harness.ts';

test('a rich text (HTML) description and comment reach Claude as compact Markdown, mentions kept', async () => {
  const w = await world();
  try {
    await w.call('board_add', { project: 'p', kind: 'BUG', title: 'x',
      description: '<h3>Root cause</h3><p><b>NULL</b> discount for <span data-mention="call:in:a1">@[call:in:a1|POST /orders]</span></p><ul data-checklist><li data-checked="true">reproduced</li></ul>' });
    w.fake.board.activity['card-1'] = [{ id: 7, kind: 'COMMENT', actor: 'USER', at: '2026-10-14T09:00:00Z', text: '<p>ممكن تشوف <mark>الخصم</mark>?</p>', oldValue: null, newValue: null }];
    const r = await w.call('board_get', { project: 'p', number: 1 });
    assert.equal(r.isError, false, r.text);
    assert.doesNotMatch(r.text, /<h3>|<p>|<mark>/);
    assert.match(r.text, /### Root cause/);
    assert.match(r.text, /\*\*NULL\*\* discount/);
    assert.match(r.text, /@\[call:in:a1\|POST \/orders\]/);
    assert.match(r.text, /- \[x\] reproduced/);
    assert.match(r.text, /ممكن تشوف ==الخصم==\?/);
  } finally { await w.close(); }
});

test('a ✅ reaction from the user on Claude\'s comment reads as the go-ahead', async () => {
  const w = await world();
  try {
    await w.call('board_add', { project: 'p', kind: 'BUG', title: 'x' });
    w.fake.board.activity['card-1'] = [
      { id: 1, kind: 'COMMENT', actor: 'CLAUDE', at: '2026-10-14T09:00:00Z', text: '**Next** change the mapper', oldValue: null, newValue: null },
      { id: 2, kind: 'REACTION', actor: 'USER', at: '2026-10-14T09:01:00Z', text: '✅', oldValue: null, newValue: null, replyTo: 1 },
    ];
    const r = await w.call('board_get', { project: 'p', number: 1 });
    assert.match(r.text, /User reacted ✅ = GO: the user approves - go ahead/);
  } finally { await w.close(); }
});

test('board_image returns the picture itself, by id or by its path', async () => {
  const w = await world();
  try {
    const r = await w.call('board_image', { id: '![shot](/board/images/1234abcd-ef)' });
    assert.equal(r.isError, false, r.text);
    assert.equal(w.fake.requests('GET', '/board/images/1234abcd-ef').length, 1);
    const gone = await w.call('board_image', { id: 'gone-0000' });
    assert.equal(gone.isError, true);
  } finally { await w.close(); }
});
