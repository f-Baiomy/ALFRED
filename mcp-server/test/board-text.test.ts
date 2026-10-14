import '../src/dom-shim.ts';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { boardText } from '../src/board-text.ts';
import { cells } from '../../frontend/src/app/shared/utils/markdown-blocks.ts';
import { world } from './harness.ts';

test('Markdown with no tags is sent exactly as written', () => {
  const md = '**Summary** 2 calls\n\n| a | b |\n| --- | --- |\n| 1 | 2 |\n\n```stats\nCalls | 2 | green\n```\n\nList<String> is fine, a < b too';
  assert.deepEqual(boardText(md), { text: md, snippets: 0 });
});

test('an HTML table after a Markdown sentence becomes a board table, the sentences kept', () => {
  const t = boardText('Neither call stalled.\n\n<table><thead><tr><th>Call</th><th>Status</th></tr></thead>\n<tbody><tr><td>@[call:in:a1|GET /x]</td>'
    + '<td><span style="color:green">200</span></td></tr></tbody></table>\n<p><i>The card stays closed.</i></p>\n\nIf the table renders, HTML works.');
  assert.equal(t.snippets, 0);
  assert.equal(t.text, 'Neither call stalled.\n\n| Call | Status |\n| --- | --- |\n| @[call:in:a1|GET /x] | {green\\|200} |\n\n'
    + '*The card stays closed.*\n\nIf the table renders, HTML works.');
  // the board reads it back as one table whose cells are the mention and the colour
  const rows = t.text.split('\n').filter((l) => l.startsWith('| @'));
  assert.deepEqual(cells(rows[0]), ['@[call:in:a1|GET /x]', '{green|200}']);
});

test('a text that is all HTML (callout, fold, list) becomes board Markdown', () => {
  const t = boardText('<aside data-callout="bug"><b>Root cause</b><p>NULL discount</p></aside>\n<details><summary>SQL</summary><pre data-lang="sql">SELECT 1</pre></details>\n<ul><li>one</li><li>two</li></ul>');
  assert.match(t.text, /> \[!BUG\] Root cause\n> NULL discount/);
  assert.match(t.text, /\+\+\+ SQL\n```sql\nSELECT 1\n```\n\+\+\+/);
  assert.match(t.text, /- one\n- two/);
});

test('HTML that needs a page (script, style, SVG) becomes an html live snippet, byte for byte', () => {
  const html = '<div id="c"></div>\n<style>#c{color:red}</style>\n\n<script>\nif (1 < 2) document.getElementById("c").textContent = "ok";\n</script>';
  const t = boardText(`**Chart** below\n\n${html}\n\nDone.`);
  assert.equal(t.snippets, 1);
  assert.equal(t.text, `**Chart** below\n\n\`\`\`html live\n${html}\n\`\`\`\n\nDone.`);
  assert.equal(boardText('<svg viewBox="0 0 10 10"><circle r="4"/></svg>').snippets, 1);
  // motion only in a style attribute still moves: it runs in the frame, not as board text
  const moving = '<div style="animation: spin 1s infinite">⟳</div>';
  assert.deepEqual(boardText(moving), { text: '```html live\n' + moving + '\n```', snippets: 1 });
  assert.equal(boardText('<p style="color:red">red</p>').snippets, 0);
});

test('inline tags in a Markdown line become Markdown; code spans and fences are left alone', () => {
  assert.equal(boardText('- status <b>500</b> on <span data-color="red">checkout</span> **twice**').text, '- status **500** on {red|checkout} **twice**');
  assert.equal(boardText('use `<b>` for bold').text, 'use `<b>` for bold');
  const fenced = '```html live\n<script>alert(1)</script>\n```\n\n```xml\n<order><id>1</id></order>\n```';
  assert.deepEqual(boardText(fenced), { text: fenced, snippets: 0 });
});

test('an HTML part never closed ends at the next blank line', () => {
  const t = boardText('<p>open\n\n**Next** step');
  assert.equal(t.text, 'open\n\n**Next** step');
});

test('board_reply, board_comment and board_add send board text, and say when a snippet was made', async () => {
  const w = await world();
  try {
    await w.call('board_add', { project: 'p', kind: 'BUG', title: 'x', description: 'Seen:\n<ul><li>one</li></ul>' });
    assert.equal(w.fake.board.cards[0].description, 'Seen:\n\n- one');
    const r = await w.call('board_reply', { project: 'p', number: 1, text: 'Here:\n<table><tr><th>a</th></tr><tr><td>1</td></tr></table>' });
    assert.equal(r.isError, false, r.text);
    const c = await w.call('board_comment', { project: 'p', number: 1, did: 'ran <b>it</b>', found: '<script>x()</script>', next: 'wait' });
    assert.match(c.text, /board_snippet_view/);
    const texts = (w.fake.board.activity['card-1'] ?? []).map((e: { text: string }) => e.text).join('\n');
    assert.match(texts, /\| a \|\n\| --- \|\n\| 1 \|/);
    assert.match(texts, /ran \*\*it\*\*/);
    assert.match(texts, /```html live\n<script>x\(\)<\/script>\n```/);
  } finally {
    await w.close();
  }
});
