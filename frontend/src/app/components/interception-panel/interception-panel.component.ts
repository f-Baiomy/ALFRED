import { Component, ElementRef, computed, input, output, signal, viewChild } from '@angular/core';
import { CallInterception, OriginalHttp, actionPhase, wasEditedByHand } from '../../core/models/interception.model';
import { JsonTokensComponent } from '../../shared/components/json-tokens/json-tokens.component';
import { copyToClipboard } from '../../shared/utils/clipboard';
import {
  CopySection,
  DiffLineTokens,
  HttpDiff,
  SearchScope,
  buildHttpDiff,
  copyableView,
  highlightLine,
  lineOfMatch,
  searchBody,
  searchHeaders,
} from '../../shared/utils/interception-diff';

/**
 * Above this many body lines the panel stops building every row and windows instead.
 *
 * Lower than the flat view's 2,000 for two reasons: this box is 340px, so about eighteen rows are
 * ever visible, and a single call can have BOTH panels expanded - request and response - each
 * paying the cost. Below the threshold the markup and behaviour are exactly what they were.
 */
export const PANEL_WINDOW_THRESHOLD = 600;

/**
 * Row height, pinned in CSS (.intercept-body.windowed .il) rather than left to the content.
 * Change one and you must change the other or the rows drift out of step with the scrollbar.
 *
 * Unlike the flat view, every row here is the same height - no comment cards, no composer - so
 * the offset table it needs collapses to one multiplication.
 */
const ROW_HEIGHT_PX = 19;

/** Rows built beyond the viewport, so a flick of the wheel does not show blank space. */
const OVERSCAN_PX = 160;

/** Which side of the change the user is looking at. */
export type InterceptView = 'diff' | 'original' | 'final';

/**
 * What an interception rule changed about one call, and both sides of the change.
 *
 * The reason this exists is that without it the call log is misleading rather than merely
 * incomplete: a request a rule rewrote is recorded as though the client sent it that way, so
 * "the booking failed" cannot be traced to the edit that caused it. Showing only the final
 * version of an edited call is the one thing a traffic logger must not do.
 *
 * Rendered per phase - one instance for the request band, one for the response band - so each
 * sits with the half it describes rather than in a separate section the reader has to correlate.
 *
 * The diff is computed lazily, on first open, and memoised. A line diff of two large bodies is
 * real work on the main thread, and it must never run for a collapsed card or a list row.
 */
@Component({
  selector: 'app-interception-panel',
  standalone: true,
  imports: [JsonTokensComponent],
  templateUrl: './interception-panel.component.html',
})
export class InterceptionPanelComponent {
  readonly interception = input.required<CallInterception>();
  readonly phase = input.required<'request' | 'response'>();

  /** The call as it is stored - i.e. what actually went out, or what the caller actually got. */
  readonly current = input<OriginalHttp | null>(null);

  /**
   * Asked for when the panel is first opened. The card fetches request/response detail per block,
   * lazily, so the "after" side of the diff is not in hand until something asks for it - and this
   * panel is the only thing that needs BOTH halves without the user opening either block.
   */
  readonly detailNeeded = output<void>();

  /**
   * Drawn inside another panel (the Resent panel's request/response views) rather than on its
   * own: no head, no action list, always open - just the before/after/diff viewer with its tools.
   */
  readonly embedded = input(false);

  /** Replaces the default before/after words and legend - the Resent panel's sides are two calls, not a rule's in and out. */
  readonly labels = input<{ readonly title: string; readonly before: string; readonly after: string; readonly legend: string } | null>(null);

  readonly open = signal(false);
  readonly expanded = computed(() => this.embedded() || this.open());
  readonly view = signal<InterceptView>('diff');

  readonly original = computed<OriginalHttp | null>(() =>
    this.phase() === 'request'
      ? this.interception().originalRequest ?? null
      : this.interception().originalResponse ?? null
  );

