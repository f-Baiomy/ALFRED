import { NgTemplateOutlet } from '@angular/common';
import { userLabel } from '../../../core/links/remote-ref';
import { Component, ElementRef, computed, effect, inject, input, model, output, signal } from '@angular/core';
import { BriefComment, CycleBrief } from '../../../core/models/board.models';
import { BoardApiService } from '../../../core/services/board-api.service';
import { messageOf } from '../../../core/state/board-state.service';
import { briefThreads } from '../../../shared/utils/task-view';
import { MarkdownViewComponent } from '../markdown-view/markdown-view.component';
import { MentionEditorComponent } from '../mention-editor/mention-editor.component';

/**
 * The Brief's margin of comments (specs/024, docs/board.md "Brief comments"): a thread per commented passage or about
 * the whole brief, replies, Claude's questions and suggested rewordings (Apply / Dismiss - the brief changes only on
 * Apply, through its own save), Resolve / Reopen; resolved threads fold away. The passages are highlighted by the brief
 * itself; {@code lit} links a passage and its thread both ways.
 */
@Component({
  selector: 'app-brief-comments',
  standalone: true,
  imports: [MarkdownViewComponent, MentionEditorComponent, NgTemplateOutlet],
  template: `
    <div class="tv-mh">
      <span class="tv-mh-t">Comments</span><span>{{ threads().open.length }} open · {{ threads().resolved.length }} resolved</span>
      @if (editable() && draft() === undefined) {
        <button type="button" class="tv-btn tv-sm" (click)="draft.set(null)">+ On the whole brief</button>
      }
    </div>
    @if (draft() !== undefined) {
      <div class="tv-cmt tv-draft">
        <div class="tv-q" [class.tv-q-all]="!draft()">{{ draft() ? '"' + draft() + '"' : 'On the whole brief' }}</div>
        <app-mention-editor [value]="''" [project]="project()" [cycleId]="cycleId()" submitLabel="Comment" [cancellable]="true" [rows]="3"
                            [draftKey]="'brief-comment:' + cycleId()" placeholder="Your comment… type @ to mention"
                            (submitted)="add($event)" (cancelled)="draft.set(undefined)" />
      </div>
    }
    @for (t of threads().open; track t.root.id) {
      <ng-container *ngTemplateOutlet="thread; context: { $implicit: t }" />
    }
    @if (threads().resolved.length) {
      <details class="tv-resolved">
        <summary>{{ threads().resolved.length }} resolved</summary>
        @for (t of threads().resolved; track t.root.id) {
          <ng-container *ngTemplateOutlet="thread; context: { $implicit: t }" />
        }
      </details>
    }
    @if (!threads().open.length && !threads().resolved.length && draft() === undefined) {
      <div class="board-dim tv-none">No comments. {{ editable() ? 'Select a passage of the brief to comment on it.' : '' }}</div>
    }
    @if (error()) { <div class="board-error">{{ error() }}</div> }

    <ng-template #thread let-t>
      @let root = $any(t).root;
      <div class="tv-cmt" [attr.data-thread]="root.id" [class.cl]="root.actor === 'CLAUDE'" [class.resolved]="!!root.resolvedAt"
           [class.lit]="lit() === root.id" (mouseenter)="lit.set(root.id)" (mouseleave)="lit.set(null)">
        <div class="tv-q" [class.tv-q-all]="!root.quote">
          {{ root.quote ? '"' + root.quote + '"' : 'On the whole brief' }}
          @if (root.quote && missing().has(root.id)) { <span class="tv-changed" title="The brief no longer has these words as written">passage changed</span> }
        </div>
        @for (c of [root].concat($any(t).replies); track c.id) {
          <div [class.tv-rep]="c !== root">
            <div class="tv-cw">
              <span class="tv-av" [class.cl]="c.actor === 'CLAUDE'">{{ c.actor === 'CLAUDE' ? '✦' : 'Y' }}</span>
              <b [class.cln]="c.actor === 'CLAUDE'">{{ c.actor === 'CLAUDE' ? 'Claude' : user() }}</b>
              <span class="board-dim">{{ when(c.createdAt) }}</span>
              @if (c.asks) { <span class="tv-asks">❓ asks you</span> }
            </div>
            <app-markdown-view [text]="c.text" />
            @if (c.suggestTo && !root.resolvedAt) {
              <div class="tv-proposal">✦ Suggests: <del>{{ c.suggestFrom }}</del> → <ins>{{ c.suggestTo }}</ins>
                @if (editable()) {
                  <div class="tv-acts">
                    <button type="button" class="tv-btn tv-accept" (click)="act(c.id, 'apply')">Apply to the brief</button>
                    <button type="button" class="tv-btn" (click)="act(c.id, 'dismiss')">Dismiss</button>
                  </div>
                }
              </div>
            }
          </div>
        }
        @if (replying() === root.id) {
          <app-mention-editor [value]="''" [project]="project()" [cycleId]="cycleId()" submitLabel="Reply" [cancellable]="true" [rows]="2"
                              [draftKey]="'brief-reply:' + cycleId() + ':' + root.id" placeholder="Reply…"
                              (submitted)="reply(root.id, $event)" (cancelled)="replying.set(null)" />
        }
        @if (editable()) {
          <div class="tv-foot">
            @if (root.resolvedAt) {
              <span class="board-dim">resolved {{ when(root.resolvedAt) }}</span>
              <button type="button" class="board-link" (click)="act(root.id, 'reopen')">Reopen</button>
            } @else {
              @if (replying() !== root.id) {
                <button type="button" class="board-link" (click)="replying.set(root.id)">{{ $any(t).asksYou ? 'Answer' : 'Reply' }}</button>
              }
              <button type="button" class="board-link tv-res" (click)="act(root.id, 'resolve')">✓ Resolve</button>
            }
          </div>
        }
      </div>
    </ng-template>`,
})
export class BriefCommentsComponent {
  private readonly api = inject(BoardApiService);
  private readonly host = inject(ElementRef<HTMLElement>);

