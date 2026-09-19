import { Component, ElementRef, computed, effect, input, output, signal, viewChild } from '@angular/core';
import { JsonTokensComponent } from '../../shared/components/json-tokens/json-tokens.component';
import { HighlightToken } from '../../shared/utils/json-tokenizer';
import { Comment } from '../../core/models/comment.model';
import { RedactionScope } from '../../core/models/redaction.model';
import { redactableNameOf } from '../../shared/utils/redact';

export type FlatViewVariant = 'json' | 'plain';

export interface LineTokens {
  readonly index: number;
  readonly tokens: readonly HighlightToken[];
}

export interface NewCommentEvent {
  readonly lineIndex: number;
  readonly lineText: string;
  readonly comment: string;
}

/**
 * Carries the KEY on the clicked line and nothing else. The value never leaves this component -
 * storing it would put the secret in a second place and, because exports echo a comment's stored
 * `lineText` verbatim, would reprint it in the very file the user redacted in order to share.
 */
export interface RedactionToggleEvent {
  readonly name: string;
  readonly hide: boolean;
  readonly scope: RedactionScope;
}

/**
 * Above this many lines the view stops rendering every row and windows instead (see `windowed`).
 * Measured on a real 640KB Amadeus SOAP body: 28,937 lines cost 186,734 DOM nodes and blocked the
 * main thread for 4,098ms, to show the ~20 rows that fit in the 380px box. Parsing and highlighting
 * that same body costs 45ms all in, so the freeze was never the tokenizer - it was node creation
 * plus layout, which is why windowing (and not a worker) is the fix.
 *
 * The threshold exists so ordinary bodies keep the exact markup and behaviour they always had -
 * wrapped plain text, naturally-sized comment cards, no fixed row height. Only the pathological
 * case takes the constrained path.
 */
export const WINDOWING_LINE_THRESHOLD = 2000;

/**
 * Windowed mode needs every row's height up front to place the scroll spacers, so these two are
 * pinned in CSS (.code-lines.windowed) rather than left to the content. Change one and you must
 * change the other, or rows will drift out of step with the scrollbar.
 */
const LINE_HEIGHT_PX = 19;
const COMMENT_CARD_HEIGHT_PX = 44;

/**
 * The composer is NOT pinned - it's measured (see composerHeight). Pinning it to a guessed 92px
 * was wrong: its textarea and button row need 102px, and with overflow visible the contents spilled
 * over the code lines above and below it. Its real height depends on the theme's font and button
 * padding, so any constant here would be a guess that some theme eventually breaks. This value is
 * only the reservation used before the first measurement lands.
 */
const COMPOSER_FALLBACK_HEIGHT_PX = 104;

/** Rendered beyond the viewport on each side, so a fast scroll doesn't expose blank rows. */
const OVERSCAN_PX = 200;

/** Fallback until the viewport has been measured - matches .scrollable's max-height. */
const ASSUMED_VIEWPORT_PX = 380;

/**
 * Renders one row per line (rather than one flat blob of tokens) so each
 * line can carry its own gutter: a hover "+" to flag an issue on that line,
 * GitHub-style, and any existing comments shown as cards right below it.
 *
 * Past WINDOWING_LINE_THRESHOLD lines only the rows near the viewport are rendered, with a spacer
 * above and below standing in for the rest. Rows are NOT uniform height - a line can carry comment
 * cards and an open composer - so this keeps its own prefix-sum offset table rather than using
 * CDK's fixed-size virtual scroll, which assumes one height for every item.
 */
@Component({
  selector: 'app-json-flat-view',
  standalone: true,
  imports: [JsonTokensComponent],
  templateUrl: './json-flat-view.component.html',
})
export class JsonFlatViewComponent {
  readonly lines = input.required<readonly LineTokens[]>();
  readonly variant = input<FlatViewVariant>('json');
  readonly activeMatchIndex = input<number>(-1);
  readonly scrollId = input<string | undefined>(undefined);
  readonly commentsByLine = input<ReadonlyMap<number, Comment[]>>(new Map());
  /** Lowercased key names already hidden for this call+block, so a line can render as hidden without this component knowing what a Redaction is. */
  readonly redactedNames = input<ReadonlySet<string>>(new Set<string>());

  readonly addComment = output<NewCommentEvent>();
  readonly deleteComment = output<string>();
  /** `name` is the JSON key on that line - never the value, which must not leave this component (see redaction.model.ts). */
  readonly toggleRedaction = output<RedactionToggleEvent>();

  readonly openCommentLineIndex = signal<number | null>(null);
  readonly openRedactLineIndex = signal<number | null>(null);
  readonly draftText = signal('');

  private readonly viewport = viewChild<ElementRef<HTMLElement>>('viewport');
  private readonly composerEl = viewChild<ElementRef<HTMLElement>>('composer');
  private readonly scrollTop = signal(0);
  private readonly viewportHeight = signal(ASSUMED_VIEWPORT_PX);

  /** The open composer's measured height - see COMPOSER_FALLBACK_HEIGHT_PX for why it isn't pinned. */
  private readonly composerHeight = signal(COMPOSER_FALLBACK_HEIGHT_PX);

