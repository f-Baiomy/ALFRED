import { infoAttrs, niceTicks, parseActions, parseChart, parseStats, parseTimeline, visualLangOf } from './board-visuals';
import { Block, markdownBlocks } from './markdown-blocks';
import { blocksToHtml, blocksToMarkdown, blocksToPlain, htmlBlocks, mentionsOfBlocks, textAsMarkdown } from './rich-html';
import { layout } from '../../components/board/visuals/chart-block.component';

describe('board-visuals parsers', () => {
  it('reads stats lines with optional colour and note, and says what is wrong', () => {
    const p = parseStats('Median | 2380 → 610 ms | green | ▼ 74%\nErrors | 0 → 0\n# a comment');
    expect(p.error).toBeNull();
    expect(p.model).toEqual([
      { label: 'Median', value: '2380 → 610 ms', color: 'green', note: '▼ 74%' },
      { label: 'Errors', value: '0 → 0', color: null, note: '' },
    ]);
    expect(parseStats('just words').error).toContain('label | value');
    expect(parseStats('').error).toContain('No stats');
  });

  it('reads a chart in the long and the short form, with a target line and per-bar colours', () => {
    const long = parseChart('{"type":"bar","labels":["a","b"],"series":[{"name":"x","values":[1,2],"color":"red"}],"line":{"at":1.5,"label":"t"},"unit":"ms"}');
    expect(long.error).toBeNull();
    expect(long.model!.series[0].color).toBe('#f87171');
    expect(long.model!.line).toEqual({ at: 1.5, label: 't' });
    const short = parseChart('{"type":"hbar","labels":["a","b","c"],"values":[3,2,1],"colors":["red","green","amber"]}');
    expect(short.model!.series[0].colors).toEqual(['#f87171', '#34d399', '#fbbf24']);
    expect(parseChart('not json').error).toContain('JSON');
    expect(parseChart('{"type":"donut","values":[1]}').error).toContain('type is one of');
    expect(parseChart('{"type":"bar"}').error).toContain('needs values');
  });

  it('fills missing labels so every value has one', () => {
    expect(parseChart('{"type":"line","values":[1,2,3]}').model!.labels).toEqual(['1', '2', '3']);
  });

  it('draws bars inside the chart area and the target where its value is', () => {
    const spec = parseChart('{"type":"bar","labels":["a","b"],"series":[{"name":"x","values":[100,50]}],"line":{"at":50,"label":"t"}}').model!;
    const l = layout(spec);
    expect(l.rects.length).toBe(2);
    expect(l.rects[0].h).toBeGreaterThan(l.rects[1].h);
    expect(Math.round(l.target!.y1)).toBe(Math.round(l.rects[1].y));
    expect(layout(parseChart('{"type":"pie","labels":["a","b"],"values":[1,3]}').model!).paths.length).toBe(2);
    expect(layout(parseChart('{"type":"line","labels":["a","b"],"values":[1,3]}').model!).dots.length).toBe(2);
  });

  it('chooses round ticks', () => {
    expect(niceTicks(2950)).toEqual([0, 1000, 2000, 3000]);
    expect(niceTicks(9)).toEqual([0, 2.5, 5, 7.5, 10]);
    expect(niceTicks(0)).toEqual([0]);
  });

  it('reads a timeline and its end', () => {
    const t = parseTimeline('unit: ms\ncall | 0 | 2400 | purple\nhash | 40 | 740 | red');
    expect(t.model!.end).toBe(2400);
    expect(t.model!.rows[1].color).toBe('#f87171');
    expect(parseTimeline('a | x | 1').error).toContain('label | start | length');
  });

  it('knows which fences are visuals and reads their attributes', () => {
    expect(visualLangOf('chart', '')).toBe('chart');
    expect(visualLangOf('html', 'live name="x"')).toBe('html');
    expect(visualLangOf('html', '')).toBeNull();
    expect(visualLangOf('sql', '')).toBeNull();
    expect(infoAttrs('live name="Fare dashboard" libs=\'echarts@5\' height=300')).toEqual({ name: 'Fare dashboard', libs: 'echarts@5', height: '300' });
  });

  it('reads action chips', () => {
    expect(parseActions('[action: retest | Re-test now] [action: run /alfred-fix 33]')).toEqual([
      { kind: 'retest', arg: '', label: 'Re-test now' }, { kind: 'run', arg: '/alfred-fix 33', label: 'run /alfred-fix 33' }]);
  });
});