  readonly cycleId = input.required<string>();
  /** "You" here; the owning Alfred's name on another Alfred's brief (specs/035). */
  user(): string {
    return userLabel(this.cycleId());
  }
  readonly project = input('');
  readonly editable = input(true);
  readonly comments = input<readonly BriefComment[]>([]);
  /** Threads whose passage the brief no longer has as written. */
  readonly missing = input<ReadonlySet<number>>(new Set());
  /** A new comment being written: its quote, null for the whole brief, undefined for none. */
  readonly draft = model<string | null | undefined>(undefined);
  /** The thread in focus, linked with its passage. */
  readonly lit = model<number | null>(null);
  /** Something was written: the host reloads the comments. */
  readonly changed = output<void>();
  /** A suggestion was applied: the brief as saved. */
  readonly briefSaved = output<CycleBrief>();

  readonly replying = signal<number | null>(null);
  readonly error = signal<string | null>(null);
  readonly threads = computed(() => briefThreads(this.comments()));

  constructor() {
    // a passage clicked in the brief brings its thread into view
    effect(() => {
      const id = this.lit();
      if (id == null) return;
      const el = (this.host.nativeElement as HTMLElement).querySelector(`[data-thread="${id}"]`);
      (el as HTMLElement | null)?.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' });
    });
  }

  add(text: string): void {
    const quote = this.draft();
    if (!text.trim()) return;
    this.api.addBriefComment(this.cycleId(), { quote: quote ?? null, text }).subscribe({
      next: () => { this.draft.set(undefined); this.error.set(null); this.changed.emit(); },
      error: (e) => this.error.set(messageOf(e)),
    });
  }

  reply(root: number, text: string): void {
    if (!text.trim()) return;
    this.api.addBriefComment(this.cycleId(), { text, replyTo: root }).subscribe({
      next: () => { this.replying.set(null); this.error.set(null); this.changed.emit(); },
      error: (e) => this.error.set(messageOf(e)),
    });
  }

  act(id: number, action: 'resolve' | 'reopen' | 'apply' | 'dismiss'): void {
    this.api.briefCommentAction(this.cycleId(), id, action).subscribe({
      next: (out) => {
        this.error.set(null);
        if (out.brief) this.briefSaved.emit(out.brief);
        this.changed.emit();
      },
      error: (e) => this.error.set(messageOf(e)),
    });
  }

  when(iso: string): string {
    return new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  }
}

