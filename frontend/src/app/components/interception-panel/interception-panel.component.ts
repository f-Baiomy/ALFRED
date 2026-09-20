import { Component, computed, input, output, signal } from '@angular/core';
import { CallInterception, OriginalHttp, wasEditedByHand } from '../../core/models/interception.model';
import { JsonTokensComponent } from '../../shared/components/json-tokens/json-tokens.component';
import { copyToClipboard } from '../../shared/utils/clipboard';
import {
  HttpDiff,
  buildHttpDiff,
  copyableView,
  searchView,
} from '../../shared/utils/interception-diff';

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

  readonly open = signal(false);
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
      const isResponseAction = a.action.includes('RESPONSE') && a.action !== 'MOCK_RESPONSE';
      return request ? !isResponseAction : isResponseAction;
    });
  });

  /**
   * Recomputed whenever the current side arrives, because it arrives asynchronously - the card
   * fetches it only once this panel asks. Guarded on `open` so it never runs for a card nobody
   * opened: a line diff of two large bodies is real work on the main thread.
   */
  private readonly computed = computed<HttpDiff | null>(() =>
    this.open() ? buildHttpDiff(this.diffBase(), this.after()) : null
  );

  readonly diff = this.computed;

  /** The current side has not arrived yet - shown as loading rather than as an empty diff. */
  readonly awaitingDetail = computed(() => this.open() && this.after() == null);

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
  readonly copied = signal(false);

  /** Whichever side the view buttons chose - everything below works on THIS, not on the call. */
  private readonly shownHeaders = computed(() =>
    this.view() === 'diff' ? this.computed()?.headers ?? [] : this.sideHeaders()
  );

  private readonly shownBody = computed(() =>
    this.view() === 'diff' ? this.computed()?.body ?? [] : this.sideLines()
  );

  /**
   * Headers and body with the query marked, numbered in reading order down the panel.
   *
   * One call for both, because the numbering has to be continuous across them: a match count
   * that restarted at the body would make "3 of 7" ambiguous about which 3.
   */
  private readonly searched = computed(() =>
    searchView(this.shownHeaders(), this.shownBody(), this.query())
  );

  readonly searchedHeaders = computed(() => this.searched().headers);
  readonly searchedBody = computed(() => this.searched().body);

  readonly matchLabel = computed(() => {
    const total = this.searched().matchCount;
    if (!this.query()) return '';
    return total === 0 ? 'no matches' : `${Math.min(this.matchIndex() + 1, total)}/${total}`;
  });

  /** Which match the token renderer should draw as the current one. */
  readonly activeMatch = computed(() => (this.searched().matchCount === 0 ? -1 : this.matchIndex()));

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

  /** True once a body is big enough that it is deliberately not being coloured - see MAX_COLOURED_LINES. */
  readonly monochrome = computed(() => {
    const body = this.shownBody();
    return body.length > 0 && this.kindLabel() !== '' && body.every((line) => line.tokens === null);
  });

  onQuery(event: Event): void {
    this.query.set((event.target as HTMLInputElement).value);
    this.matchIndex.set(0);
  }

  step(delta: number): void {
    const total = this.searched().matchCount;
    if (total === 0) return;
    this.matchIndex.set((this.matchIndex() + delta + total) % total);
    this.scrollToActiveMatch();
  }

  /**
   * Puts the current match on screen. The token renderer marks it with `.active`, so finding it
   * is a query for that class rather than arithmetic over line heights - which would be wrong
   * the moment a line wraps.
   */
  private scrollToActiveMatch(): void {
    queueMicrotask(() => {
      const active = document.querySelector('.intercept-panel-body mark.hl.active');
      active?.scrollIntoView({ block: 'center', behavior: 'auto' });
    });
  }

  /**
   * Copies exactly what is on screen: status, headers and body of the current view.
   *
   * Body alone would drop the status change, which on most of these panels is the headline -
   * "200 → 500" is usually the whole reason somebody opened this.
   */
  copy(): void {
    const diff = this.computed();
    if (!diff) return;
    const text = copyableView({
      statusChange: diff.statusChange,
      urlChange: diff.urlChange,
      headers: this.shownHeaders(),
      body: this.shownBody(),
      // A single side is copied clean, with no markers, so it can be replayed as-is.
      showMarkers: this.view() === 'diff',
    });
    copyToClipboard(text).then(
      () => this.flashCopied(),
      () => undefined
    );
  }

  private flashCopied(): void {
    this.copied.set(true);
    setTimeout(() => this.copied.set(false), 1600);
  }

  copyLabel(): string {
    if (this.copied()) return '✓ Copied';
    return this.view() === 'diff' ? '⧉ Copy diff' : '⧉ Copy';
  }
}
