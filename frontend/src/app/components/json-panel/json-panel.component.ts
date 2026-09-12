import { Component, ElementRef, Injector, afterNextRender, computed, effect, inject, input, output, signal, viewChild } from '@angular/core';
import { NgTemplateOutlet } from '@angular/common';
import { JsonFlatViewComponent, LineTokens } from '../json-flat-view/json-flat-view.component';
import { JsonTreeComponent } from '../json-tree/json-tree.component';
import { CALL_LIST_CONTROLS_STATE } from '../../core/state/call-selection.tokens';
import { HighlightToken, highlightTokens, prettyJsonText, tokenizeJsonText, tryParseJson } from '../../shared/utils/json-tokenizer';
import { tokenizeXmlText, tryParseXml } from '../../shared/utils/xml-tokenizer';
import { splitTokensIntoLines } from '../../shared/utils/line-tokenizer';
import { JsonViewMode } from '../../core/models/call.model';
import { Comment, CommentBlock } from '../../core/models/comment.model';
import { CommentsStore } from '../../core/state/comments-store.service';
import { PanelViewLauncherService } from '../../core/services/panel-view-launcher.service';
import { copyToClipboard } from '../../shared/utils/clipboard';

/** See JsonPanelComponent.loadState. */
export type PanelLoadState = 'idle' | 'loading' | 'loaded' | 'error';

/**
 * Who asked for this block's content. 'user' means someone opened this exact block, which also
 * means they can see it - so it's fetched immediately. 'bulk' comes from an "Expand all" that may
 * well have hit cards far below the fold, so the card defers those until they scroll into view.
 */
export type PanelLoadTrigger = 'user' | 'bulk';

/**
 * Which chrome wraps this block's content.
 *
 * - 'details' (the default): its own collapsible <details> with a summary, which is how the
 *   standalone json-view page and any pre-existing caller use it.
 * - 'panel': no collapsible wrapper at all - something outside owns open/closed (a call card's chip
 *   strip) and only renders this when it's open, so the block carries just a title bar and a close.
 */
export type PanelChrome = 'details' | 'panel';

type ParsedValue =
  | { kind: 'json'; value: unknown }
  | { kind: 'xml'; text: string }
  | { kind: 'text'; plainText: string };

/**
 * One Headers/Body block: owns its own search/filter/view-mode state.
 * Because Angular keeps this component instance alive across polling
 * re-renders (as long as the parent list's trackBy matches call identity),
 * none of that state needs to be externally persisted in a lookup map the
 * way the original vanilla-JS version required - it just lives here as
 * ordinary component state.
 *
 * This same component is reused verbatim inside JsonViewPageComponent (the
 * "open in new tab" destination) - it doesn't know or care which page it's
 * rendered in, so any feature added here automatically shows up there too.
 */
@Component({
  selector: 'app-json-panel',
  standalone: true,
  imports: [JsonFlatViewComponent, JsonTreeComponent, NgTemplateOutlet],
  templateUrl: './json-panel.component.html',
})
export class JsonPanelComponent {
  private readonly state = inject(CALL_LIST_CONTROLS_STATE);
  private readonly injector = inject(Injector);
  private readonly commentsStore = inject(CommentsStore);
  private readonly panelViewLauncher = inject(PanelViewLauncherService);

  readonly label = input.required<string>();
  readonly rawValue = input<unknown>(undefined);
  readonly panelId = input<string | undefined>(undefined);
  readonly callId = input.required<string>();
  readonly block = input.required<CommentBlock>();

  /**
   * Whether this block's content has been fetched yet. 'loaded' (the default) is the eager case -
   * the caller already has the value and passes it straight in, which is how JsonViewPageComponent
   * and every pre-existing caller use this component.
   *
   * A call card instead lists all four of its blocks collapsed from the start and leaves them
   * 'idle' until one is actually opened, at which point it emits `loadRequested` and moves to
   * 'loading'. A response body nobody opens is never transferred at all.
   */
  readonly loadState = input<PanelLoadState>('loaded');
  /** Emitted the first time this block is opened while still 'idle', and again on a retry click. */
  readonly loadRequested = output<PanelLoadTrigger>();
  readonly chrome = input<PanelChrome>('details');
  /** Only meaningful in 'panel' chrome - the close button in the block's own title bar. */
  readonly closeRequested = output<void>();