describe('visual blocks in Markdown and HTML', () => {
  const md = [
    '**Summary** with {green|4× faster} and {red|**slow**}',
    '```stats\nMedian | 610 ms | green\n```',
    '```chart\n{"type":"bar","values":[1,2]}\n```',
    '[progress: 3/9 re-tested]',
    ':::tabs\n## Before\nold\n## After\nnew @[call:in:a1|POST /x]\n:::',
    '[choose: Per rule | Per session | Not now]',
    '[action: retest | Re-test now]',
    '!@[call:in:a2|POST /y · 200]',
    '```html live name="x"\n<b>hi</b>\n```',
  ].join('\n\n');

  it('parses every new block kind', () => {
    const kinds = markdownBlocks(md).map((b) => b.kind);
    expect(kinds).toEqual(['paragraph', 'visual', 'visual', 'progress', 'tabs', 'choices', 'actions', 'callview', 'visual']);
    const para = markdownBlocks(md)[0] as Extract<Block, { kind: 'paragraph' }>;
    expect(para.inlines.filter((i) => i.kind === 'color').length).toBe(2);
  });

  it('a line block ends the paragraph above it', () => {
    expect(markdownBlocks('text above\n[progress: 1/2]').map((b) => b.kind)).toEqual(['paragraph', 'progress']);
  });

  it('round-trips through the stored HTML without losing anything', () => {
    const blocks = markdownBlocks(md);
    const html = blocksToHtml(blocks);
    expect(html).toContain('<pre data-lang="chart">');
    expect(html).toContain('<pre data-lang="html" data-info="live name=&quot;x&quot;">');
    expect(html).toContain('<section data-tabs="">');
    expect(html).toContain('<span data-color="green">');
    expect(blocksToHtml(htmlBlocks(html))).toBe(html);
    expect(htmlBlocks(html).map((b) => b.kind)).toEqual(blocks.map((b) => b.kind));
  });

  it('converts back to the same Markdown Claude wrote', () => {
    const again = textAsMarkdown(blocksToHtml(markdownBlocks(md)));
    expect(again).toContain('{green|4× faster}');
    expect(again).toContain('```chart\n{"type":"bar","values":[1,2]}\n```');
    expect(again).toContain('```html live name="x"');
    expect(again).toContain(':::tabs\n## Before\nold\n## After');
    expect(again).toContain('[progress: 3/9 re-tested]');
    expect(again).toContain('[choose: Per rule | Per session | Not now]');
    expect(again).toContain('[action: retest | Re-test now]');
    expect(again).toContain('!@[call:in:a2|POST /y · 200]');
    expect(markdownBlocks(again).map((b) => b.kind)).toEqual(markdownBlocks(md).map((b) => b.kind));
  });

  it('keeps mentions inside tabs and expanded calls in the mention list', () => {
    expect(mentionsOfBlocks(markdownBlocks(md)).map((m) => m.ref)).toEqual(['in:a1', 'in:a2']);
  });

  it('writes plain text for copy and search', () => {
    const plain = blocksToPlain(markdownBlocks(md));
    expect(plain).toContain('3/9 re-tested');
    expect(plain).toContain('Per rule / Per session / Not now');
    expect(plain).toContain('POST /y · 200');
  });

  it('a snippet source stays text in the HTML - never markup', () => {
    const html = blocksToHtml(markdownBlocks('```html live\n<script>alert(1)</script>\n```'));
    expect(html).toBe('<pre data-lang="html" data-info="live">&lt;script&gt;alert(1)&lt;/script&gt;</pre>');
  });
});