  /**
   * The "after" side. Prefers the proxy's own final snapshot over the logged call, because the
   * logged REQUEST is written before a request breakpoint can edit it - diffing against it would
   * report no change on a call the record says was edited by hand.
   */
  private readonly rawFinal = computed<OriginalHttp | null>(() =>
    this.phase() === 'request'
      ? this.interception().finalRequest ?? null
      : this.interception().finalResponse ?? null
  );

  readonly after = computed<OriginalHttp | null>(() => this.rawFinal() ?? this.current());

  /**
   * A response that exists with no upstream one behind it - mocked, so the host was never
   * contacted. There is nothing to diff against, and saying "upstream answered X and we changed
   * it" would be a lie about a call that never happened.
   */
  readonly synthetic = computed(() => this.original() === null && this.rawFinal() !== null);

  /**
   * Nothing to show when this half came out the way it went in - absent is not the same as
   * unchanged. One side on its own is enough, which is what makes the mocked case visible.
   */
  readonly hasChange = computed(() => this.original() !== null || this.rawFinal() !== null);

  /**
   * The "before" the diff is actually drawn against. For a mock there is no before, and an empty
   * one renders the whole thing as added - which is exactly the truth: none of it came from the
   * host.
   */
  private readonly diffBase = computed<OriginalHttp | null>(() =>
    this.original() ?? (this.synthetic() ? { headers: {}, body: '' } : null)
  );

  readonly editedByHand = computed(() => wasEditedByHand(this.interception()));

  /**
   * Only the actions for this phase. A card's request band should not explain what happened to
   * the response, and vice versa - the summary sits under the half it describes.
   */
  readonly actions = computed(() => {
    const request = this.phase() === 'request';
    return this.interception().applied.filter((a) => {
      if (a.action.startsWith('BREAKPOINT_')) return true;
      const isResponseAction = actionPhase(a.action) === 'response';
      return request ? !isResponseAction : isResponseAction;
    });
  });

  /**
   * Recomputed whenever the current side arrives, because it arrives asynchronously - the card
   * fetches it only once this panel asks. Guarded on `open` so it never runs for a card nobody
   * opened: a line diff of two large bodies is real work on the main thread.
   */
  private readonly computed = computed<HttpDiff | null>(() =>
    this.expanded() ? buildHttpDiff(this.diffBase(), this.after()) : null
  );

  readonly diff = this.computed;

  /** The current side has not arrived yet - shown as loading rather than as an empty diff. */
  readonly awaitingDetail = computed(() => this.expanded() && this.after() == null);

  readonly summary = computed(() => {
    if (this.synthetic()) return 'nothing was sent to the host';
    const diff = this.computed();
    if (!diff) return '';
    const parts: string[] = [];
    if (diff.statusChange) parts.push(diff.statusChange);
    if (diff.urlChange) parts.push('url');
    if (diff.headersChanged) parts.push('headers');
    if (diff.bodyChanged) parts.push('body');
    return parts.length ? parts.join(' · ') : 'no textual difference';
  });

  readonly label = computed(() => {
    const override = this.labels();
    if (override) return override;
    if (this.synthetic()) {
      return {
        title: 'Alfred answered this — the host was never contacted',
        before: 'Nothing from the host',
        after: 'What the caller received',
      };
    }
    return this.phase() === 'request'
      ? { title: 'Request was modified before sending', before: 'As the client sent it', after: 'As Alfred sent it' }
      : { title: 'Response was changed before the caller saw it', before: 'As upstream answered', after: 'As the caller received it' };
  });

  toggle(): void {
    const opening = !this.open();
    this.open.set(opening);
    if (opening) {
      this.detailNeeded.emit();
    }
  }

  show(view: InterceptView): void {
    this.view.set(view);
    // The query survives - you switch sides to look for the same thing - but the position in the
    // results does not, because a different view has a different number of them.
    this.matchIndex.set(0);
  }