  /** Starts closed and is set on the first collapse-all sync (see the constructor): an eagerly
   * supplied block opens as it always has, a lazily-loaded one stays shut until asked for. Starting
   * true would flash every block open for one frame before that sync corrected it. */
  readonly open = signal(false);
  readonly viewMode = signal<JsonViewMode>('flat');
  readonly filterLinesOnly = signal(false);
  readonly searchQuery = signal('');
  readonly activeMatchIndex = signal(0);

  readonly contentRoot = viewChild<ElementRef<HTMLElement>>('contentRoot');
  private lastSeenCollapseAllVersion = -1;

  /**
   * Whether a bulk "Expand all" should open this block. An already-loaded block always qualifies -
   * showing it costs nothing. An unfetched one qualifies only if it's a HEADERS block: expanding
   * every body on a fifty-call page would fire fifty large fetches off one click, while headers are
   * a few hundred bytes each and are what's actually worth scanning in bulk.
   */
  readonly bulkExpandable = computed(
    () => this.loadState() === 'loaded' || this.block() === 'request-headers' || this.block() === 'response-headers'
  );

  readonly parsed = computed<ParsedValue>(() => {
    const value = this.rawValue();
    if (value !== null && value !== undefined && typeof value === 'object') {
      return { kind: 'json', value };
    }
    if (typeof value === 'string' && value.length > 0) {
      const asJson = tryParseJson(value);
      if (asJson.ok) return { kind: 'json', value: asJson.value };
      const asXml = tryParseXml(value);
      if (asXml.ok) return { kind: 'xml', text: asXml.pretty };
      return { kind: 'text', plainText: value };
    }
    return { kind: 'text', plainText: '' };
  });

  readonly effectiveViewMode = computed<JsonViewMode>(() => (this.parsed().kind === 'json' ? this.viewMode() : 'flat'));

  /** Angular template expressions can't do TS type casts, so this exists purely to give the tree view an untyped value when we already know (via effectiveViewMode) that parsed() is the JSON branch. */
  readonly treeValue = computed<unknown>(() => {
    const p = this.parsed();
    return p.kind === 'json' ? p.value : undefined;
  });

  private readonly baseText = computed(() => {
    const p = this.parsed();
    if (p.kind === 'json') return prettyJsonText(p.value);
    if (p.kind === 'xml') return p.text;
    return p.plainText || '(empty)';
  });

  // Every line of the full (unfiltered) text, highlighted, in original line
  // order. Each line's position in this array *is* its permanent identity -
  // comments key off it, so "Lines only" filtering below must hide lines,
  // never renumber them, or a comment would silently jump to the wrong line
  // the next time the filter is toggled off.
  private readonly allLines = computed<HighlightToken[][]>(() => {
    const tokenize = this.parsed().kind === 'xml' ? tokenizeXmlText : tokenizeJsonText;
    const tokens = highlightTokens(tokenize(this.baseText()), this.searchQuery()).tokens;
    return splitTokensIntoLines(tokens);
  });

  private readonly visibleLineIndices = computed<number[]>(() => {
    const lines = this.allLines();
    const query = this.searchQuery();
    if (this.effectiveViewMode() !== 'flat' || !this.filterLinesOnly() || !query) {
      return lines.map((_, i) => i);
    }
    const q = query.toLowerCase();
    return lines
      .map((line, i) => ({ i, text: line.map((t) => t.text).join('') }))
      .filter(({ text }) => text.toLowerCase().includes(q))
      .map(({ i }) => i);
  });

  readonly displayLines = computed<LineTokens[]>(() =>
    this.visibleLineIndices().map((index) => ({ index, tokens: this.allLines()[index] }))
  );

  readonly hiddenLinesNote = computed<string>(() => {
    if (this.effectiveViewMode() !== 'flat' || !this.filterLinesOnly() || !this.searchQuery()) return '';
    const total = this.allLines().length;
    const visible = this.visibleLineIndices().length;
    if (visible === 0) return `No lines match - ${total} hidden`;
    const hidden = total - visible;
    return hidden === 0 ? '' : `${hidden} of ${total} lines hidden`;
  });

