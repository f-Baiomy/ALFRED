import { buildSnippetDoc, snippetCsp } from './snippet-frame';
import { SnippetBridge } from './snippet-bridge';
import { PYODIDE_DIR } from './snippet-python';

describe('Python snippets (specs/017 R27)', () => {
  const origin = 'http://alfred.test';

  it('may read only the shelf\'s Python folder - every other snippet still reads nothing', () => {
    expect(snippetCsp(origin)).toContain(`connect-src 'none'`);
    expect(snippetCsp(origin, true)).toContain(`connect-src ${origin}/lib/${PYODIDE_DIR}/`);
    expect(snippetCsp(origin, true)).not.toContain(`connect-src ${origin}/lib/;`);
    const doc = buildSnippetDoc({ source: 'print("</script><script>alert(1)")', kind: 'python', origin });
    expect(doc).toContain(`<script src="${origin}/lib/${PYODIDE_DIR}/pyodide.js"></script>`);
    expect(doc).not.toContain('</script><script>alert(1)');
    const cfg = JSON.parse(new DOMParser().parseFromString(doc, 'text/html').getElementById('py-src')!.textContent!);
    expect(cfg.source).toBe('print("</script><script>alert(1)")');
  });

  it('runs Python in a real locked frame: a DataFrame from alfred.calls, print, the last value and a matplotlib figure', async () => {
    const shelf = await fetch(`/lib/${PYODIDE_DIR}/pyodide.js`, { method: 'HEAD' });
    if (!shelf.ok) {
      pending('Python is not on the shelf here (scripts/fetch-pyodide.mjs runs before ng build)');
      return;
    }
    if (!(await frameImports(`/lib/${PYODIDE_DIR}/pyodide.mjs`))) {
      pending('This test server does not send the CORS header nginx sends for /lib/ - checked on the deployed Alfred');
      return;
    }
    const frame = document.createElement('iframe');
    frame.setAttribute('sandbox', 'allow-scripts');
    frame.style.cssText = 'width:500px;height:400px';
    const logs: string[] = [];
    let height = 0;
    let bridge: SnippetBridge | null = null;
    const ready = new Promise<void>((resolve) => {
      bridge = new SnippetBridge(frame, async (op, args) => {
        if (op === 'data' && args['src'] === 'calls') return [{ endpoint: '/a', durationMs: 10 }, { endpoint: '/b', durationMs: 30 }];
        throw new Error('no ' + op);
      }, { log: (level, t) => logs.push(level + ': ' + t), size: (h) => (height = h), ready: () => resolve() });
    });
    frame.srcdoc = buildSnippetDoc({
      kind: 'python', origin: location.origin,
      source: [
        'import matplotlib.pyplot as plt',
        'calls = await alfred.calls(since="24h")',
        'print("rows", len(calls))',
        'plt.bar(calls["endpoint"], calls["durationMs"])',
        'int(calls["durationMs"].sum())',
      ].join('\n'),
    });
    document.body.appendChild(frame);
    await ready;
    const png = await bridge!.shot(20000);
    expect(logs).toContain('log: rows 2');
    expect(logs.filter((l) => l.startsWith('error'))).toEqual([]);
    expect(png.startsWith('data:image/png;base64,')).toBeTrue();
    expect(png.length).toBeGreaterThan(3000);
    expect(height).toBeGreaterThan(200); // the figure is in the page
    bridge!.close();
    frame.remove();
  }, 240000);
});

/** Whether a locked frame here may import a module from the shelf (Alfred's nginx allows it; the test server may not). */
async function frameImports(path: string): Promise<boolean> {
  const frame = document.createElement('iframe');
  frame.setAttribute('sandbox', 'allow-scripts');
  const answer = new Promise<boolean>((resolve) => {
    const on = (e: MessageEvent) => {
      if (e.source !== frame.contentWindow || typeof e.data?.probeImport !== 'boolean') return;
      window.removeEventListener('message', on);
      resolve(e.data.probeImport);
    };
    window.addEventListener('message', on);
    setTimeout(() => resolve(false), 5000);
  });
  frame.srcdoc = `<script type="module">import("${location.origin}${path}").then(() => parent.postMessage({ probeImport: true }, "*"), `
    + `() => parent.postMessage({ probeImport: false }, "*"));</script>`;
  document.body.appendChild(frame);
  const ok = await answer;
  frame.remove();
  return ok;
}