  /** The body to render when showing one side rather than the diff. */
  readonly sideLines = computed(() => {
    const diff = this.computed();
    if (!diff) return [];
    const keep = this.view() === 'original' ? 'added' : 'removed';
    return diff.body.filter((line) => line.kind !== keep);
  });

  readonly sideHeaders = computed(() => {
    const diff = this.computed();
    if (!diff) return [];
    const keep = this.view() === 'original' ? 'added' : 'removed';
    return diff.headers.filter((row) => row.kind !== keep);
  });

  // ---- reading it: search, copy, and what is actually on screen ----------------------------

  readonly query = signal('');
  readonly matchIndex = signal(0);
  readonly scope = signal<SearchScope>('all');
  /** Which copy button last fired, so the one that copied is the one that confirms. */
  readonly copiedSection = signal<CopySection | null>(null);

  private readonly viewport = viewChild<ElementRef<HTMLElement>>('bodyViewport');
  private readonly scrollTop = signal(0);
  private readonly viewportHeight = signal(340);

  /** Whichever side the view buttons chose - everything below works on THIS, not on the call. */
  private readonly shownHeaders = computed(() =>
    this.view() === 'diff' ? this.computed()?.headers ?? [] : this.sideHeaders()
  );

  readonly shownBody = computed(() =>
    this.view() === 'diff' ? this.computed()?.body ?? [] : this.sideLines()
  );

  /** The query as each section sees it - empty for a section the scope excludes. */
  private readonly headerQuery = computed(() => (this.scope() === 'body' ? '' : this.query()));
  private readonly bodyQuery = computed(() => (this.scope() === 'headers' ? '' : this.query()));

  /**
   * Headers are marked eagerly - there are tens of them and they are all on screen. The body is
   * only COUNTED here; building its tokens happens per visible row, which is what lets a
   * 28,000-line body be searched without building 28,000 rows' worth of them per keystroke.
   *
   * Numbering runs continuously from the headers into the body, so "3 of 7" means the third
   * thing down the panel rather than the third within whichever section counted first.
   */
  private readonly headerSearch = computed(() => searchHeaders(this.shownHeaders(), this.headerQuery()));

  private readonly bodySearch = computed(() =>
    searchBody(this.shownBody(), this.bodyQuery(), this.headerSearch().count)
  );

  readonly searchedHeaders = computed(() => this.headerSearch().rows);

  readonly matchCount = computed(() => this.headerSearch().count + this.bodySearch().count);

  readonly matchLabel = computed(() => {
    const total = this.matchCount();
    if (!this.query()) return '';
    return total === 0 ? 'no matches' : `${Math.min(this.matchIndex() + 1, total)}/${total}`;
  });

  /** Which match the token renderer should draw as the current one. */
  readonly activeMatch = computed(() => (this.matchCount() === 0 ? -1 : this.matchIndex()));

  // ---- windowing ---------------------------------------------------------------------------
  //
  // The panel used to build every line of both halves into a 340px box that shows about
  // eighteen. With colouring that is one DOM node per TOKEN, so a large response cost tens of
  // thousands of nodes to display a couple of dozen rows - and a call can have both panels open
  // at once. Same mechanism as the call view's flat view, minus its offset table: every row here
  // is the same height, so the arithmetic is a multiplication.

  readonly windowed = computed(() => this.shownBody().length > PANEL_WINDOW_THRESHOLD);

  private readonly range = computed<{ start: number; end: number }>(() => {
    const total = this.shownBody().length;
    if (!this.windowed()) return { start: 0, end: total };
    const start = Math.max(0, Math.floor((this.scrollTop() - OVERSCAN_PX) / ROW_HEIGHT_PX));
    const end = Math.min(
      total,
      Math.ceil((this.scrollTop() + this.viewportHeight() + OVERSCAN_PX) / ROW_HEIGHT_PX)
    );
    return { start, end };
  });