  readonly matchCount = computed(() => this.allLines().flat().filter((t) => t.highlighted).length);
  readonly copyFeedback = signal(false);

  readonly comments = computed(() =>
    (this.commentsStore.cache().get(this.callId()) ?? []).filter((c) => c.block === this.block())
  );

  readonly commentsByLine = computed<ReadonlyMap<number, Comment[]>>(() => {
    const map = new Map<number, Comment[]>();
    for (const c of this.comments()) {
      const list = map.get(c.lineIndex) ?? [];
      list.push(c);
      map.set(c.lineIndex, list);
    }
    return map;
  });

  constructor() {
    effect(() => this.commentsStore.ensureLoaded(this.callId()), { allowSignalWrites: true });

    // A bulk "Collapse/Expand all" click should force every panel's open
    // state to match, but shouldn't fight a user's individual toggle made
    // in between two bulk clicks - so we only react when the version
    // counter actually changes, not on every read.
    effect(
      () => {
        if (this.chrome() === 'panel') return;
        const version = this.state.collapseAllVersion();
        const firstSync = this.lastSeenCollapseAllVersion === -1;
        if (!firstSync && version === this.lastSeenCollapseAllVersion) return;
        this.lastSeenCollapseAllVersion = version;

        // The first run is just this panel catching up with the current state, NOT a bulk click.
        // A lazily-loaded block stays closed there whatever `expanded()` says - otherwise every
        // card on the page fetches its headers the moment it renders, which is precisely the
        // "silently fetched with no click at all" bug the card's own tests guard against.
        if (firstSync) {
          this.open.set(this.loadState() === 'loaded' && this.state.expanded());
          return;
        }

        const shouldOpen = this.state.expanded() && this.bulkExpandable();
        this.open.set(shouldOpen);
        // Programmatically opening a <details> fires its own toggle event, but not dependably
        // enough to rely on for a fetch - ask explicitly instead. The card ignores a request for a
        // block that isn't idle, so the belt-and-braces double emit costs nothing.
        if (shouldOpen && this.loadState() === 'idle') this.loadRequested.emit('bulk');
      },
      { allowSignalWrites: true }
    );
  }

  openInNewTab(): void {
    this.panelViewLauncher.open({
      callId: this.callId(),
      block: this.block(),
      label: this.label(),
      rawValue: this.rawValue(),
    });
  }

  onToggle(event: Event): void {
    const open = (event.target as HTMLDetailsElement).open;
    this.open.set(open);
    // Opening is what pays for the fetch - a block the user never looks at never costs anything.
    if (open && this.loadState() === 'idle') this.loadRequested.emit('user');
  }

  retryLoad(): void {
    this.loadRequested.emit('user');
  }

  onSearchInput(value: string): void {
    this.searchQuery.set(value);
    this.activeMatchIndex.set(0);
    if (this.matchCount() > 0) {
      this.open.set(true);
      this.scrollToActiveMatch();
    }
  }

  toggleFilterMode(): void {
    this.filterLinesOnly.set(!this.filterLinesOnly());
  }

  setViewMode(mode: JsonViewMode): void {
    this.viewMode.set(mode);
  }

  /**
   * Tree nodes render a plain (unbound) `open` attribute rather than an
   * Angular [open] binding - that's what lets a user's individual
   * expand/collapse of one node survive later re-renders undisturbed. It
   * does mean a bulk expand/collapse has to reach in and flip the DOM
   * attribute directly, the same way scrollToActiveMatch already does.
   */
  setAllTreeNodesOpen(isOpen: boolean): void {
    const root = this.contentRoot()?.nativeElement;
    if (!root) return;
    root.querySelectorAll<HTMLDetailsElement>('details.tree-node').forEach((node) => {
      node.open = isOpen;
    });
  }

  nextMatch(delta: number): void {
    const count = this.matchCount();
    if (count === 0) return;
    this.activeMatchIndex.set(((this.activeMatchIndex() + delta) % count + count) % count);
    this.open.set(true);
    this.scrollToActiveMatch();
  }

