import { Component, ElementRef, Injector, afterNextRender, computed, effect, inject, input, signal, viewChild } from '@angular/core';
import { JsonFlatViewComponent, LineTokens } from '../json-flat-view/json-flat-view.component';
import { JsonTreeComponent } from '../json-tree/json-tree.component';
import { CALL_LIST_CONTROLS_STATE } from '../../core/state/call-selection.tokens';
import { HighlightToken, highlightTokens, prettyJsonText, tokenizeJsonText, tryParseJson } from '../../shared/utils/json-tokenizer';
import { splitTokensIntoLines } from '../../shared/utils/line-tokenizer';
import { JsonViewMode } from '../../core/models/call.model';
import { Comment, CommentBlock } from '../../core/models/comment.model';
import { CommentsStore } from '../../core/state/comments-store.service';
import { PanelViewLauncherService } from '../../core/services/panel-view-launcher.service';

type ParsedValue = { hasJson: true; value: unknown } | { hasJson: false; plainText: string };

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
  imports: [JsonFlatViewComponent, JsonTreeComponent],
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

  readonly open = signal(true);
  readonly viewMode = signal<JsonViewMode>('flat');
  readonly filterLinesOnly = signal(false);
  readonly searchQuery = signal('');
  readonly activeMatchIndex = signal(0);

  readonly contentRoot = viewChild<ElementRef<HTMLElement>>('contentRoot');
  private lastSeenCollapseAllVersion = -1;

  readonly parsed = computed<ParsedValue>(() => {
    const value = this.rawValue();
    if (value !== null && value !== undefined && typeof value === 'object') {
      return { hasJson: true, value };
    }
    if (typeof value === 'string' && value.length > 0) {
      const result = tryParseJson(value);
      return result.ok ? { hasJson: true, value: result.value } : { hasJson: false, plainText: value };
    }
    return { hasJson: false, plainText: '' };
  });

  readonly effectiveViewMode = computed<JsonViewMode>(() => (this.parsed().hasJson ? this.viewMode() : 'flat'));

  /** Angular template expressions can't do TS type casts, so this exists purely to give the tree view an untyped value when we already know (via effectiveViewMode) that parsed() is the JSON branch. */
  readonly treeValue = computed<unknown>(() => {
    const p = this.parsed();
    return p.hasJson ? p.value : undefined;
  });

  private readonly baseText = computed(() => {
    const p = this.parsed();
    return p.hasJson ? prettyJsonText(p.value) : p.plainText || '(empty)';
  });

  // Every line of the full (unfiltered) text, highlighted, in original line
  // order. Each line's position in this array *is* its permanent identity -
  // comments key off it, so "Lines only" filtering below must hide lines,
  // never renumber them, or a comment would silently jump to the wrong line
  // the next time the filter is toggled off.
  private readonly allLines = computed<HighlightToken[][]>(() => {
    const tokens = highlightTokens(tokenizeJsonText(this.baseText()), this.searchQuery()).tokens;
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
        const version = this.state.collapseAllVersion();
        if (this.lastSeenCollapseAllVersion === -1 || version !== this.lastSeenCollapseAllVersion) {
          this.lastSeenCollapseAllVersion = version;
          this.open.set(this.state.expanded());
        }
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
    this.open.set((event.target as HTMLDetailsElement).open);
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
    const root = this.contentRoot()?.nativeElement;
    if (!root) return;
    navigator.clipboard.writeText(root.innerText).then(() => {
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
