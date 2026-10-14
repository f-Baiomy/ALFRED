import { Component, ElementRef, Injectable, Injector, OnDestroy, afterNextRender, computed, effect, inject, input, signal, viewChild } from '@angular/core';
import { infoAttrs } from '../../../shared/utils/board-visuals';
import { SnippetBridge, SnippetHandler, SnippetOp } from '../../../shared/utils/snippet-bridge';
import { SNIPPET_SANDBOX, SnippetDocOptions, buildSnippetDoc, libsForDoc, themeVars } from '../../../shared/utils/snippet-frame';
import { SNIPPET_LIBS } from '../../../shared/utils/snippet-libs';
import { SnippetShelfService } from '../../../core/services/snippet-shelf.service';
import { SnippetMemory, SnippetStoreService, sourceHash } from '../../../core/services/snippet-store.service';
import { DataContext, SnippetDataService } from '../../../core/services/snippet-data.service';
import { Subscription } from 'rxjs';
import { downloadBlobAs, fileNameOf } from '../../../shared/utils/svg-png';

const RUN_KEY = 'alfred.board.snippets.run';

/** Per-browser: snippets run when a text opens (the default) or wait for ▶ (specs/017 R15). */
@Injectable({ providedIn: 'root' })
export class SnippetRunSetting {
  readonly onOpen = signal(read() !== 'click');

  toggle(): void {
    const next = !this.onOpen();
    this.onOpen.set(next);
    try { localStorage.setItem(RUN_KEY, next ? 'open' : 'click'); } catch { /* private window: this tab only */ }
  }
}

function read(): string | null {
  try { return localStorage.getItem(RUN_KEY); } catch { return null; }
}

export interface ConsoleLine { readonly level: string; readonly text: string; readonly at: number }

/** Inline height limits (R13); a page may be taller. */
export const MIN_HEIGHT = 80;
export const MAX_INLINE_HEIGHT = 900;
const MAX_PAGE_HEIGHT = 6000;
const CONSOLE_LINES = 200;
/** Live sources one frame may watch. */
const MAX_WATCHES = 20;
/** How long a frame settles (animations, fonts) before Alfred keeps its picture. */
const SHOT_SETTLE_MS = 1500;

/**
 * One HTML snippet (or diagram) in its locked frame (specs/017 R10-R15, R28). The frame is made here by hand rather
 * than by a template binding: its sandbox is set before it has a document, and Angular's srcdoc sanitizer (which would
 * strip every script) is not involved because the frame itself is the boundary.
 */