  /** Only these rows are built. Each is told the global number of its first match. */
  readonly visibleLines = computed<readonly DiffLineTokens[]>(() => {
    const { start, end } = this.range();
    const body = this.shownBody();
    const search = this.bodySearch();
    const query = this.bodyQuery();
    const out: DiffLineTokens[] = [];
    for (let i = start; i < end; i++) {
      out.push(highlightLine(body[i], query, search.firstIndex[i]));
    }
    return out;
  });

  readonly spacerTopPx = computed(() => (this.windowed() ? this.range().start * ROW_HEIGHT_PX : 0));

  readonly spacerBottomPx = computed(() =>
    this.windowed() ? (this.shownBody().length - this.range().end) * ROW_HEIGHT_PX : 0
  );

  onBodyScroll(): void {
    const el = this.viewport()?.nativeElement;
    if (!el) return;
    this.scrollTop.set(el.scrollTop);
    this.viewportHeight.set(el.clientHeight);
  }

  /** JSON, XML or nothing worth naming - stated, so the reader never has to guess why it is plain. */
  readonly kindLabel = computed(() => {
    const kind = this.computed()?.kind;
    return kind === 'json' ? 'JSON' : kind === 'xml' ? 'XML' : '';
  });

  readonly bodyStats = computed(() => {
    const lines = this.shownBody().length;
    if (lines === 0) return '';
    const bytes = this.shownBody().reduce((total, line) => total + line.text.length + 1, 0);
    return `${lines.toLocaleString()} ${lines === 1 ? 'line' : 'lines'} · ${(bytes / 1024).toFixed(1)} KB`;
  });

  onQuery(event: Event): void {
    this.query.set((event.target as HTMLInputElement).value);
    this.matchIndex.set(0);
    this.revealMatch();
  }

  setScope(scope: SearchScope): void {
    this.scope.set(scope);
    this.matchIndex.set(0);
    this.revealMatch();
  }

  step(delta: number): void {
    const total = this.matchCount();
    if (total === 0) return;
    this.matchIndex.set((this.matchIndex() + delta + total) % total);
    this.revealMatch();
  }

  /**
   * Scrolls the current match into view.
   *
   * It works out WHICH ROW the match is on and scrolls by offset - it cannot look for the
   * `<mark>` in the DOM, because once the panel windows that row may never have been built. The
   * flat view carries a comment recording the same lesson.
   */
  private revealMatch(): void {
    queueMicrotask(() => {
      const row = lineOfMatch(this.bodySearch(), this.matchIndex());
      const el = this.viewport()?.nativeElement;
      if (row < 0 || !el) return;
      const target = row * ROW_HEIGHT_PX - el.clientHeight / 2 + ROW_HEIGHT_PX / 2;
      el.scrollTop = Math.max(0, target);
      this.onBodyScroll();
    });
  }

  /**
   * Copies a section of exactly what is on screen.
   *
   * "all" takes the status, headers and body together, because body alone would drop the status
   * change - on most of these panels that is the headline. A single section is copied WITHOUT
   * the surrounding labels: copying just the body is almost always in order to replay it.
   */
  copy(section: CopySection): void {
    const diff = this.computed();
    if (!diff) return;
    const text = copyableView({
      statusChange: diff.statusChange,
      urlChange: diff.urlChange,
      headers: this.shownHeaders(),
      body: this.shownBody(),
      // A single side is copied clean, with no markers, so it can be replayed as-is.
      showMarkers: this.view() === 'diff',
      section,
    });
    copyToClipboard(text).then(
      () => {
        this.copiedSection.set(section);
        setTimeout(() => this.copiedSection.set(null), 1600);
      },
      () => undefined
    );
  }

  /** What the "everything" copy button is called, which is also what it copies. */
  readonly copyAllLabel = computed(() => {
    if (this.view() === 'diff') return 'Diff';
    return this.phase() === 'request' ? 'Request' : 'Response';
  });
}
