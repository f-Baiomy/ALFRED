import { buildSnippetDoc, libsForDoc, scopeClassicScripts, SNIPPET_PALETTE, splitSnippetFiles } from './snippet-frame';
import { importMap, libsOf, SNIPPET_LIBS } from './snippet-libs';
import { SnippetBridge } from './snippet-bridge';
import { markdownBlocks } from './markdown-blocks';
import { blocksToHtml, htmlBlocks, textAsMarkdown } from './rich-html';

describe('snippet frame document', () => {
  const origin = 'http://alfred.test';

  it('gives every module library a name to import by', () => {
    const map = importMap(origin);
    expect(map['preact']).toBe(`${origin}/lib/preact/10/preact.module.js`);
    expect(map['htm/preact']).toBe(`${origin}/lib/htm/3/standalone.module.js`);
    expect(map['three']).toBe(`${origin}/lib/three/0.169/three.module.min.js`);
    expect(Object.values(map).every((u) => u.startsWith(`${origin}/lib/`))).toBeTrue();
  });

  it('reads libs="…" loosely and brings what goes with a library', () => {
    expect(libsOf('echarts@5, Chart.js').map((l) => l.id)).toEqual(['echarts', 'chartjs']);
    expect(libsOf('preact htm').map((l) => l.id)).toEqual(['preact', 'preact-hooks', 'htm', 'htm-preact']);
    expect(libsOf('highlight').map((l) => l.id)).toEqual(['highlight', 'highlight-css']);
    expect(libsOf('nope')).toEqual([]);
    expect(libsOf('plot').map((l) => l.id)).withContext('Observable Plot draws with D3').toEqual(['d3', 'plot']);
    expect(libsOf('gridjs apex anime.js').map((l) => l.id)).toEqual(['gridjs', 'gridjs-css', 'apexcharts', 'anime']);
    expect(SNIPPET_LIBS.every((l) => !l.file.includes('..'))).toBeTrue();
  });

  it('loads scripts and stylesheets, and leaves modules to the import map', () => {
    const doc = buildSnippetDoc({ source: '<p>x</p>', origin, libs: 'chartjs highlight preact tailwind' });
    expect(doc).toContain(`<script src="${origin}/lib/chartjs/4/chart.umd.js"></script>`);
    expect(doc).toContain(`<link rel="stylesheet" href="${origin}/lib/highlight/11/github-dark.min.css">`);
    expect(doc).toContain(`<script src="${origin}/lib/tailwind/4/index.mjs"></script>`);
    expect(doc).not.toContain('src="' + origin + '/lib/preact');
    expect(doc).toContain('"preact":"' + origin + '/lib/preact/10/preact.module.js"');
    expect(doc.endsWith('<body><p>x</p></body></html>')).toBeTrue();
  });

  it('can carry its libraries inline: scripts and styles in the page, modules as code for the import map', () => {
    const doc = buildSnippetDoc({
      source: '<p>x</p>', origin, libs: 'chartjs highlight preact',
      inline: {
        'chartjs/4/chart.umd.js': 'var Chart=1;"</script><script>alert(1)"',
        'highlight/11/highlight.min.js': 'var hljs=1', 'highlight/11/github-dark.min.css': '.x{}/*</style>*/',
        'preact/10/preact.module.js': 'export const h=1', 'preact/10/hooks.module.js': 'import {h} from "preact";export const useState=h',
      },
    });
    expect(doc).not.toContain(`src="${origin}/lib/`);
    expect(doc).not.toContain('<script type="importmap">');
    expect(doc).not.toContain('</script><script>alert(1)');
    expect(doc).not.toContain('/*</style>');
    const boot = JSON.parse(new DOMParser().parseFromString(doc, 'text/html').getElementById('alfred-boot')!.textContent!);
    expect(boot.direct).toBeFalse();
    expect(boot.inline).toEqual({ scripts: ['var Chart=1;"</script><script>alert(1)"', 'var hljs=1'], styles: ['.x{}/*</style>*/'] });
    expect(boot.modules).toEqual({ preact: 'export const h=1', 'preact/hooks': 'import {h} from "preact";export const useState=h' });
    expect(libsForDoc({ kind: 'mermaid' }).map((l) => l.id)).toEqual(['mermaid']);
  });

  it('runs a snippet whose libraries came inline, modules and all, in a real locked frame', async () => {
    const code = (f: string) => fetch(`/lib/${f}`).then((r) => r.text());
    const inline = {
      'dayjs/1/dayjs.min.js': await code('dayjs/1/dayjs.min.js'),
      'preact/10/preact.module.js': await code('preact/10/preact.module.js'),
      'preact/10/hooks.module.js': await code('preact/10/hooks.module.js'),
    };
    const source = '<div id="o"></div><script type="module">import { h, render } from "preact"; import { useState } from "preact/hooks";'
      + 'render(h("b", null, typeof useState + " " + typeof dayjs), document.getElementById("o"));'
      + 'parent.postMessage({ probe: "inline", v: document.getElementById("o").textContent }, "*");</script>';
    const frame = document.createElement('iframe');
    frame.setAttribute('sandbox', 'allow-scripts');
    const got = new Promise<string>((resolve) => {
      const on = (e: MessageEvent) => { if (e.source === frame.contentWindow && e.data?.probe === 'inline') { window.removeEventListener('message', on); resolve(e.data.v); } };
      window.addEventListener('message', on);
    });
    frame.srcdoc = buildSnippetDoc({ source, origin: location.origin, libs: 'dayjs preact', inline });
    document.body.appendChild(frame);
    expect(await got).toBe('function function');
    frame.remove();
  });

  /** A snippet run in a real locked frame; resolves with what it posts as `{probe, v}`. */
  async function probe(source: string, libs: string, files: string[], answer: (op: string, args: Record<string, unknown>) => unknown = () => null,
                       context: Record<string, unknown> = {}): Promise<unknown> {
    const inline: Record<string, string> = {};
    for (const f of files) inline[f] = await fetch(`/lib/${f}`).then((r) => r.text());
    const frame = document.createElement('iframe');
    frame.setAttribute('sandbox', 'allow-scripts');
    frame.style.cssText = 'width:400px;height:300px';
    const bridge = new SnippetBridge(frame, async (op, args) => answer(op, args), {});
    const got = new Promise<unknown>((resolve) => {
      const on = (e: MessageEvent) => { if (e.source === frame.contentWindow && e.data?.probe) { window.removeEventListener('message', on); resolve(e.data.v); } };
      window.addEventListener('message', on);
    });
    frame.srcdoc = buildSnippetDoc({ source, origin: location.origin, libs, inline, context });
    document.body.appendChild(frame);
    try {
      return await got;
    } finally {
      bridge.close();
      frame.remove();
    }
  }

  it('gives a classic script that names a window global (const top, var name) its own block, so it runs', async () => {
    expect(scopeClassicScripts('<script>const top = 1;</script>')).toBe('<script>{\nconst top = 1;\n}</script>');
    expect(scopeClassicScripts('<script>var name = [1];</script>')).toBe('<script>{\nlet name = [1];\n}</script>');
    const untouched = '<script>const rows = 1; function draw() {}</script><script type="module">const top = 1;</script><script src="./a.js"></script>';
    expect(scopeClassicScripts(untouched)).toBe(untouched);
    const v = await probe('<script>const top = [1, 2]; var name = [3]; function f() { return top.length + name.length; }'
      + 'parent.postMessage({ probe: 1, v: f() + typeof window.top }, "*");</script>', '', []);
    expect(v).toBe('3object');
  }, 20000);

  it('gives ECharts and Chart.js Alfred\'s dark theme and palette unless the snippet sets its own colours', async () => {
    const v = await probe('<div id="e" style="width:300px;height:200px"></div><canvas id="c"></canvas><script type="module">'
      + 'const e = echarts.init(document.getElementById("e")); e.setOption({ xAxis: { type: "category", data: ["a"] }, yAxis: {}, series: [{ type: "bar", data: [1] }] });'
      + 'const c = new Chart(document.getElementById("c"), { type: "bar", data: { labels: ["a"], datasets: [{ data: [1] }, { data: [2], backgroundColor: "#123456" }] } });'
      + 'parent.postMessage({ probe: 1, v: [e.getOption().color[0], c.data.datasets[0].borderColor, c.data.datasets[1].backgroundColor, '
      + 'alfred.palette[1], alfred.fmt.ms(1520), getComputedStyle(document.querySelector("#e")).boxSizing, e.getOption().grid[0].containLabel] }, "*");</script>',
      'echarts chartjs', ['echarts/5/echarts.min.js', 'chartjs/4/chart.umd.js']);
    expect(v).toEqual([SNIPPET_PALETTE[0], SNIPPET_PALETTE[0], '#123456', SNIPPET_PALETTE[1], '1.52 s', 'border-box', true]);
  }, 20000);

  it('alfred.calls() reads the calls of the cycle it is shown for, a card\'s snippet the live calls', async () => {
    const seen: unknown[] = [];
    const answer = (op: string, args: Record<string, unknown>) => { seen.push(args); return [{ ref: 'in:x' }]; };
    const src = '<script type="module">const rows = await alfred.calls({ endpoint: "GET /a" }); parent.postMessage({ probe: 1, v: rows.length }, "*");</script>';
    expect(await probe(src, '', [], answer, { cycleId: 'c-1', chat: 5 })).toBe(1);
    expect(await probe(src, '', [], answer, { cycleId: 'c-1', card: 12 })).toBe(1);
    expect(seen).toEqual([
      { src: 'calls', args: { limit: 1000, cycle: 'c-1', endpoint: 'GET /a' } },
      { src: 'calls', args: { limit: 1000, endpoint: 'GET /a' } },
    ]);
  }, 20000);

  it('a frame told its size late says ready only then - with its height first, and a picture of the whole page', async () => {
    // What made the picture tests flaky under load: the frame loaded before it knew its size, said ready, and drew 1 x 1.
    const frame = document.createElement('iframe');
    frame.setAttribute('sandbox', 'allow-scripts');
    frame.style.cssText = 'width:0;height:120px;border:0';
    const events: string[] = [];
    let height = 0;
    let bridge: SnippetBridge | null = null;
    const ready = new Promise<void>((resolve) => {
      bridge = new SnippetBridge(frame, async () => null, {
        size: (h) => { height = h; events.push('size'); },
        ready: () => { events.push('ready'); resolve(); },
      });
    });
    const loaded = new Promise((r) => frame.addEventListener('load', r, { once: true }));
    frame.srcdoc = buildSnippetDoc({ source: '<div style="height:60px;background:#f00">x</div>', origin: location.origin, inline: {} });
    document.body.appendChild(frame);
    await loaded;
    await new Promise((r) => setTimeout(r, 300));
    expect(events).withContext('no ready while the frame has no width').not.toContain('ready');
    frame.style.width = '300px';
    await ready;
    expect(events.indexOf('size')).toBeLessThan(events.indexOf('ready'));
    expect(height).toBeGreaterThan(60);
    const png = await bridge!.shot(10000);
    const img = new Image();
    await new Promise((r) => { img.onload = r; img.src = png; });
    expect(img.width).toBeGreaterThan(250);
    expect(img.height).toBeGreaterThan(60);
    bridge!.close();
    frame.remove();
  }, 20000);

  it('draws a PNG of itself inside the frame and hands it over the bridge; console lines and size come too', async () => {
    const frame = document.createElement('iframe');
    frame.setAttribute('sandbox', 'allow-scripts');
    frame.style.cssText = 'width:300px;height:120px';
    const logs: string[] = [];
    let height = 0;
    let frameBridge: SnippetBridge | null = null;
    const ready = new Promise<void>((resolve) => {
      const bridge = new SnippetBridge(frame, async (op, args) => {
        const lib = SNIPPET_LIBS.find((l) => l.id === args['id']);
        return op === 'lib' && lib ? fetch(`/lib/${lib.file}`).then((r) => r.text()) : null;
      }, { log: (_, t) => logs.push(t), size: (h) => (height = h), ready: () => resolve() });
      frameBridge = bridge;
    });
    frame.srcdoc = buildSnippetDoc({ source: '<div style="height:60px;background:#f00">x</div><script>console.log("hello")</script>', origin: location.origin, inline: {} });
    document.body.appendChild(frame);
    await ready;
    const png = await frameBridge!.shot(10000);
    expect(png.startsWith('data:image/png;base64,')).toBeTrue();
    const img = new Image();
    await new Promise((r) => { img.onload = r; img.src = png; });
    const c = document.createElement('canvas');
    c.width = img.width;
    c.height = img.height;
    const g = c.getContext('2d')!;
    g.drawImage(img, 0, 0);
    const k = img.width / 300;
    const [red, green] = g.getImageData(Math.round(30 * k), Math.round(30 * k), 1, 1).data;
    expect(red).toBeGreaterThan(200);
    expect(green).toBeLessThan(60);
    expect(logs).toContain('hello');
    expect(height).toBeGreaterThan(60);
    frameBridge!.close();
    frame.remove();
  }, 20000);

  it('draws a diagram with Mermaid in strict mode, its text escaped', () => {
    const doc = buildSnippetDoc({ source: 'flowchart LR\n A["<b>x</b>"] --> B', kind: 'mermaid', origin });
    expect(doc).toContain(`${origin}/lib/mermaid/11/mermaid.min.js`);
    expect(doc).toContain('securityLevel:"strict"');
    expect(doc).toContain('A["&lt;b&gt;x&lt;/b&gt;"]');
  });

  it('passes the direction, name and where it lives', () => {
    const doc = buildSnippetDoc({ source: '', origin, dir: 'rtl', name: 'Fare', context: { card: 12 } });
    expect(doc.startsWith('<!doctype html><html dir="rtl">')).toBeTrue();
    expect(doc).toContain('"name":"Fare"');
    expect(doc).toContain('"context":{"card":12}');
  });

  it('reads a whole text marked as a page as one page snippet', () => {
    const page = '<!-- alfred:page -->\n<h1>Dashboard</h1>\n<script>1</script>';
    const blocks = markdownBlocks(page);
    expect(blocks).toEqual([{ kind: 'visual', lang: 'html', info: 'live page', text: '<h1>Dashboard</h1>\n<script>1</script>' }]);
    const html = blocksToHtml(blocks);
    expect(html).toBe('<pre data-lang="html" data-info="live page">&lt;h1&gt;Dashboard&lt;/h1&gt;\n&lt;script&gt;1&lt;/script&gt;</pre>');
    expect(htmlBlocks(html)).toEqual(blocks);
    expect(markdownBlocks(textAsMarkdown(html))).toEqual(blocks);
    expect(markdownBlocks('text\n<!-- alfred:page -->').map((b) => b.kind)).not.toContain('visual');
  });
  describe('multi-file snippets (R26)', () => {
    const multi = [
      '<div id="o"></div><link rel="stylesheet" href="./look.css">',
      '<script src="./setup.js"></script>',
      '<script type="module">import { label } from "./label.js"; document.getElementById("o").textContent = label(alfred.file("rows.csv"));',
      'parent.postMessage({ probe: "multi", v: document.getElementById("o").textContent, color: getComputedStyle(document.getElementById("o")).color, setup: window.SETUP }, "*");</script>',
      '--- label.js',
      'import { count } from "./count.js";',
      'export const label = (csv) => "rows: " + count(csv);',
      '--- count.js',
      'export const count = (csv) => csv.trim().split(String.fromCharCode(10)).length - 1;',
      '--- look.css',
      '#o { color: rgb(1, 2, 3); }',
      '--- setup.js',
      'window.SETUP = "ok"; // a "</script>" inside stays code',
      '--- rows.csv',
      'a,b',
      '1,2',
      '3,4',
    ].join('\n');

    it('splits the page from its files at --- name.ext lines', () => {
      const s = splitSnippetFiles(multi);
      expect(Object.keys(s.files)).toEqual(['label.js', 'count.js', 'look.css', 'setup.js', 'rows.csv']);
      expect(s.files['rows.csv']).toBe('a,b\n1,2\n3,4');
      expect(s.main).toContain('<div id="o">');
      expect(s.error).toBeNull();
      expect(splitSnippetFiles('<b>x</b>\n---\n<i>y</i>').files).toEqual({});
      expect(splitSnippetFiles('--- a.js\n1\n--- a.js\n2').error).toContain('Two files');
    });

    it('rewrites ./file imports to the map, scripts in place, stylesheets applied', () => {
      const doc = buildSnippetDoc({ source: multi, origin });
      expect(doc).not.toContain('<script type="importmap">');
      expect(doc).not.toContain('href="./look.css"');
      expect(doc).toContain('from "@file/label.js"');
      expect(doc).toContain('a "<\\/script>" inside');
      const boot = JSON.parse(new DOMParser().parseFromString(doc, 'text/html').getElementById('alfred-boot')!.textContent!);
      expect(boot.files['label.js']).toContain('from "@file/count.js"');
      expect(boot.imports['preact']).toBe(`${origin}/lib/preact/10/preact.module.js`);
    });

    it('runs in a real locked frame: modules import each other, CSS applies, data files read', async () => {
      const frame = document.createElement('iframe');
      frame.setAttribute('sandbox', 'allow-scripts');
      const got = new Promise<{ v: string; color: string; setup: string }>((resolve) => {
        const on = (e: MessageEvent) => { if (e.source === frame.contentWindow && e.data?.probe === 'multi') { window.removeEventListener('message', on); resolve(e.data); } };
        window.addEventListener('message', on);
      });
      frame.srcdoc = buildSnippetDoc({ source: multi, origin: location.origin, inline: {} });
      document.body.appendChild(frame);
      const r = await got;
      expect(r.v).toBe('rows: 2');
      expect(r.color).toBe('rgb(1, 2, 3)');
      expect(r.setup).toBe('ok');
      frame.remove();
    });
  });
});