  onAddComment(event: { lineIndex: number; lineText: string; comment: string }): void {
    this.commentsStore.addComment({
      callId: this.callId(),
      block: this.block(),
      lineIndex: event.lineIndex,
      lineText: event.lineText,
      comment: event.comment,
    });
  }

  onDeleteComment(id: string): void {
    this.commentsStore.deleteComment(this.callId(), id);
  }

  copyContent(): void {
    // baseText() is the exact clean pretty-printed text this panel renders from - copying it
    // directly, rather than reading the DOM's innerText, is both simpler and correct: innerText
    // would also pick up the line-number gutter and the per-line "+" comment buttons (confirmed
    // live - user-select: none on those elements only blocks mouse drag-selection, not
    // .innerText), and always copies the full untruncated content regardless of "Lines only"
    // filtering, matching the project's never-truncate-an-export rule. Flagged lines still get
    // the same inline "// ⚠ FLAGGED: ..." marker the markdown/HTML exports use (codeBlock() in
    // markdown-builder.ts) - the old innerText-based version accidentally preserved comment text
    // by scraping the DOM wholesale, so this reconstructs that intentionally instead.
    const byLine = this.commentsByLine();
    const annotated = this.baseText()
      .split('\n')
      .map((line, i) => {
        const onThisLine = byLine.get(i);
        if (!onThisLine || onThisLine.length === 0) return line;
        const notes = onThisLine.map((c) => `FLAGGED: ${c.comment}`).join(' | ');
        return `${line}  // ⚠ ${notes}`;
      })
      .join('\n');
    copyToClipboard(annotated).then(() => {
      this.copyFeedback.set(true);
      setTimeout(() => this.copyFeedback.set(false), 1200);
    });
  }

  private scrollToActiveMatch(): void {
    afterNextRender(
      () => {
        const root = this.contentRoot()?.nativeElement;
        if (!root) return;
        const marks = root.querySelectorAll<HTMLElement>('mark.hl');
        const mark = marks[this.activeMatchIndex()];
        const scrollable = root.querySelector<HTMLElement>('.scrollable');
        if (!mark || !scrollable) return;

        // In tree mode a match can be nested inside collapsed ancestor
        // nodes - closed <details> content is still in the DOM (just
        // display:none), so the match is found and counted either way, but
        // it's invisible and has a zero-size layout box until its ancestor
        // chain is opened. Do that before measuring anything below.
        this.revealAncestorTreeNodes(mark);

        // Tree mode computes each leaf's highlight tokens independently, so
        // its local matchIndex always restarts at 0 and can't line up with
        // the panel-wide activeMatchIndex the way flat mode's single
        // whole-text tokenization does - flat mode's [class.active] binding
        // already gets this right reactively, so only patch it directly
        // here for tree mode.
        if (this.effectiveViewMode() === 'tree') {
          root.querySelectorAll<HTMLElement>('mark.hl.active').forEach((el) => el.classList.remove('active'));
          mark.classList.add('active');
        }

        // mark.offsetTop is relative to its nearest *positioned* ancestor,
        // not necessarily the scrollable container - since nothing in this
        // tree sets position:relative, that ends up being the whole page,
        // which threw the "center the match" math off by however far the
        // panel sits down the page. getBoundingClientRect() sidesteps that
        // entirely by measuring both elements in the same (viewport) space.
        const markRect = mark.getBoundingClientRect();
        const scrollableRect = scrollable.getBoundingClientRect();
        const markOffsetWithinScrollable = markRect.top - scrollableRect.top + scrollable.scrollTop;
        const target = markOffsetWithinScrollable - scrollable.clientHeight / 2 + mark.offsetHeight / 2;
        scrollable.scrollTop = Math.max(0, target);
      },
      { injector: this.injector }
    );
  }

  private revealAncestorTreeNodes(mark: HTMLElement): void {
    // Only .tree-node details, not the outer .block panel - that one's open
    // state is driven by the `open` signal (set separately, before this
    // runs), so mutating its DOM attribute directly here would desync it
    // from that signal until the next unrelated change-detection pass.
    let node: HTMLElement | null = mark.parentElement;
    while (node) {
      if (node instanceof HTMLDetailsElement && node.classList.contains('tree-node') && !node.open) {
        node.open = true;
      }
      node = node.parentElement;
    }
  }
}