@Component({
  selector: 'app-snippet-host',
  standalone: true,
  template: `
    <div class="snip" [class.full]="full()" [class.page]="page()" (keydown.escape)="full.set(false)">
      <div class="snip-bar" dir="ltr">
        <span class="snip-name">{{ kind() === 'mermaid' ? '⬡' : '◈' }} {{ title() }}</span>
        <span class="snip-lock" title="Runs in a locked frame: no network, cannot read or change Alfred, acts only through you">🔒 locked</span>
        @if (errors()) { <button type="button" class="snip-err" (click)="consoleOpen.set(true)">⚠ {{ errors() }} error{{ errors() === 1 ? '' : 's' }}</button> }
        <span class="snip-grow"></span>
        <button type="button" class="board-link" [title]="full() ? 'Back (Esc)' : 'Full screen'" (click)="full.set(!full())">{{ full() ? '✕' : '⤢' }}</button>
        <button type="button" class="board-link" title="Source" [class.on]="showSource()" (click)="showSource.set(!showSource())">&lt;/&gt;</button>
        <button type="button" class="board-link" title="Download as PNG" [disabled]="!running()" (click)="png()">⬇ PNG</button>
        <button type="button" class="board-link" title="Download as an .html file" (click)="downloadHtml()">⬇ .html</button>
        <button type="button" class="board-link" title="Copy the source" (click)="copy()">{{ copied() ? '✓' : '⧉' }}</button>
        <button type="button" class="board-link" [title]="(lines().length ? lines().length + ' console lines' : 'Console')" [class.on]="consoleOpen()" (click)="consoleOpen.set(!consoleOpen())">▭</button>
        <button type="button" class="board-link" [title]="run.onOpen() ? 'Snippets run when a text opens - click to make them wait for ▶' : 'Snippets wait for ▶ - click to run them on open'"
                (click)="run.toggle()">{{ run.onOpen() ? '▶ auto' : '▶ click' }}</button>
      </div>
      @if (!running()) {
        <button type="button" class="snip-run" (click)="started.set(true)">▶ Run {{ kind() === 'mermaid' ? 'diagram' : 'snippet' }}</button>
      }
      <div #box class="snip-box" [hidden]="!running()" [style.height.px]="full() ? null : height()"></div>
      @if (note(); as n) { <div class="snip-note">{{ n }}</div> }
      @if (showSource()) { <pre class="snip-src" dir="ltr">{{ source() }}</pre> }
      @if (consoleOpen()) {
        <div class="snip-console" dir="ltr">
          @for (l of lines(); track $index) { <div [class]="'snip-log ' + l.level">{{ l.text }}</div> }
          @empty { <div class="board-dim">Nothing logged.</div> }
        </div>
      }
    </div>`,
})
export class SnippetHostComponent implements OnDestroy {
  readonly source = input.required<string>();
  /** The fence's info string: `live name="…" libs="…" height=300 page`. */
  readonly info = input('');
  readonly kind = input<'html' | 'mermaid'>('html');
  readonly dir = input<'ltr' | 'rtl' | 'auto'>('auto');
  readonly context = input<Record<string, unknown>>({});
  /** What the frame's requests do; until a feature answers them, each is refused with a reason. */
  readonly handler = input<SnippetHandler>(notYet);
  /**
   * A page's id, or an inline block's `inline:card:<id>:<where>:<n>`: with it the snippet keeps `alfred.state` and Alfred
   * keeps a shot of what it drew (R23, R31). Without it (a preview) neither is kept.
   */
  readonly snippetId = input<string | null>(null);
  /** A page's version; an inline block's shots go by a hash of its source. */
  readonly version = input<number | null>(null);

  readonly box = viewChild.required<ElementRef<HTMLDivElement>>('box');
  readonly run = inject(SnippetRunSetting);
  readonly started = signal(false);
  readonly full = signal(false);
  readonly showSource = signal(false);
  readonly consoleOpen = signal(false);
  readonly copied = signal(false);
  readonly note = signal<string | null>(null);
  readonly lines = signal<readonly ConsoleLine[]>([]);
  readonly errors = computed(() => this.lines().filter((l) => l.level === 'error').length);
  readonly attrs = computed(() => infoAttrs(this.info()));
  readonly page = computed(() => /(^|\s)page(\s|$)/.test(this.info()));
  readonly title = computed(() => this.attrs()['name'] || (this.kind() === 'mermaid' ? 'Diagram' : this.page() ? 'Page' : 'HTML snippet'));
  readonly running = computed(() => this.run.onOpen() || this.started());
  private readonly fixedHeight = computed(() => {
    const h = Number(this.attrs()['height']);
    return Number.isFinite(h) && h > 0 ? Math.min(h, this.page() ? MAX_PAGE_HEIGHT : MAX_INLINE_HEIGHT) : null;
  });
  private readonly contentHeight = signal(0);
  readonly height = computed(() => this.fixedHeight()
    ?? Math.max(MIN_HEIGHT, Math.min(this.contentHeight() || (this.page() ? 480 : 160), this.page() ? MAX_PAGE_HEIGHT : MAX_INLINE_HEIGHT)));

  /** What the frame's document is made from. */
  readonly options = computed<SnippetDocOptions>(() => ({
    source: this.source(), kind: this.kind(), libs: this.attrs()['libs'], origin: location.origin, dir: this.dir(),
    name: this.title(), context: this.snippetId() ? { ...this.context(), snippet: this.snippetId() } : this.context(), vars: themeVars(),
  }));
  /** The document with its libraries by address - also what decides whether the frame must be made again. */
  readonly doc = computed(() => buildSnippetDoc(this.options()));
  private readonly shelf = inject(SnippetShelfService);
  /** Read only for a snippet with an id - a preview needs no server. */
  private readonly injector = inject(Injector);
  private get store(): SnippetStoreService {
    return this.injector.get(SnippetStoreService);
  }
  private generation = 0;
  private memory: SnippetMemory | null = null;
  private memorySub: Subscription | null = null;
  private shotTimer: ReturnType<typeof setTimeout> | null = null;
  /** Live data a snippet watches; while it is off-screen a change only marks it, and it is read once it is seen. */
  private watchers: Subscription[] = [];
  private readonly stale = new Set<string>();
  private readonly rereads = new Map<string, () => void>();

