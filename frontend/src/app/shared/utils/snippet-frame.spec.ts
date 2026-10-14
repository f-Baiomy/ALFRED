import { buildSnippetDoc, libsForDoc } from './snippet-frame';
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
});
