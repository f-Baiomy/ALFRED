import { Component, ElementRef, Injector, afterNextRender, computed, effect, inject, input, signal, viewChild } from '@angular/core';
import { JsonFlatViewComponent } from '../json-flat-view/json-flat-view.component';
import { JsonTreeComponent } from '../json-tree/json-tree.component';
import { CallsStateService } from '../../core/state/calls-state.service';
import { HighlightToken, filterLinesContaining, highlightTokens, prettyJsonText, tokenizeJsonText, tryParseJson } from '../../shared/utils/json-tokenizer';
import { JsonViewMode } from '../../core/models/call.model';

type ParsedValue = { hasJson: true; value: unknown } | { hasJson: false; plainText: string };

/**
 * One Headers/Body block: owns its own search/filter/view-mode state.
 * Because Angular keeps this component instance alive across polling
 * re-renders (as long as the parent list's trackBy matches call identity),
 * none of that state needs to be externally persisted in a lookup map the
 * way the original vanilla-JS version required - it just lives here as
 * ordinary component state.
 */
@Component({
  selector: 'app-json-panel',
  standalone: true,
  imports: [JsonFlatViewComponent, JsonTreeComponent],
  templateUrl: './json-panel.component.html',
})
export class JsonPanelComponent {
  private readonly state = inject(CallsStateService);
  private readonly injector = inject(Injector);

  readonly label = input.required<string>();
  readonly rawValue = input<unknown>(undefined);
  readonly panelId = input<string | undefined>(undefined);

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

  readonly hiddenLinesNote = computed<string>(() => {
    const query = this.searchQuery();
    if (this.effectiveViewMode() !== 'flat' || !this.filterLinesOnly() || !query) return '';
    const { text, hiddenCount, totalCount } = filterLinesContaining(this.baseText(), query);
    if (text.trim().length === 0) return `No lines match - ${hiddenCount} hidden`;
    if (hiddenCount === 0) return '';
    return `${hiddenCount} of ${totalCount} lines hidden`;
  });

  readonly displayTokens = computed<HighlightToken[]>(() => {
    const query = this.searchQuery();
    let text = this.baseText();
    if (this.effectiveViewMode() === 'flat' && this.filterLinesOnly() && query) {
      text = filterLinesContaining(text, query).text;
    }
    return highlightTokens(tokenizeJsonText(text), query).tokens;
  });

  readonly matchCount = computed(() => this.displayTokens().filter((t) => t.highlighted).length);
  readonly copyFeedback = signal(false);

  constructor() {
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

  nextMatch(delta: number): void {
    const count = this.matchCount();
    if (count === 0) return;
    this.activeMatchIndex.set(((this.activeMatchIndex() + delta) % count + count) % count);
    this.open.set(true);
    this.scrollToActiveMatch();
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
}
