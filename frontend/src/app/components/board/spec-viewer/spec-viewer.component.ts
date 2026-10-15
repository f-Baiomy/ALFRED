import { Component, ElementRef, HostListener, computed, effect, inject, signal, untracked } from '@angular/core';
import { ItemCall, MARK_LABELS, Mark, MentionRef, Requirement, VERDICT_LABELS } from '../../../core/models/board.models';
import { BoardApiService } from '../../../core/services/board-api.service';
import { BoardMentionsService } from '../../../core/services/board-mentions.service';
import { messageOf } from '../../../core/state/board-state.service';
import { acLabel, acOf, shortOf } from '../../../shared/utils/readable-refs';
import { MarkdownViewComponent } from '../markdown-view/markdown-view.component';
import { MentionChipComponent } from '../mention-chip/mention-chip.component';

/** Characters rendered at once; a bigger file shows "Show more" so a 5 MB spec never freezes the page. */
export const SPEC_PAGE_CHARS = 200_000;

/**
 * A spec file (FR-032): Markdown rendered for .md, plain text for .txt, opened at a #section when the mention named one,
 * with Download. Shown for whichever spec BoardMentionsService.specToShow names - from a chip anywhere or the file list.
 */
@Component({
  selector: 'app-spec-viewer',
  standalone: true,
  imports: [MarkdownViewComponent, MentionChipComponent],
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
          @if (item(); as it) {
            <div class="board-spec-ac">
              <div class="board-spec-ac-head"><b>{{ itemLabel() }}</b>
                <span [class]="'board-spec-verdict v-' + it.verdict.verdict">{{ verdictLabels[it.verdict.verdict] }}</span>
                @if (it.mark) { <span class="board-dim">· your mark: {{ markLabels[it.mark] }}</span> }</div>
              <div class="board-spec-ac-text">{{ it.text }}</div>
              <div class="board-spec-ac-acts">
                @for (m of marks; track m) {
                  <button type="button" class="board-tog" [class.on]="it.mark === m" [title]="'Mark ' + itemCode() + ' ' + markLabels[m]" (click)="mark(m)">{{ markLabels[m] }}</button>
                }
                <span class="board-dim">Short name</span>
                <input #short class="board-spec-ac-short" type="text" maxlength="60" [value]="it.shortName ?? ''" [placeholder]="derived()"
                       (keydown.enter)="saveShortName(short.value)" />
                <button type="button" class="board-link" (click)="saveShortName(short.value)">Save</button>
              </div>
              <div class="board-spec-ac-calls"><span class="board-dim">Its calls:</span>
                @for (c of calls(); track c.callId) { <app-mention-chip [mention]="callRef(c)" /> }
                @empty { <span class="board-dim">none judged yet</span> }
              </div>
            </div>
          }
          @if (isMarkdown()) {
            <app-markdown-view [text]="shownText()" idPrefix="spec-" [outline]="true" [specFile]="t.name" [cycleId]="t.cycleId" />
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
  private readonly host = inject(ElementRef<HTMLElement>);

  /** specs/021: the Acceptance item a reference opened (`#ac8`) - its verdict, marks, short name and the calls judged for it. */
  readonly item = signal<Requirement | null>(null);
  readonly calls = signal<readonly ItemCall[]>([]);
  readonly markLabels = MARK_LABELS;
  readonly verdictLabels = VERDICT_LABELS;
  readonly marks: readonly Mark[] = ['PASS', 'FAIL', 'CANT_TELL'];
  readonly itemCode = computed(() => `AC${acOf(this.target()?.section) ?? ''}`);
  readonly derived = computed(() => shortOf(this.item()?.text));
  readonly itemLabel = computed(() => {
    const it = this.item();
    const n = acOf(this.target()?.section);
    return it && n !== null ? acLabel(it.shortName || shortOf(it.text), n) : '';
  });

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
        this.item.set(null);
        this.calls.set([]);
        if (!t) return;
        const n = acOf(t.section);
        if (n !== null) this.loadItem(t.cycleId, n);
        this.api.spec(t.cycleId, t.name).subscribe({
          next: (text) => {
            this.text.set(text);
            if (t.section && n === null) setTimeout(() => document.getElementById(`spec-${t.section}`)?.scrollIntoView({ block: 'start' }));
            if (n !== null) setTimeout(() => this.pointAtItem());
          },
          error: (e) => this.error.set(messageOf(e)),
        });
      });
    });
  }

  private loadItem(cycleId: string, n: number): void {
    const asked = this.target();
    const still = () => this.target() === asked; // another reference opened meanwhile: drop this answer
    this.mentions.itemOf(cycleId, n).subscribe((it) => {
      if (!still()) return;
      this.item.set(it);
      if (!it) return;
      this.api.itemCalls(cycleId, it.fileName, it.itemKey).subscribe({
        next: (r) => { if (still()) this.calls.set(r.calls.filter((c) => c.result !== 'SKIPPED')); },
        error: () => undefined,
      });
      setTimeout(() => this.pointAtItem());
    });
  }

  /** The item's line in the rendered file: scrolled to and marked. */
  private pointAtItem(tries = 15): void {
    // the rendered line has no Markdown marks: compare the words only
    const words = (s: string) => s.replace(/[*_`~\\]/g, '').replace(/\s+/g, ' ').trim();
    const text = words(this.item()?.text ?? '');
    if (!text) return;
    const root = this.host.nativeElement as HTMLElement;
    const li = Array.from(root.querySelectorAll('li')).find((el) => words(el.textContent ?? '').includes(text));
    root.querySelectorAll('.board-spec-hl').forEach((el) => el.classList.remove('board-spec-hl'));
    if (!li) {
      // the file renders in its own time: look again for a moment
      if (tries > 0) setTimeout(() => this.pointAtItem(tries - 1), 150);
      return;
    }
    li.classList.add('board-spec-hl');
    li.scrollIntoView({ block: 'center' });
  }

  /** A judged call as its chip: what it showed, and when. */
  callRef(c: ItemCall): MentionRef {
    const words: Record<string, string> = { MEETS: 'met', NO_DATA: 'no data', WRONG: 'wrong result', CONTRADICTS: 'feature missing', UNKNOWN: 'unknown' };
    const at = new Date(c.at);
    const time = Number.isNaN(at.getTime()) ? '' : ` · ${at.toLocaleTimeString('en', { hour: 'numeric', minute: '2-digit' })}`;
    return { type: 'call', ref: `in:${c.callId}@${this.target()?.cycleId ?? ''}`, label: `${words[c.result] ?? c.result.toLowerCase()}${time}` };
  }

  mark(m: Mark): void {
    const t = this.target();
    const it = this.item();
    if (!t || !it) return;
    this.api.mark(t.cycleId, it.fileName, it.itemKey, m, '').subscribe({
      next: () => this.refresh(),
      error: (e) => this.error.set(messageOf(e)),
    });
  }

  saveShortName(name: string): void {
    const t = this.target();
    const it = this.item();
    if (!t || !it || name.trim() === (it.shortName ?? '')) return;
    this.api.setItemShortName(t.cycleId, it.fileName, it.itemKey, name.trim()).subscribe({
      next: () => this.refresh(),
      error: (e) => this.error.set(messageOf(e)),
    });
  }

  private refresh(): void {
    const t = this.target();
    const n = acOf(t?.section);
    this.mentions.forget();
    if (t && n !== null) this.loadItem(t.cycleId, n);
  }

  @HostListener('document:keydown.escape')
  close(): void {
    this.target.set(null);
  }
}
