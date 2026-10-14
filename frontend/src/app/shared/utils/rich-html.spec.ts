import { codeTokens, guessLang } from './code-highlight';
import { Block, markdownBlocks } from './markdown-blocks';
import {
  blocksToHtml, blocksToMarkdown, hasFormatting, htmlBlocks, isHtml, mentionsOfBlocks, textAsMarkdown, textAsPlain, textBlocks,
} from './rich-html';
import { inlineWords, textDir } from './text-direction';

describe('rich-html', () => {
  it('tells HTML from Markdown by its first block tag', () => {
    expect(isHtml('<p>hi</p>')).toBeTrue();
    expect(isHtml('  <H3>x</H3>')).toBeTrue();
    expect(isHtml('**Did** <b>not</b> html')).toBeFalse();
    expect(isHtml('a < b')).toBeFalse();
    expect(isHtml(null)).toBeFalse();
  });

  it('round-trips the canonical HTML through the block tree unchanged', () => {
    const html = blocksToHtml(htmlBlocks(
      '<h3>Root cause</h3><p><b>NULL</b> discount, <mark>key</mark> <span data-pill="fail">FAIL</span></p>'
      + '<ul data-checklist><li data-checked="true">reproduced</li><li>fixed</li></ul>'
      + '<pre data-lang="sql">SELECT 1</pre><aside data-callout="next"><b>Next</b><p>deploy</p></aside>'
      + '<details><summary>All 3</summary><p>a</p></details>'));
    expect(blocksToHtml(htmlBlocks(html))).toBe(html);
    expect(html).toContain('<h3');
    expect(html).toContain('data-checklist');
    expect(html).toContain('data-lang="sql"');
    expect(html).toContain('data-callout="next"');
  });

  it('drops anything that could run or load from elsewhere', () => {
    const blocks = htmlBlocks('<p onclick="x()">hi<script>alert(1)</script><img src="https://evil/x.png" onerror="x()"></p>'
      + '<iframe src="https://evil"></iframe><p><a href="javascript:alert(1)">link</a><img src="/board/images/abcd1234-ef"></p>');
    const out = blocksToHtml(blocks);
    expect(out).not.toMatch(/script|onclick|onerror|iframe|javascript:|evil/);
    expect(out).toContain('hi');
    expect(out).toContain('/board/images/abcd1234-ef');
  });

  it('keeps mentions and variables as their text form inside the HTML', () => {
    const blocks = htmlBlocks('<p>see <span data-mention="1">@[call:in:a1|POST /orders · 500]</span> on {{baseUrl}}</p>');
    expect(mentionsOfBlocks(blocks).map((m) => m.ref)).toEqual(['in:a1']);
    const html = blocksToHtml(blocks);
    expect(html).toContain('@[call:in:a1|POST /orders · 500]');
    expect(html).toContain('{{baseUrl}}');
    expect(textAsPlain(html)).toBe('see POST /orders · 500 on {{baseUrl}}');
  });

  it('reads Claude\'s extended Markdown: callouts, folds, checklists, pills, highlight', () => {
    const blocks = markdownBlocks('**Summary**\n\n> [!NEXT] Deploy\n> then re-test\n\n+++ All 3\nfirst\n+++\n\n- [x] done\n- [ ] open\n\nState [fail: 405 × 5] and ==key==');
    const kinds = blocks.map((b) => b.kind);
    expect(kinds).toContain('callout');
    expect(kinds).toContain('fold');
    const list = blocks.find((b) => b.kind === 'list') as Extract<Block, { kind: 'list' }>;
    expect(list.checks).toEqual([true, false]);
    expect(blocksToHtml(blocks)).toContain('data-pill="fail"');
    expect(blocksToHtml(blocks)).toContain('<mark>key</mark>');
  });

  it('converts HTML to the Markdown Claude reads, and Markdown stays as written', () => {
    const md = textAsMarkdown('<h3>Why</h3><p><b>NULL</b> <s>was</s> <mark>is</mark></p><ul data-checklist><li data-checked="true">a</li></ul>');
    expect(md).toContain('### Why');
    expect(md).toContain('**NULL**');
    expect(md).toContain('~~was~~');
    expect(md).toContain('==is==');
    expect(md).toContain('- [x] a');
    expect(textAsMarkdown('**Did** x')).toBe('**Did** x');
  });

  it('formatting is what opens the editor rich; plain words with mentions stay plain', () => {
    expect(hasFormatting('just words @[call:in:a|x]')).toBeFalse();
    expect(hasFormatting('### heading')).toBeTrue();
    expect(hasFormatting('<p>x</p>')).toBeTrue();
  });

  it('gives every block type its own direction - Arabic, English and both mixed', () => {
    const blocks = textBlocks('<h3>سبب المشكلة</h3><p>The discount is NULL</p>'
      + '<aside data-callout="warn"><b>تنبيه</b><p>الـsearch بيرجع POST /orders غلط</p></aside>'
      + '<ul><li>first item</li><li>العنصر التاني</li></ul><table><tbody><tr><td>القيمة</td><td>value</td></tr></tbody></table>');
    const heading = blocks[0] as Extract<Block, { kind: 'heading' }>;
    const para = blocks[1] as Extract<Block, { kind: 'paragraph' }>;
    const callout = blocks[2] as Extract<Block, { kind: 'callout' }>;
    const list = blocks[3] as Extract<Block, { kind: 'list' }>;
    const table = blocks[4] as Extract<Block, { kind: 'table' }>;
    expect(textDir(inlineWords(heading.inlines))).toBe('rtl');
    expect(textDir(inlineWords(para.inlines))).toBe('ltr');
    const inner = callout.blocks[0] as Extract<Block, { kind: 'paragraph' }>;
    expect(textDir(inlineWords(inner.inlines))).toBe('rtl'); // starts with an English-looking word, still Arabic
    expect(textDir(inlineWords(list.items[0]))).toBe('ltr');
    expect(textDir(inlineWords(list.items[1]))).toBe('rtl');
    const cells = table.rows.length ? table.rows[0] : table.header;
    expect(textDir(inlineWords(cells[0]))).toBe('rtl');
    expect(textDir(inlineWords(cells[1]))).toBe('ltr');
  });
});