  private frame: HTMLIFrameElement | null = null;
  private bridge: SnippetBridge | null = null;
  private observer: IntersectionObserver | null = null;
  private visible = true;
  private shown = '';

  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);

  private readonly viewReady = signal(false);

  constructor() {
    afterNextRender(() => this.viewReady.set(true));
    // A frame is made again only when its document changes - not when the text around it is re-read.
    effect(() => {
      const doc = this.doc();
      if (!this.viewReady()) return;
      if (!this.running()) { this.teardown(); return; }
      if (doc !== this.shown) void this.show(doc, this.options());
    }, { allowSignalWrites: true });
  }

  ngOnDestroy(): void {
    this.teardown();
    this.observer?.disconnect();
  }

  /** Libraries by address where the frame may load them, else inline (SnippetShelfService). */
  private async show(key: string, options: SnippetDocOptions): Promise<void> {
    const gen = ++this.generation;
    this.shown = key;
    let doc = key;
    if (!(await this.shelf.canLoadDirect())) {
      try {
        doc = buildSnippetDoc({ ...options, inline: await this.shelf.inline(libsForDoc(options)) });
      } catch (e) {
        this.log('error', e instanceof Error ? e.message : String(e));
      }
    }
    if (gen === this.generation && this.shown === key) this.mount(doc, key);
  }

  /** The frame: sandbox first, then the document, then into the page. */
  private mount(doc: string, key: string): void {
    this.teardown();
    this.lines.set([]);
    this.contentHeight.set(0);
    const f = document.createElement('iframe');
    f.setAttribute('sandbox', SNIPPET_SANDBOX);
    f.setAttribute('referrerpolicy', 'no-referrer');
    f.setAttribute('loading', 'lazy');
    f.setAttribute('title', this.title());
    f.className = 'snip-frame';
    f.srcdoc = doc;
    this.box().nativeElement.appendChild(f);
    this.frame = f;
    this.shown = key;
    this.bridge = new SnippetBridge(f, (op, args) => this.answer(op, args), {
      size: (h) => this.contentHeight.set(Math.ceil(h)),
      log: (level, text) => this.log(level, text),
      ready: () => { if (!this.visible) this.bridge?.pause(true); this.scheduleShot(); },
    });
    const id = this.snippetId();
    if (id) {
      this.memory = this.store.memory(id);
      const memory = this.memory;
      this.memorySub = memory.changes$.subscribe(() => {
        void memory.refresh().then((changed) => { for (const c of changed) this.bridge?.emit('state', c); });
      });
    }
    this.watchVisibility();
  }

  /**
   * After the first render of each version (R31): once it has settled, the frame draws itself and Alfred keeps the
   * picture with the console - only while it is on screen, so it is drawn as seen.
   */
  private scheduleShot(): void {
    const id = this.snippetId();
    if (!id || this.shotTimer) return;
    const bridge = this.bridge;
    const version = this.version() ?? sourceHash(this.source());
    this.shotTimer = setTimeout(() => {
      this.shotTimer = null;
      if (!bridge || bridge !== this.bridge || !this.visible || document.visibilityState !== 'visible') return;
      void this.store.keepShot(id, version, () => bridge.shot(), () => this.lines().map((l) => (l.level === 'log' ? '' : l.level + ': ') + l.text));
    }, SHOT_SETTLE_MS);
  }

  /** `lib` is the host's own (a library's code from the shelf); everything else goes to the feature's handler. */
  private answer(op: SnippetOp, args: Record<string, unknown>): Promise<unknown> {
    if (op === 'lib') {
      const lib = SNIPPET_LIBS.find((l) => l.id === args['id']);
      return lib ? this.shelf.text(lib) : Promise.reject(new Error('No library ' + String(args['id'])));
    }
    if (op === 'data') return this.data(args);
    if (op === 'state.get' || op === 'state.set' || op === 'state.all') {
      const m = this.memory;
      if (!m) return Promise.reject(new Error('alfred.state keeps values only for a saved page or a block in a saved text'));
      if (op === 'state.all') return m.all();
      return op === 'state.get' ? m.get(String(args['key'])) : m.set(String(args['key']), args['value']);
    }
    return this.handler()(op, args);
  }

  /**
   * `alfred.data` / `alfred.watch` (R17): read through the allowlist; a watched source is read again on each
   * "calls changed" / "board changed" signal and the new answer sent in.
   */
  private async data(args: Record<string, unknown>): Promise<unknown> {
    const svc = this.injector.get(SnippetDataService);
    const src = String(args['src'] ?? '');
    const query = (args['args'] && typeof args['args'] === 'object' ? args['args'] : {}) as Record<string, unknown>;
    const c = this.context();
    const ctx: DataContext = { project: str(c['project']), cardId: str(c['cardId']), cycleId: str(c['cycleId']) };
    const value = await svc.read(src, query, ctx);
    const live = typeof args['live'] === 'string' ? args['live'] : null;
    const bridge = this.bridge;
    if (live && bridge && this.watchers.length < MAX_WATCHES) {
      this.watchers.push(svc.changes(src).subscribe(() => {
        if (!this.visible) { this.stale.add(live); return; }
        svc.read(src, query, ctx).then((v) => bridge.emit('data:' + live, v), () => undefined);
      }));
      this.rereads.set(live, () => svc.read(src, query, ctx).then((v) => bridge.emit('data:' + live, v), () => undefined));
    }
    return value;
  }

  private teardown(): void {
    this.generation++;
    this.watchers.forEach((w) => w.unsubscribe());
    this.watchers = [];
    this.stale.clear();
    this.rereads.clear();
    this.memorySub?.unsubscribe();
    this.memorySub = null;
    this.memory = null;
    if (this.shotTimer) clearTimeout(this.shotTimer);
    this.shotTimer = null;
    this.bridge?.close();
    this.bridge = null;
    this.frame?.remove();
    this.frame = null;
    this.shown = '';
  }

  /** Off-screen frames are paused (R15): animations and requestAnimationFrame stop until it scrolls back. */
  private watchVisibility(): void {
    if (this.observer || typeof IntersectionObserver === 'undefined') return;
    this.observer = new IntersectionObserver((entries) => {
      const v = entries.some((e) => e.isIntersecting);
      if (v === this.visible) return;
      this.visible = v;
      this.bridge?.pause(!v);
      if (v) { for (const key of this.stale) this.rereads.get(key)?.(); this.stale.clear(); }
    });
    this.observer.observe(this.host.nativeElement);
  }

  log(level: string, text: string): void {
    this.lines.update((l) => [...l, { level, text, at: Date.now() }].slice(-CONSOLE_LINES));
  }

  async png(): Promise<void> {
    if (!this.bridge) return;
    this.note.set('Drawing a picture…');
    try {
      downloadBlobAs(dataUrlBlob(await this.bridge.shot()), fileNameOf(this.title(), 'png'));
      this.note.set(null);
    } catch (e) {
      this.note.set('No picture: ' + (e instanceof Error ? e.message : String(e)));
    }
  }

  /** A file that opens anywhere, offline: its libraries go in with it. */
  async downloadHtml(): Promise<void> {
    const o = this.options();
    let doc = this.doc();
    try { doc = buildSnippetDoc({ ...o, inline: await this.shelf.inline(libsForDoc(o)) }); } catch { /* by address, then */ }
    downloadBlobAs(new Blob([doc], { type: 'text/html' }), fileNameOf(this.title(), 'html'));
  }

  async copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(this.source());
      this.copied.set(true);
      setTimeout(() => this.copied.set(false), 1200);
    } catch { /* clipboard refused: nothing to do */ }
  }
}

/** A data: URL (the frame's picture) as a Blob, without fetch. */
export function dataUrlBlob(url: string): Blob {
  const [head, b64] = url.split(',', 2);
  const bin = atob(b64 ?? '');
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: /data:([^;,]+)/.exec(head)?.[1] ?? 'application/octet-stream' });
}

const notYet: SnippetHandler = async (op) => {
  throw new Error(`alfred.${op === 'data' ? 'data' : op.split('.')[0]}() is not available here`);
};

function str(v: unknown): string | null {
  return typeof v === 'string' && v ? v : null;
}
