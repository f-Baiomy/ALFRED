import { Injectable } from '@angular/core';
import { SnippetLib, SNIPPET_LIBS } from '../../shared/utils/snippet-libs';
import { SNIPPET_SANDBOX } from '../../shared/utils/snippet-frame';

/** The library a probe frame loads: small, a classic script, sets `dayjs`. */
const PROBE = SNIPPET_LIBS.find((l) => l.id === 'dayjs')!;

/**
 * How a snippet's frame gets Alfred's libraries (specs/017 R25). A normal browser lets the sandboxed frame load them
 * from /lib/ itself. Some embedded browsers refuse every request a sandboxed (opaque-origin) frame makes; there the
 * host reads the files (same origin, cached) and hands their code to the frame inline - the frame still has no network.
 * A probe frame decides once per page load. The ⬇ .html download always carries its libraries inline, so it opens
 * anywhere, offline.
 */
@Injectable({ providedIn: 'root' })
export class SnippetShelfService {
  private direct: Promise<boolean> | null = null;
  private readonly texts = new Map<string, Promise<string>>();

  /** Can a sandboxed frame load /lib/ files by itself here? */
  canLoadDirect(): Promise<boolean> {
    this.direct ??= probe();
    return this.direct;
  }

  /** A library's code, read once. */
  text(lib: SnippetLib): Promise<string> {
    let t = this.texts.get(lib.file);
    if (!t) {
      t = fetch(`/lib/${lib.file}`).then((r) => {
        if (!r.ok) throw new Error(`${lib.name} is not on this Alfred (${r.status})`);
        return r.text();
      });
      t.catch(() => this.texts.delete(lib.file));
      this.texts.set(lib.file, t);
    }
    return t;
  }

  /** The code of these libraries, by file - what buildSnippetDoc's `inline` takes. */
  async inline(libs: readonly SnippetLib[]): Promise<Record<string, string>> {
    const out: Record<string, string> = {};
    await Promise.all(libs.map(async (l) => { out[l.file] = await this.text(l); }));
    return out;
  }
}

function probe(): Promise<boolean> {
  if (typeof document === 'undefined') return Promise.resolve(true);
  return new Promise((resolve) => {
    const f = document.createElement('iframe');
    const nonce = Math.random().toString(36).slice(2);
    const done = (v: boolean) => { window.removeEventListener('message', on); clearTimeout(timer); f.remove(); resolve(v); };
    const on = (e: MessageEvent) => { if (e.source === f.contentWindow && e.data?.probe === nonce) done(e.data.ok === true); };
    const timer = setTimeout(() => done(false), 4000);
    window.addEventListener('message', on);
    f.setAttribute('sandbox', SNIPPET_SANDBOX);
    f.setAttribute('aria-hidden', 'true');
    f.style.cssText = 'position:absolute;width:0;height:0;border:0;visibility:hidden';
    const url = `${location.origin}/lib/${PROBE.file}`;
    f.srcdoc = `<script src="${url}" onload="parent.postMessage({probe:'${nonce}',ok:typeof dayjs==='function'},'*')"`
      + ` onerror="parent.postMessage({probe:'${nonce}',ok:false},'*')"></script>`;
    document.body.appendChild(f);
  });
}
