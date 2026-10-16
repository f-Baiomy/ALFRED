import {
  Component, DestroyRef, ElementRef, Injector, afterNextRender, computed, effect, inject, input, output, signal, untracked, viewChild,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { filter } from 'rxjs';
import { BriefComment, CycleBrief } from '../../../core/models/board.models';
import { briefParts, briefThreads, decisionsOf, itemsOf } from '../../../shared/utils/task-view';
import { QuoteRange, clearHighlights, paintHighlights, quoteRanges, rangeAt } from '../../../shared/utils/brief-highlights';
import { BoardApiService } from '../../../core/services/board-api.service';
import { BoardSocketService } from '../../../core/services/board-socket.service';
import { messageOf } from '../../../core/state/board-state.service';
import { BriefCommentsComponent } from '../brief-comments/brief-comments.component';
import { MarkdownViewComponent } from '../markdown-view/markdown-view.component';
import { MentionEditorComponent } from '../mention-editor/mention-editor.component';
import { BoardPagesComponent } from '../visuals/board-pages.component';
import { BoardPinnedComponent } from '../visuals/board-pinned.component';

/** The longest passage a comment quotes. */
const QUOTE_MAX = 2000;

/**
 * The task a session cycle is for (FR-030, skills/_shared/rules.md §0): Markdown with mentions, edited in place - by
 * the user or by Claude (/alfred-setup, /alfred-spec; "edited by Claude" and Restore previous, specs/015). Shown by
 * its sections - the goal, the ticket's description as written beside scope / out of scope, and the decisions every
 * later session must keep; Test steps and Data show in the Task tab's Test plan. A brief without sections shows whole.
 * Beside it, the comments (specs/024): select a passage to comment on it; commented passages are highlighted.
 */
@Component({
  selector: 'app-cycle-brief',
  standalone: true,
  host: { '(document:mousedown)': 'outside($event)' },
  imports: [BoardPagesComponent, BoardPinnedComponent, BriefCommentsComponent, MarkdownViewComponent, MentionEditorComponent],
  template: `
    <div class="tv-bwrap">
      <div class="tv-bmain">
        <div class="tv-bhead">
          @if (brief()?.updatedBy === 'CLAUDE') { <span class="board-ai">✦ edited by Claude</span> · }
          @if (brief()?.updatedAt) { <span>edited {{ when(brief()!.updatedAt!) }}</span> }
          <span class="tv-grow"></span>
          @if (editable() && brief()?.hasPrevious && !editing()) {
            <button type="button" class="board-link" title="Put back the brief this edit replaced (a second click undoes it)" (click)="restore()">Restore previous</button>
          }
          @if (editable() && !editing()) { <button type="button" class="board-link" (click)="editing.set(true)">✎ Edit</button> }
        </div>
        @if (editing()) {
          <app-mention-editor [value]="brief()?.text ?? template" [project]="project()" [cycleId]="cycleId()" submitLabel="Save"
                              [attach]="{ cycle: cycleId(), project: project() }"
                              [cancellable]="true" [allowEmpty]="true" [rows]="14" [enterSends]="false" [draftKey]="'brief:' + cycleId()"
                              placeholder="What is this task? The ticket, its description, scope, test steps… type @ to mention"
                              (submitted)="save($event)" (cancelled)="editing.set(false)" />
        } @else {
          <div #body class="tv-bbody" (mouseup)="selected($event)" (mousemove)="hover($event)" (mouseleave)="hoverId.set(null)" (click)="clickPassage($event)">
            @let p = parts();
            @if (p.goal) {
              <div class="tv-bgoal"><span class="tv-bh">The task</span>
                <app-markdown-view [text]="p.goal" [idPrefix]="'brief-' + cycleId() + '-goal-'" [snippetOwner]="'inline:cycle:' + cycleId() + ':goal'" [snippetContext]="{ cycleId: cycleId(), project: project() }" /></div>
            }
            @if (p.sections['task']) {
              <details class="tv-btask"><summary>Ticket, branches and code</summary>
                <app-markdown-view [text]="p.sections['task']" [idPrefix]="'brief-' + cycleId() + '-task-'" /></details>
            }
            @if (p.sections['description'] || scope().length || outOfScope().length) {
              <div class="tv-brow">
                @if (p.sections['description']) {
                  <section class="tv-bsec tv-bdesc">
                    <h5>Description <span>as the ticket says it</span></h5>
                    <app-markdown-view [text]="p.sections['description']" [idPrefix]="'brief-' + cycleId() + '-desc-'" [snippetOwner]="'inline:cycle:' + cycleId() + ':desc'" [snippetContext]="{ cycleId: cycleId(), project: project() }" />
                  </section>
                }
                @if (scope().length || outOfScope().length) {
                  <section class="tv-bsec">
                    @if (scope().length) {
                      <h5>In scope</h5>
                      <ul class="tv-marks">@for (s of scope(); track $index) { <li class="in">{{ s }}</li> }</ul>
                    }
                    @if (outOfScope().length) {
                      <h5>Out of scope <span>never carded</span></h5>
                      <ul class="tv-marks">@for (s of outOfScope(); track $index) { <li class="out">{{ s }}</li> }</ul>
                    }
                  </section>
                }
              </div>
            }
            @if (steps().length || data().length) {
              <div class="tv-brow">
                @if (steps().length) {
                  <section class="tv-bsec">
                    <h5>Test steps <span>ticked in the Test plan</span></h5>
                    <ol class="tv-steps">@for (s of steps(); track $index) { <li>{{ s }}</li> }</ol>
                  </section>
                }
                @if (data().length) {
                  <section class="tv-bsec">
                    <h5>Test data</h5>
                    <ul class="tv-marks">@for (d of data(); track $index) { <li class="dot">{{ d }}</li> }</ul>
                  </section>
                }
              </div>
            }
            @if (decisions().length) {
              <section class="tv-bsec">
                <h5>Decisions <span>binding for every session</span></h5>
                @for (d of decisions(); track $index) {
                  <div class="tv-dec"><span class="tv-when">{{ d.date ?? '' }}</span>
                    <app-markdown-view [text]="d.text" [idPrefix]="'brief-' + cycleId() + '-dec' + $index + '-'" /></div>
                }
              </section>
            }
            @for (o of p.other; track $index) {
              <section class="tv-bsec">
                @if (o.title) { <h5>{{ o.title }}</h5> }
                <app-markdown-view [text]="o.text" [idPrefix]="'brief-' + cycleId() + '-o' + $index + '-'" [snippetOwner]="'inline:cycle:' + cycleId() + ':o' + $index" [snippetContext]="{ cycleId: cycleId(), project: project() }" />
              </section>
            }
            @if (!brief()?.text?.trim()) {
              <div class="board-dim">No brief yet - say what the task is: the ticket, its description, scope, test steps.
                @if (editable()) { <button type="button" class="board-link" (click)="editing.set(true)">Start from the template</button> }
                or <code>/alfred-setup</code> drafts it from the ticket.</div>
            }
          </div>
        }
        @if (project() !== null) {
          <div class="tv-att">
            <app-board-pinned [owner]="'cycle:' + cycleId()" [project]="project()" [canEdit]="editable()" [context]="{ cycleId: cycleId(), project: project() }" />
            @if (project()) {
              <app-board-pages [owner]="'cycle:' + cycleId()" [project]="project()" [canEdit]="editable()" [context]="{ cycleId: cycleId(), project: project() }" />
            }
          </div>
        }
        @if (error()) { <div class="board-error">{{ error() }}</div> }
      </div>
      <app-brief-comments class="tv-margin" [cycleId]="cycleId()" [project]="project()" [editable]="editable()" [comments]="comments()"
                          [missing]="missing()" [(draft)]="draft" [(lit)]="lit" (changed)="loadComments(cycleId())" (briefSaved)="set($event)" />
    </div>
    @if (selection(); as s) {
      <button type="button" class="tv-selbtn" [style.left.px]="s.x" [style.top.px]="s.y" (mousedown)="$event.preventDefault()" (click)="commentOnSelection()">
        💬 Comment</button>
    }`,
})
export class CycleBriefComponent {
  private readonly api = inject(BoardApiService);
  private readonly injector = inject(Injector);
  readonly cycleId = input.required<string>();
  readonly project = input('');
  readonly editable = input(true);
  /** The cycle's name, kept for hosts that pass it (the commands moved to the Task tab's header). */
  readonly cycleName = input<string | null>(null);
  /** Each brief loaded or saved - the Task view reads its Test steps and Data from it. */
  readonly briefChange = output<CycleBrief>();
  /** Each time the comments load - the Task view counts open threads and Claude's questions. */
  readonly commentsChange = output<readonly BriefComment[]>();

  readonly template = '<one line: what the task delivers>\n\n## Task\n- <ticket id / link>, branch <name>\n\n## Description\n<what the ticket asks for, as written>\n\n'
    + '## Scope\n- \n\n## Out of scope\n- \n\n## Test steps\n1. \n\n## Data\n- \n\n## Decisions\n';
  readonly brief = signal<CycleBrief | null>(null);
  readonly comments = signal<readonly BriefComment[]>([]);
  readonly editing = signal(false);
  readonly error = signal<string | null>(null);
  /** A new comment's quote (null: the whole brief; undefined: none being written). */
  readonly draft = signal<string | null | undefined>(undefined);
  /** The thread in focus - from its card in the margin or its passage. */
  readonly lit = signal<number | null>(null);
  readonly hoverId = signal<number | null>(null);
  /** Text selected in the brief, with where its button shows. */
  readonly selection = signal<{ text: string; x: number; y: number } | null>(null);
  /** Threads whose quote is not in the brief as shown. */
  readonly missing = signal<ReadonlySet<number>>(new Set());

  private readonly body = viewChild<ElementRef<HTMLElement>>('body');
  private ranges: QuoteRange[] = [];
  private observer: MutationObserver | null = null;
  private repaint: ReturnType<typeof setTimeout> | null = null;

  readonly parts = computed(() => briefParts(this.brief()?.text ?? ''));
  readonly scope = computed(() => itemsOf(this.parts().sections['scope']));
  readonly outOfScope = computed(() => itemsOf(this.parts().sections['out of scope']));
  readonly decisions = computed(() => decisionsOf(this.parts().sections['decisions']));
  readonly steps = computed(() => itemsOf(this.parts().sections['test steps']));
  readonly data = computed(() => itemsOf(this.parts().sections['data']));
  private readonly quotes = computed(() => {
    const t = briefThreads(this.comments());
    return [...t.open, ...t.resolved].filter((x) => !!x.root.quote)
      .map((x) => ({ id: x.root.id, quote: x.root.quote!, claude: x.root.actor === 'CLAUDE', resolved: !!x.root.resolvedAt }));
  });

  constructor() {
    effect(() => {
      const id = this.cycleId();
      untracked(() => {
        this.draft.set(undefined);
        this.lit.set(null);
        this.load(id);
        this.loadComments(id);
      });
    });
    inject(BoardSocketService).events$.pipe(
      filter((e) => e.type === 'board-changed' && e.cycleId === this.cycleId() && (e.what === 'brief' || e.what === 'brief-comments')),
      takeUntilDestroyed(inject(DestroyRef)),
    ).subscribe((e) => {
      if (e.type !== 'board-changed') return;
      if (e.what === 'brief') this.load(this.cycleId());
      else this.loadComments(this.cycleId());
    });
    // the passages are found again whenever the brief, the comments or the rendered text change
    effect(() => {
      this.quotes();
      this.parts();
      const body = this.body()?.nativeElement;
      untracked(() => {
        this.observer?.disconnect();
        this.observer = null;
        if (!body) {
          this.ranges = [];
          clearHighlights();
          return;
        }
        afterNextRender(() => this.findPassages(), { injector: this.injector });
        if (typeof MutationObserver !== 'undefined') {
          this.observer = new MutationObserver(() => this.scheduleFind());
          this.observer.observe(body, { childList: true, subtree: true, characterData: true });
        }
      });
    });
    effect(() => {
      this.lit();
      this.hoverId();
      untracked(() => this.paint());
    });
    inject(DestroyRef).onDestroy(() => {
      this.observer?.disconnect();
      if (this.repaint) clearTimeout(this.repaint);
      clearHighlights();
    });
  }

  private scheduleFind(): void {
    if (this.repaint) clearTimeout(this.repaint);
    this.repaint = setTimeout(() => this.findPassages(), 120);
  }

  private findPassages(): void {
    const body = this.body()?.nativeElement;
    if (!body) return;
    const quotes = this.quotes();
    this.ranges = quoteRanges(body, quotes);
    const found = new Set(this.ranges.map((r) => r.id));
    const missing = new Set(quotes.filter((q) => !found.has(q.id)).map((q) => q.id));
    const now = this.missing();
    if (missing.size !== now.size || [...missing].some((id) => !now.has(id))) this.missing.set(missing);
    this.paint();
  }

  private paint(): void {
    const focus = this.lit() ?? this.hoverId();
    const by = new Map(this.quotes().map((q) => [q.id, q]));
    const open = this.ranges.filter((r) => !by.get(r.id)?.resolved);
    paintHighlights({
      user: open.filter((r) => !by.get(r.id)?.claude && r.id !== focus).map((r) => r.range),
      claude: open.filter((r) => by.get(r.id)?.claude && r.id !== focus).map((r) => r.range),
      lit: this.ranges.filter((r) => r.id === focus).map((r) => r.range),
    });
  }

  private openRanges(): QuoteRange[] {
    const resolved = new Set(this.quotes().filter((q) => q.resolved).map((q) => q.id));
    return this.ranges.filter((r) => !resolved.has(r.id));
  }

  hover(e: MouseEvent): void {
    const id = rangeAt(this.openRanges(), e.clientX, e.clientY);
    if (id !== this.hoverId()) this.hoverId.set(id);
  }

  clickPassage(e: MouseEvent): void {
    // a passage brings its thread into focus; a click elsewhere in the brief lets it go
    this.lit.set(rangeAt(this.openRanges(), e.clientX, e.clientY));
  }

  /** A passage selected in the brief offers "💬 Comment" just under it. */
  selected(e: MouseEvent): void {
    if (!this.editable()) return;
    const body = this.body()?.nativeElement;
    const sel = typeof window !== 'undefined' ? window.getSelection() : null;
    const text = sel?.toString().replace(/\s+/g, ' ').trim() ?? '';
    if (!body || !sel || !sel.rangeCount || !text || text.length > QUOTE_MAX || !body.contains(sel.getRangeAt(0).commonAncestorContainer)) {
      this.selection.set(null);
      return;
    }
    const rect = sel.getRangeAt(0).getBoundingClientRect();
    // above the passage: the page's own selection menu (save as variable, ask Claude) opens under it
    const x = rect.width || rect.height ? rect.left : e.clientX;
    const y = Math.max(4, (rect.width || rect.height ? rect.top : e.clientY) - 30);
    this.selection.set({ text, x, y });
  }

  /** A click anywhere but the button drops the offer (a new selection makes a new one on mouseup). */
  outside(e: MouseEvent): void {
    if (this.selection() && !(e.target as HTMLElement | null)?.closest?.('.tv-selbtn')) this.selection.set(null);
  }

  commentOnSelection(): void {
    const s = this.selection();
    if (!s) return;
    this.draft.set(s.text);
    this.selection.set(null);
    window.getSelection()?.removeAllRanges();
  }

  private load(id: string): void {
    this.api.brief(id).subscribe({ next: (b) => this.set(b), error: (e) => this.error.set(messageOf(e)) });
  }

  loadComments(id: string): void {
    // an Alfred without brief comments answers 404: the brief shows without them
    this.api.briefComments(id).subscribe({
      next: (c) => { if (id === this.cycleId()) { this.comments.set(c); this.commentsChange.emit(c); } },
      error: () => this.comments.set([]),
    });
  }

  set(b: CycleBrief): void {
    this.brief.set(b);
    this.briefChange.emit(b);
  }

  save(text: string): void {
    this.api.putBrief(this.cycleId(), text).subscribe({
      next: (b) => {
        this.set(b);
        this.editing.set(false);
        this.error.set(null);
      },
      error: (e) => this.error.set(messageOf(e)),
    });
  }

  restore(): void {
    this.api.restoreBrief(this.cycleId()).subscribe({
      next: (b) => this.set(b),
      error: (e) => this.error.set(messageOf(e)),
    });
  }

  when(iso: string): string {
    return new Date(iso).toLocaleString();
  }
}