describe('tables with mentions', () => {
  it('a mention in a cell keeps its label - escaped pipe or not - and the row keeps its columns', () => {
    for (const sep of ['|', '\\|']) {
      const md = `| Case | Call | Time |\n|---|---|---|\n| cold | @[call:in:66e1@e8fe${sep}13 Oct 00:51] | 2400 ms |`;
      const table = markdownBlocks(md)[0] as Extract<Block, { kind: 'table' }>;
      expect(table.rows[0].length).toBe(3);
      expect(mentionsOfBlocks([table]).map((m) => [m.ref, m.label])).toEqual([['in:66e1@e8fe', '13 Oct 00:51']]);
    }
  });

  it('an escaped pipe in text stays a pipe; a pipe in inline code stays in its cell', () => {
    const table = markdownBlocks('| a | b |\n|---|---|\n| x \\| y | `p|q` |')[0] as Extract<Block, { kind: 'table' }>;
    expect(table.rows[0].length).toBe(2);
    expect(blocksToMarkdown([table])).toContain('x');
  });
});

describe('code-highlight', () => {
  it('guesses the language of pasted text', () => {
    expect(guessLang('{"a": 1}')).toBe('json');
    expect(guessLang('SELECT * FROM t WHERE id = 1')).toBe('sql');
    expect(guessLang('<a><b/></a>')).toBe('xml');
    expect(guessLang('just words')).toBeNull();
  });

  it('tokenizes without losing a character', () => {
    const src = 'SELECT name FROM users -- who\nWHERE id = \'x\'';
    const tokens = codeTokens(src, 'sql')!;
    expect(tokens.map((t) => t.text).join('')).toBe(src);
    expect(tokens.some((t) => t.kind === 'keyword')).toBeTrue();
  });

  it('round-trips Markdown code blocks through HTML with their language', () => {
    const blocks = markdownBlocks('```sql\nSELECT 1\n```');
    expect(blocksToMarkdown(htmlBlocks(blocksToHtml(blocks)))).toContain('```sql');
  });
});