  constructor() {
    // Measured rather than assumed, and re-measured on resize, so the offset table always reserves
    // what the composer actually occupies. It keeps its last measurement after the composer closes
    // or scrolls out of the window, which is exactly what the next open wants to reserve.
    effect(
      (onCleanup) => {
        const el = this.composerEl()?.nativeElement;
        if (!el) return;
        const measure = () => {
          if (el.offsetHeight > 0) this.composerHeight.set(el.offsetHeight);
        };
        measure();
        const observer = new ResizeObserver(measure);
        observer.observe(el);
        onCleanup(() => observer.disconnect());
      },
      { allowSignalWrites: true }
    );
  }

  readonly windowed = computed(() => this.lines().length > WINDOWING_LINE_THRESHOLD);

  /**
   * rowOffsets[i] is the pixel offset of row i from the top of the content, so rowOffsets[n] is the
   * full content height. Recomputed whenever a comment appears or the composer opens, which is the
   * whole reason this can't be a single multiplication.
   */
  private readonly rowOffsets = computed<readonly number[]>(() => {
    const lines = this.lines();
    const comments = this.commentsByLine();
    const composerLine = this.openCommentLineIndex();
    const offsets = new Array<number>(lines.length + 1);
    offsets[0] = 0;
    for (let i = 0; i < lines.length; i++) {
      const index = lines[i].index;
      let height = LINE_HEIGHT_PX;
      if (composerLine === index) height += this.composerHeight();
      height += (comments.get(index)?.length ?? 0) * COMMENT_CARD_HEIGHT_PX;
      offsets[i + 1] = offsets[i] + height;
    }
    return offsets;
  });

  /** Index of the last row starting at or before `y`. */
  private rowAt(y: number): number {
    const offsets = this.rowOffsets();
    let lo = 0;
    let hi = offsets.length - 2;
    if (hi < 0) return 0;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (offsets[mid] <= y) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }

  private readonly range = computed<{ start: number; end: number }>(() => {
    const total = this.lines().length;
    if (!this.windowed()) return { start: 0, end: total };
    const top = this.scrollTop();
    const start = this.rowAt(Math.max(0, top - OVERSCAN_PX));
    const end = Math.min(total, this.rowAt(top + this.viewportHeight() + OVERSCAN_PX) + 1);
    return { start, end };
  });

  readonly visibleLines = computed<readonly LineTokens[]>(() => {
    const { start, end } = this.range();
    return this.windowed() ? this.lines().slice(start, end) : this.lines();
  });

  /** Total height of every row, rendered or not - what the spacers plus the window must add up to. */
  readonly contentHeightPx = computed(() => {
    const offsets = this.rowOffsets();
    return offsets[offsets.length - 1];
  });

  readonly spacerTopPx = computed(() => (this.windowed() ? this.rowOffsets()[this.range().start] : 0));

  readonly spacerBottomPx = computed(() =>
    this.windowed() ? this.contentHeightPx() - this.rowOffsets()[this.range().end] : 0
  );

  onScroll(): void {
    const el = this.viewport()?.nativeElement;
    if (!el) return;
    this.scrollTop.set(el.scrollTop);
    this.viewportHeight.set(el.clientHeight);
  }

  /**
   * Centres a row by array position (NOT by LineTokens.index - "Lines only" filtering makes those
   * diverge). Used by the panel's jump-to-match, which can't rely on finding a <mark> in the DOM
   * once the match's row may never have been rendered.
   */
  scrollToRow(position: number): boolean {
    const el = this.viewport()?.nativeElement;
    if (!el || !this.windowed()) return false;
    const offsets = this.rowOffsets();
    if (position < 0 || position >= offsets.length - 1) return false;
    el.scrollTop = Math.max(0, offsets[position] - el.clientHeight / 2 + LINE_HEIGHT_PX / 2);
    this.onScroll();
    return true;
  }

  toggleAddComment(lineIndex: number): void {
    this.openCommentLineIndex.set(this.openCommentLineIndex() === lineIndex ? null : lineIndex);
    this.draftText.set('');
  }

  cancelAddComment(): void {
    this.openCommentLineIndex.set(null);
    this.draftText.set('');
  }

  redactableName(line: LineTokens): string | null {
    return redactableNameOf(line.tokens.map((t) => t.text).join(''));
  }

  isRedacted(line: LineTokens): boolean {
    const name = this.redactableName(line);
    return name !== null && this.redactedNames().has(name.toLowerCase());
  }

  /** Already hidden, so one click un-hides; otherwise open the scope menu, because "this call" vs "everywhere" is the user's call to make, never inferred. */
  toggleRedact(line: LineTokens, event: Event): void {
    event.stopPropagation();
    const name = this.redactableName(line);
    if (!name) return;
    if (this.isRedacted(line)) {
      this.toggleRedaction.emit({ name, hide: false, scope: 'call' });
      this.openRedactLineIndex.set(null);
      return;
    }
    this.openRedactLineIndex.set(this.openRedactLineIndex() === line.index ? null : line.index);
  }

  chooseRedact(line: LineTokens, scope: RedactionScope): void {
    const name = this.redactableName(line);
    if (name) this.toggleRedaction.emit({ name, hide: true, scope });
    this.openRedactLineIndex.set(null);
  }

  submitComment(line: LineTokens): void {
    const comment = this.draftText().trim();
    if (!comment) return;
    this.addComment.emit({
      lineIndex: line.index,
      lineText: line.tokens.map((t) => t.text).join(''),
      comment,
    });
    this.cancelAddComment();
  }
}
