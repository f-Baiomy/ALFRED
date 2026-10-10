import { Block, Inline, inlines, markdownBlocks, plainText } from './markdown-blocks';

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
    expect(blocks).toEqual([{ kind: 'code', text: 'SELECT *\n  FROM t' }]);
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
});
