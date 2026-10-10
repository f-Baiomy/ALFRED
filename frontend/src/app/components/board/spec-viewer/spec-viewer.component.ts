import { Component, HostListener, computed, effect, inject, signal, untracked } from '@angular/core';
import { BoardApiService } from '../../../core/services/board-api.service';
import { BoardMentionsService } from '../../../core/services/board-mentions.service';
import { messageOf } from '../../../core/state/board-state.service';
import { MarkdownViewComponent } from '../markdown-view/markdown-view.component';

/** Characters rendered at once; a bigger file shows "Show more" so a 5 MB spec never freezes the page. */
export const SPEC_PAGE_CHARS = 200_000;

/**
 * A spec file (FR-032): Markdown rendered for .md, plain text for .txt, opened at a #section when the mention named one,
 * with Download. Shown for whichever spec BoardMentionsService.specToShow names - from a chip anywhere or the file list.
 */
@Component({
  selector: 'app-spec-viewer',
  standalone: true,
  imports: [MarkdownViewComponent],
  template: `
    @if (target(); as t) {
      <div class="dialog-backdrop" (click)="close()">
        <div class="dialog-card board-spec" (click)="$event.stopPropagation()">
          <div class="board-spec-bar">
            <span>📄 {{ t.name }}</span>
            <span>
              <a class="board-link" [href]="downloadUrl()" [attr.download]="t.name">Download</a> ·
              <button type="button" class="board-link" (click)="close()">Close</button>
            </span>
          </div>
          @if (error()) { <div class="board-error">{{ error() }}</div> }
          @if (isMarkdown()) {
            <app-markdown-view [text]="shownText()" idPrefix="spec-" />
          } @else {
            <pre class="board-md-pre">{{ shownText() }}</pre>
          }
          @if (text().length > shown()) {
            <button type="button" class="action-btn" (click)="shown.set(shown() + pageChars)">Show more ({{ remainingKb() }} KB left)</button>
          }
        </div>
      </div>
    }`,
})
export class SpecViewerComponent {
  private readonly api = inject(BoardApiService);
  private readonly mentions = inject(BoardMentionsService);

  readonly target = this.mentions.specToShow;
  readonly text = signal('');
  readonly error = signal<string | null>(null);
  readonly pageChars = SPEC_PAGE_CHARS;
  readonly shown = signal(SPEC_PAGE_CHARS);
  readonly isMarkdown = computed(() => /\.md$/i.test(this.target()?.name ?? ''));
  readonly shownText = computed(() => this.text().slice(0, this.shown()));
  readonly remainingKb = computed(() => Math.ceil((this.text().length - this.shown()) / 1024));
  readonly downloadUrl = computed(() => {
    const t = this.target();
    return t ? this.api.specUrl(t.cycleId, t.name) : '';
  });

  constructor() {
    effect(() => {
      const t = this.target();
      untracked(() => {
        this.text.set('');
        this.shown.set(SPEC_PAGE_CHARS);
        this.error.set(null);
        if (!t) return;
        this.api.spec(t.cycleId, t.name).subscribe({
          next: (text) => {
            this.text.set(text);
            if (t.section) setTimeout(() => document.getElementById(`spec-${t.section}`)?.scrollIntoView({ block: 'start' }));
          },
          error: (e) => this.error.set(messageOf(e)),
        });
      });
    });
  }

  @HostListener('document:keydown.escape')
  close(): void {
    this.target.set(null);
  }
}
