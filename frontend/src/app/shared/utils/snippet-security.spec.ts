import { TestBed } from '@angular/core/testing';
import { MAX_ANSWER_BYTES, MAX_MESSAGES_PER_SECOND, SnippetBridge, readMessage } from './snippet-bridge';
import { SNIPPET_RUNTIME, SNIPPET_SANDBOX, buildSnippetDoc, scriptJson, snippetCsp } from './snippet-frame';
import { libsOf } from './snippet-libs';
import { markdownBlocks } from './markdown-blocks';
import { blocksToHtml } from './rich-html';
import { SnippetHostComponent, SnippetRunSetting } from '../../components/board/visuals/snippet-host.component';
import { SnippetShelfService } from '../../core/services/snippet-shelf.service';

/**
 * specs/017 R10, R12, R45: what keeps a snippet locked in. Every test here guards one wall - loosen one and it fails.
 */
describe('snippet security', () => {
  const origin = 'http://alfred.test';

  describe('the frame', () => {
    it('is sandboxed to scripts only - never same-origin, popups, top navigation, forms or downloads', () => {
      expect(SNIPPET_SANDBOX).toBe('allow-scripts');
    });

    it('allows no network: no connect, no frames, no forms, nothing outside /lib/ and Alfred pictures', () => {
      const csp = snippetCsp(origin);
      const d = Object.fromEntries(csp.split('; ').map((x) => { const [k, ...v] = x.split(' '); return [k, v.join(' ')]; }));
      expect(d['default-src']).toBe(`'none'`);
      expect(d['connect-src']).toBe(`'none'`);
      expect(d['frame-src']).toBe(`'none'`);
      expect(d['form-action']).toBe(`'none'`);
      expect(d['base-uri']).toBe(`'none'`);
      expect(d['script-src']).toBe(`'unsafe-inline' 'unsafe-eval' blob: ${origin}/lib/`);
      expect(d['style-src']).toBe(`'unsafe-inline' ${origin}/lib/`);
      expect(d['img-src']).toBe(`data: blob: ${origin}/lib/ ${origin}/board/images/`);
      const others = csp.split(`${origin}/`).join('');
      expect(others).not.toContain('*');
      expect(others).not.toContain('http');
      expect(others).not.toContain('data: blob:; connect');
      expect(csp).not.toMatch(/'self'/);
    });

    it('puts the policy before every script - the snippet\'s own head and doctype cannot come first', () => {
      const doc = buildSnippetDoc({ source: '<!doctype html><html><head><script>fetch("https://x")</script></head><body>hi</body></html>', origin });
      const csp = doc.indexOf('Content-Security-Policy');
      expect(csp).toBeGreaterThan(0);
      expect(doc.indexOf('<script')).toBeGreaterThan(csp);
      expect(doc.indexOf('fetch(')).toBeGreaterThan(doc.indexOf('<body>'));
      expect(doc.match(/<!doctype/gi)!.length).toBe(1);
    });

    it('cannot be closed early by data passed in', () => {
      const doc = buildSnippetDoc({ source: '', origin, name: '</script><script>alert(1)</script>', context: { x: '</script>' } });
      const boot = doc.slice(doc.indexOf('id="alfred-boot">'), doc.indexOf('</script>', doc.indexOf('id="alfred-boot">')));
      expect(boot).not.toContain('<');
      expect(scriptJson('</script>')).toBe('"\\u003c/script>"');
    });

    it('drops theme values that could break out of the style element', () => {
      const doc = buildSnippetDoc({ source: '', origin, vars: { '--text': 'red', '--bad': 'x}</style><script>', 'color': 'blue' } });
      expect(doc).toContain('--text:red');
      expect(doc).not.toContain('--bad');
      expect(doc).not.toContain(':root{color');
    });

    it('loads libraries only from the shelf on Alfred\'s own address', () => {
      const doc = buildSnippetDoc({ source: '', origin, libs: 'echarts https://evil.example/x.js ../../etc' });
      const srcs = [...doc.matchAll(/<(?:script src|link rel="stylesheet" href)="(?!')([^"]+)"/g)].map((m) => m[1]);
      expect(srcs).toEqual([`${origin}/lib/echarts/5/echarts.min.js`]);
      expect(libsOf('https://evil.example/x.js')).toEqual([]);
    });

    it('a snippet stored in a text is code text, never markup', () => {
      const html = blocksToHtml(markdownBlocks('```html live\n<img src=x onerror=alert(1)>\n```'));
      expect(html).not.toContain('<img');
      expect(html).toContain('&lt;img');
    });

    it('the runtime listens to its parent only', () => {
      expect(SNIPPET_RUNTIME).toContain('if(e.source!==P)return');
      expect(SNIPPET_RUNTIME).toContain('m.alfred!==1');
    });

    it('the host makes the frame with the sandbox set before its document', async () => {
      TestBed.configureTestingModule({ providers: [{ provide: SnippetShelfService, useValue: { canLoadDirect: () => Promise.resolve(true) } }] });
      TestBed.inject(SnippetRunSetting).onOpen.set(true);
      const created: HTMLIFrameElement[] = [];
      const make = document.createElement.bind(document);
      spyOn(document, 'createElement').and.callFake(((tag: string) => {
        const el = make(tag);
        if (tag === 'iframe') {
          created.push(el as HTMLIFrameElement);
          const desc = Object.getOwnPropertyDescriptor(HTMLIFrameElement.prototype, 'srcdoc')!;
          Object.defineProperty(el, 'srcdoc', { set(v: string) { expect(el.getAttribute('sandbox')).toBe('allow-scripts'); desc.set!.call(el, v); }, get() { return desc.get!.call(el); } });
        }
        return el;
      }) as typeof document.createElement);
      const f = TestBed.createComponent(SnippetHostComponent);
      f.componentRef.setInput('source', '<b>hi</b>');
      f.detectChanges();
      TestBed.flushEffects();
      await new Promise((r) => setTimeout(r, 0));
      f.detectChanges();
      expect(created.length).toBe(1);
      const frame = f.nativeElement.querySelector('iframe') as HTMLIFrameElement;
      expect(frame).toBe(created[0]);
      expect(frame.getAttribute('sandbox')).toBe('allow-scripts');
      expect(frame.getAttribute('allow')).toBeNull();
      expect(frame.srcdoc).toContain('Content-Security-Policy');
      f.destroy();
    });
  });

  describe('the bridge', () => {
    let frame: HTMLIFrameElement;
    let bridge: SnippetBridge;
    let calls: string[];
    let posted: unknown[];

    beforeEach(() => {
      frame = document.createElement('iframe');
      document.body.appendChild(frame);
      posted = [];
      spyOn(frame.contentWindow!, 'postMessage').and.callFake(((m: unknown) => { posted.push(m); }) as Window['postMessage']);
      calls = [];
      bridge = new SnippetBridge(frame, async (op) => { calls.push(op); return op === 'files' ? 'x'.repeat(MAX_ANSWER_BYTES + 10) : { ok: 1 }; }, {});
    });

    afterEach(() => { bridge.close(); frame.remove(); });

    it('ignores messages from any window but its frame', () => {
      const req = { alfred: 1, t: 'req', id: 1, op: 'data', args: {} };
      expect(bridge.receive({ source: window, data: req })).toBeFalse();
      expect(bridge.receive({ source: null, data: req })).toBeFalse();
      const other = document.createElement('iframe');
      document.body.appendChild(other);
      expect(bridge.receive({ source: other.contentWindow, data: req })).toBeFalse();
      other.remove();
      expect(bridge.receive({ source: frame.contentWindow, data: req })).toBeTrue();
    });

    it('reads only known shapes', () => {
      expect(readMessage(null)).toBeNull();
      expect(readMessage('x')).toBeNull();
      expect(readMessage({ t: 'size', h: 10 })).toBeNull();
      expect(readMessage({ alfred: 1, t: 'eval', code: 'x' })).toBeNull();
      expect(readMessage({ alfred: 1, t: 'req', id: 1, op: 'delete', args: {} })).toBeNull();
      expect(readMessage({ alfred: 1, t: 'req', id: 1.5, op: 'data', args: {} })).toBeNull();
      expect(readMessage({ alfred: 1, t: 'req', id: 1, op: 'data', args: [1] })).toBeNull();
      expect(readMessage({ alfred: 1, t: 'size', h: 'tall' })).toBeNull();
      expect(readMessage({ alfred: 1, t: 'log', level: 'alert', text: 'x' })).toBeNull();
      expect(readMessage({ alfred: 1, t: 'shot', id: 1, png: 'javascript:alert(1)' })).toEqual({ t: 'shot', id: 1, error: 'No picture' });
      expect(readMessage({ alfred: 1, t: 'size', h: 120 })).toEqual({ t: 'size', h: 120 });
    });

    it('reads at most 50 messages a second', () => {
      let read = 0;
      for (let i = 0; i < 80; i++) if (bridge.receive({ source: frame.contentWindow, data: { alfred: 1, t: 'size', h: i } })) read++;
      expect(read).toBe(MAX_MESSAGES_PER_SECOND);
    });

    it('refuses an answer over 5 MB instead of sending it', async () => {
      bridge.receive({ source: frame.contentWindow, data: { alfred: 1, t: 'req', id: 7, op: 'files', args: null } });
      await new Promise((r) => setTimeout(r, 0));
      const res = posted.find((m) => (m as { id?: number }).id === 7) as { ok: boolean; error: string };
      expect(res.ok).toBeFalse();
      expect(res.error).toContain('5 MB');
    });

    it('answers a request with the handler and tags it for the frame', async () => {
      bridge.receive({ source: frame.contentWindow, data: { alfred: 1, t: 'req', id: 3, op: 'data', args: { src: 'calls' } } });
      await new Promise((r) => setTimeout(r, 0));
      expect(calls).toEqual(['data']);
      expect(posted).toContain(jasmine.objectContaining({ alfred: 1, t: 'res', id: 3, ok: true, value: { ok: 1 } }));
    });
  });
});
