import { Block, Inline, inlines, jsonTokens, markdownBlocks, markdownSections, plainText } from './markdown-blocks';

describe('markdownBlocks', () => {
  it('reads headings with their slug, paragraphs and both kinds of list', () => {
    const blocks = markdownBlocks('# ODY-482\nIntro text\nsecond line\n\n## Acceptance\n1. one\n2. two\n\n- a\n- b');
    expect(blocks.map((b) => b.kind)).toEqual(['heading', 'paragraph', 'heading', 'list', 'list']);
    expect((blocks[2] as Extract<Block, { kind: 'heading' }>).slug).toBe('acceptance');
    expect((blocks[3] as Extract<Block, { kind: 'list' }>).ordered).toBeTrue();
    expect((blocks[4] as Extract<Block, { kind: 'list' }>).items.map(plainText)).toEqual(['a', 'b']);
    expect(plainText((blocks[1] as Extract<Block, { kind: 'paragraph' }>).inlines)).toBe('Intro text\nsecond line');
  });

  it('keeps a fenced code block verbatim', () => {
    const blocks = markdownBlocks('```\nSELECT *\n  FROM t\n```');
    expect(blocks).toEqual([{ kind: 'code', text: 'SELECT *\n  FROM t', lang: '', json: null }]);
  });

  it('reads a table', () => {
    const blocks = markdownBlocks('| a | b |\n|---|---|\n| 1 | 2 |');
    const table = blocks[0] as Extract<Block, { kind: 'table' }>;
    expect(table.header.map(plainText)).toEqual(['a', 'b']);
    expect(table.rows[0].map(plainText)).toEqual(['1', '2']);
  });

  it('reads inline code, bold and italic', () => {
    const nodes = inlines('a `x` **b** *c*');
    expect(nodes.map((n) => n.kind)).toEqual(['text', 'code', 'text', 'bold', 'text', 'italic']);
  });

  it('leaves underscores inside a word alone - a table or column name is not emphasis', () => {
    expect(plainText(inlines('N+1 on TT_TS_AIRLINES_AUDIT_HISTORY and AUTOMATIC_REFUND_REQUESTS'))).toBe('N+1 on TT_TS_AIRLINES_AUDIT_HISTORY and AUTOMATIC_REFUND_REQUESTS');
    expect(inlines('snake_case_name').map((n) => n.kind)).toEqual(['text']);
    expect(inlines('an _italic_ word, a __bold__ one').map((n) => n.kind)).toEqual(['text', 'italic', 'text', 'bold', 'text']);
    expect(inlines('(_x_)').map((n) => n.kind)).toEqual(['text', 'italic', 'text']);
  });

  it('keeps only http(s) links and leaves the rest as text', () => {
    expect(inlines('[ok](https://example.com)')[0].kind).toBe('link');
    const bad = inlines('[x](javascript:alert(1))');
    expect(bad.every((n) => n.kind !== 'link')).toBeTrue();
    expect(plainText(bad)).toContain('javascript:');
  });

  it('turns mentions into nodes, inside paragraphs and lists, even when their label holds Markdown', () => {
    const blocks = markdownBlocks('see @[stmt:a/88|INSERT **#88**]\n\n- @[cycle:c|order-flow]');
    const para = (blocks[0] as Extract<Block, { kind: 'paragraph' }>).inlines;
    expect(para[1]).toEqual({ kind: 'mention', ref: { type: 'stmt', ref: 'a/88', label: 'INSERT **#88**' } } as Inline);
    expect((blocks[1] as Extract<Block, { kind: 'list' }>).items[0][0].kind).toBe('mention');
  });

  it('never makes markup out of HTML: a script tag stays literal text', () => {
    const blocks = markdownBlocks('<script>alert(1)</script>');
    expect(plainText((blocks[0] as Extract<Block, { kind: 'paragraph' }>).inlines)).toBe('<script>alert(1)</script>');
  });

  it('pretty-prints and colours a json block, keeping every character', () => {
    const block = markdownBlocks('```json\n{"status":405,"ok":false,"path":"/a","x":null}\n```')[0] as Extract<Block, { kind: 'code' }>;
    expect(block.text).toBe('{\n  "status": 405,\n  "ok": false,\n  "path": "/a",\n  "x": null\n}');
    expect(block.json!.map((t) => t.text).join('')).toBe(block.text);
    expect(block.json!.filter((t) => t.kind).map((t) => t.kind)).toEqual(['key', 'number', 'key', 'bool', 'key', 'string', 'key', 'null']);
  });

  it('leaves a json block that does not parse, and any other language, as written', () => {
    const broken = markdownBlocks('```json\n{"a":\n```')[0] as Extract<Block, { kind: 'code' }>;
    expect(broken.json).toBeNull();
    expect(broken.text).toBe('{"a":');
    expect((markdownBlocks('```sql\nSELECT 1\n```')[0] as Extract<Block, { kind: 'code' }>).lang).toBe('sql');
  });

  it('reads "> a · b · c" as facts with a tone, and any other quote as a quote', () => {
    const blocks = markdownBlocks('> 405 x 5 in 6 s · no log line · flow stops at search · Galileo\n\n> just a note');
    const facts = blocks[0] as Extract<Block, { kind: 'facts' }>;
    expect(facts.facts.map((f) => [plainText(f.inlines), f.tone])).toEqual([
      ['405 x 5 in 6 s', 'bad'], ['no log line', 'warn'], ['flow stops at search', 'warn'], ['Galileo', null],
    ]);
    expect(blocks[1].kind).toBe('quote');
  });

  it('ends a paragraph at a quote line', () => {
    expect(markdownBlocks('Summary\n> a · b').map((b) => b.kind)).toEqual(['paragraph', 'facts']);
  });

  it('groups blocks into sections at each heading, a "Next" section being the callout', () => {
    const sections = markdownSections(markdownBlocks('Summary\n\n### Evidence\n- x\n\n### Next\nDeploy it.'));
    expect(sections.map((s) => [s.blocks.map((b) => b.kind), s.callout])).toEqual([
      [['paragraph'], false], [['heading', 'list'], false], [['heading', 'paragraph'], true],
    ]);
  });

  it('keeps JSON tokens lossless for escaped quotes', () => {
    const text = '{\n  "a\\"b": "c\\"d"\n}';
    expect(jsonTokens(text).map((t) => t.text).join('')).toBe(text);
  });
});
