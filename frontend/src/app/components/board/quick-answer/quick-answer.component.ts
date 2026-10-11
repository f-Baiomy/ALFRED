import { Component, computed, effect, inject, input, output, signal, untracked } from '@angular/core';
import { ActivityEntry, CardDetail } from '../../../core/models/board.models';
import { BoardApiService } from '../../../core/services/board-api.service';
import { messageOf } from '../../../core/state/board-state.service';
import { historyThreads } from '../../../shared/utils/board-threads';
import { MarkdownViewComponent } from '../markdown-view/markdown-view.component';
import { MentionEditorComponent } from '../mention-editor/mention-editor.component';

/**
 * Answer Claude's questions from the board (specs/015 FR-5), without opening the card: its open questions one at a
 * time, an answer box, "Clear Needs decision" (it takes effect with the last answer), and Next question.
 */
@Component({
  selector: 'app-quick-answer',
  standalone: true,
  imports: [MarkdownViewComponent, MentionEditorComponent],
  template: `
    <div class="dialog-backdrop" (click)="closed.emit()">
      <div class="dialog-card board-quick-answer" role="dialog" aria-label="Answer Claude's question" (click)="$event.stopPropagation()">
        @if (card(); as c) {
          <div class="board-quick-head"><b>#{{ c.number }} {{ c.title }}</b>
            <button type="button" class="board-drawer-x" title="Close (Esc)" (click)="closed.emit()">✕</button></div>
          @if (current(); as q) {
            <div class="board-dim">✦ Claude's question {{ index() + 1 }} of {{ open().length }}</div>
            <div class="board-quick-q"><app-markdown-view [text]="questionText(q)" /></div>
            <app-mention-editor [project]="c.project" [cycleId]="c.cycleId" [rows]="3" submitLabel="Answer" placeholder="Your answer… type @ to mention"
                                [card]="{ id: c.id, project: c.project, number: c.number, cycleId: c.cycleId }" (submitted)="send(q, $event)" />
            <div class="board-quick-foot">
              <label class="board-ev-clear"><input type="checkbox" [checked]="clear()" (change)="clear.set($any($event.target).checked)" />
                Clear "Needs decision"{{ open().length > 1 ? ' (with the last answer)' : '' }}</label>
              @if (open().length > 1) { <button type="button" class="action-btn" (click)="skip()">Next question ›</button> }
            </div>
          } @else {
            <div class="board-quick-done">✓ No open question on this card.</div>
          }
          @if (error()) { <div class="board-error">{{ error() }}</div> }
        } @else {
          <div class="board-dim">Loading…</div>
        }
      </div>
    </div>`,
})
export class QuickAnswerComponent {
  private readonly api = inject(BoardApiService);
  readonly cardId = input.required<string>();
  readonly closed = output<void>();

  readonly card = signal<CardDetail | null>(null);
  readonly history = signal<readonly ActivityEntry[]>([]);
  readonly index = signal(0);
  readonly clear = signal(true);
  readonly error = signal<string | null>(null);
  readonly open = computed(() => historyThreads(this.history()).filter((t) => t.question && !t.answered).map((t) => t.entry));
  readonly current = computed(() => this.open()[Math.min(this.index(), Math.max(0, this.open().length - 1))] ?? null);

  constructor() {
    effect(() => {
      const id = this.cardId();
      untracked(() => this.load(id));
    });
  }

  private load(id: string): void {
    this.api.card(id).subscribe({ next: (c) => this.card.set(c), error: (e) => this.error.set(messageOf(e)) });
    this.api.activity(id).subscribe({ next: (p) => this.history.set(p.entries), error: (e) => this.error.set(messageOf(e)) });
  }

  questionText(q: ActivityEntry): string {
    return (q.text ?? '').replace(/^\*\*Question\*\*\s*/, '');
  }

  skip(): void {
    this.index.update((i) => (i + 1) % Math.max(1, this.open().length));
  }

  send(q: ActivityEntry, text: string): void {
    const c = this.card();
    if (!c) return;
    const last = this.open().length === 1;
    this.api.comment(c.id, text, q.id, this.clear() && last).subscribe({
      next: () => {
        this.error.set(null);
        if (last) {
          this.closed.emit();
          return;
        }
        this.index.set(0);
        this.load(c.id);
      },
      error: (e) => this.error.set(messageOf(e)),
    });
  }
}
