import { Component, DestroyRef, HostListener, computed, effect, inject, input, output, signal, untracked } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { filter } from 'rxjs';
import { ActivityEntry, BoardQuestion, CardSummary, LiveRunnerInfo, RESOLUTION_BUTTONS, ageText } from '../../../core/models/board.models';
import { BoardApiService } from '../../../core/services/board-api.service';
import { BoardSocketService } from '../../../core/services/board-socket.service';
import { messageOf } from '../../../core/state/board-state.service';
import { DialogQuestion, dialogQuestions, withoutBlocks } from '../../../shared/utils/question-blocks';
import { MarkdownViewComponent } from '../markdown-view/markdown-view.component';
import { RefTextComponent } from '../mention-chip/ref-text.component';
import { CardAction, proposalText } from '../board-card/board-card.component';

/** Where the pill sits on screen: the bar opens under it (above when there is no room). */
export interface WaitingAnchor {
  readonly top: number;
  readonly bottom: number;
  readonly left: number;
}

/** One line of the thread under the bar's question: who, when, what (blocks taken out). */
interface ThreadLine {
  readonly id: number;
  readonly who: 'You' | 'Claude';
  readonly age: string;
  readonly text: string;
}

const WIDTH = 440;

/**
 * The waiting pill opened (docs/board.md "The waiting bar"): what the card waits on the user for, with the decision in
 * one click - Claude's open question with its options (the recommended one marked), a proposal to accept or dismiss, or
 * the Inbox sort - and a Discuss box under the thread. "Decide with this" answers in the user's words (Something else,
 * or a comment handed to Claude); "Ask first" asks back and keeps the question open until Claude replies here. Nothing is
 * polled: the board signal reloads it.
 */
@Component({
  selector: 'app-waiting-bar',
  standalone: true,
  imports: [MarkdownViewComponent, RefTextComponent],
  template: `
    <div class="wbar-layer" (click)="closed.emit()">
      <div class="wbar" role="dialog" aria-label="What this card waits on" [style.top.px]="pos().top" [style.left.px]="pos().left"
           [style.width.px]="width" (click)="$event.stopPropagation()">
        <div class="wbar-head">
          <b>#{{ card().number }} · {{ headline() }}</b>
          <button type="button" class="board-drawer-x" title="Close (Esc)" (click)="closed.emit()">✕</button>
        </div>

        @if (question(); as q) {
          <div class="wbar-q"><app-markdown-view [text]="q.ask.question" /></div>
          @if (q.ask.checked) { <div class="wbar-dim"><b>Checked:</b>{{ ' ' }}<app-ref-text [text]="q.ask.checked" [project]="card().project" [cycleId]="card().cycleId" [showPreview]="false" /></div> }
          @if (q.ask.multiSelect) {
            <div class="wbar-dim">Several answers allowed - pick them in the full dialog.</div>
          } @else {
            @for (o of options(q); track o.label) {
              <button type="button" class="wbar-opt" [class.rec]="o.recommended" [disabled]="!editable() || busy()" (click)="choose(q, o.label)">
                <span class="wbar-ol">{{ o.label }}
                  @if (o.recommended) { <span class="wbar-rec">recommended{{ o.confidence ? ' · ' + o.confidence : '' }}</span> }</span>
                @if (o.then || o.description) {
                  <span class="wbar-then"><app-ref-text [text]="o.then || o.description || ''" [project]="card().project" [cycleId]="card().cycleId" [showPreview]="false" /></span>
                }
              </button>
            }
          }
          @if (openCount() > 1 || q.ask.multiSelect) {
            <button type="button" class="board-link" (click)="allQuestions.emit()">All {{ openCount() }} question{{ openCount() === 1 ? '' : 's' }} in full (A)</button>
          }
        } @else if (card().proposal) {
          <div class="wbar-q">✦ Claude proposes {{ proposalLabel() }}</div>
          @if (card().proposal?.reason) { <div class="wbar-dim"><app-ref-text [text]="card().proposal?.reason ?? ''" [project]="card().project" [cycleId]="card().cycleId" [showPreview]="false" /></div> }
          <div class="wbar-acts">
            <button type="button" class="action-btn primary" [disabled]="!editable() || busy()" (click)="decideProposal(true)">Accept</button>
            <button type="button" class="action-btn" [disabled]="!editable() || busy()" (click)="decideProposal(false)">Dismiss</button>
          </div>
        } @else if (card().status === 'INBOX') {
          <div class="wbar-q">Sort it: is it an issue for this task?</div>
          <div class="wbar-acts">
            <button type="button" class="action-btn" [disabled]="!editable()" (click)="act({ kind: 'close', resolution: 'FINE' })">{{ buttons.FINE }}</button>
            <button type="button" class="action-btn" [disabled]="!editable()" (click)="act({ kind: 'close', resolution: 'NOT_IN_FLOW' })">{{ buttons.NOT_IN_FLOW }}</button>
            <button type="button" class="action-btn" [disabled]="!editable()" (click)="act({ kind: 'move', status: 'TO_DO' })">→ To do</button>
          </div>
        } @else if (claudeNext()) {
          <div class="wbar-q"><b>Claude's next step:</b>{{ ' ' }}<app-markdown-view [text]="claudeNext()!" /></div>
        }

        <div class="wbar-disc">
          <div class="wbar-dt">Discuss</div>
          @for (l of thread(); track l.id) {
            <div class="wbar-line" [class.me]="l.who === 'You'"><b>{{ l.who }}</b>{{ ' ' }}<span class="wbar-dim">{{ l.age }}</span>{{ ' ' }}
              <app-ref-text [text]="l.text" [project]="card().project" [cycleId]="card().cycleId" [showPreview]="false" /></div>
          } @empty {
            <div class="wbar-dim">Nothing said yet.</div>
          }
          <textarea rows="2" [value]="text()" (input)="text.set($any($event.target).value)" (keydown)="$event.stopPropagation()"
                    [disabled]="!editable()" placeholder="Tell Claude what to do, or ask why" aria-label="Your words to Claude"></textarea>
          <div class="wbar-acts">
            <button type="button" class="action-btn primary" [disabled]="!editable() || busy() || !text().trim()" (click)="decide()"
                    [title]="question() ? 'Answers the question in your words - Claude acts on it' : 'Hands the card to Claude with your words'">Decide with this</button>
            @if (question()) {
              <button type="button" class="action-btn" [disabled]="!editable() || busy() || !text().trim()" (click)="askFirst()"
                      title="Ask back - the question stays open and Claude replies here">Ask first</button>
            }
          </div>
          <div class="wbar-dim">{{ runnerText() }}</div>
        </div>

        @if (note()) { <div class="wbar-sent">{{ note() }}</div> }
        @if (error()) { <div class="board-error">{{ error() }}</div> }
        <div class="wbar-foot"><button type="button" class="board-link" (click)="openCard.emit()">Open card</button></div>
      </div>
    </div>`,
})
export class WaitingBarComponent {
  private readonly api = inject(BoardApiService);
  readonly card = input.required<CardSummary>();
  readonly anchor = input.required<WaitingAnchor>();
  readonly editable = input(true);
  readonly closed = output<void>();
  readonly action = output<CardAction>();
  readonly openCard = output<void>();
  readonly allQuestions = output<void>();

  readonly width = WIDTH;
  readonly buttons = RESOLUTION_BUTTONS;
  readonly rows = signal<readonly BoardQuestion[]>([]);
  readonly history = signal<readonly ActivityEntry[]>([]);
  readonly runner = signal<LiveRunnerInfo | null | undefined>(undefined);
  readonly text = signal('');
  readonly busy = signal(false);
  readonly note = signal<string | null>(null);
  readonly error = signal<string | null>(null);

  /** The open questions now (a follow-up only once its option opened it), oldest first. */
  readonly open = computed(() => dialogQuestions(this.rows(), this.history()).filter((q) => q.row.state !== 'PENDING'));
  readonly question = computed<DialogQuestion | null>(() => this.open()[0] ?? null);
  readonly openCount = computed(() => this.open().length);

  readonly headline = computed(() => {
    const c = this.card();
    if (c.waiting?.who === 'CLAUDE') return this.question() ? 'Claude owes you an answer' : 'Claude is on it';
    if (this.question()) return this.openCount() > 1 ? `Claude asks ${this.openCount()} questions` : 'Claude asks you';
    if (c.proposal) return 'Claude proposes';
    if (c.status === 'INBOX') return 'Sort this card';
    return 'Waiting on your reply';
  });

  readonly proposalLabel = computed(() => (this.card().proposal ? proposalText(this.card().proposal!) : ''));

  /** Claude's latest Next, when the card waits on the user with no question or proposal to answer. */
  readonly claudeNext = computed(() => {
    const last = [...this.history()].reverse().find((e) => e.kind === 'COMMENT' && e.actor === 'CLAUDE' && e.text);
    if (!last?.text) return null;
    const m = /\*\*Next\*\*\s*([\s\S]*?)(?:\n\n\*\*Impact\*\*|$)/.exec(last.text);
    return (m ? m[1] : withoutBlocks(last.text)).trim() || null;
  });

  /** The question's thread (or the card's last comments): the last four lines, oldest first. */
  readonly thread = computed<ThreadLine[]>(() => {
    const q = this.question();
    const now = Date.now();
    const comments = this.history().filter((e) => e.kind === 'COMMENT' && e.text);
    const lines = q ? comments.filter((e) => e.id === q.entryId || e.replyTo === q.entryId) : comments;
    return lines.slice(-4).map((e) => ({
      id: e.id, who: e.actor === 'USER' ? 'You' : 'Claude', age: ageText(e.at, now),
      text: oneLine(e.id === q?.entryId ? 'asked the question above' : withoutBlocks(e.text), 220),
    }));
  });

  readonly runnerText = computed(() => {
    const r = this.runner();
    if (r === undefined) return '';
    return r ? `Claude answers here now (${r.kind ?? 'live'}${r.host ? ' on ' + r.host : ''}).`
      : 'No Claude session is listening - the next one picks it up from the board.';
  });

  /** Under the pill, kept on screen; above it when the bottom has no room. */
  readonly pos = computed(() => {
    const a = this.anchor();
    const vw = typeof window === 'undefined' ? 1200 : window.innerWidth;
    const vh = typeof window === 'undefined' ? 800 : window.innerHeight;
    const left = Math.max(8, Math.min(a.left, vw - WIDTH - 8));
    // The bar is at most 560px tall (styles): under the pill, moved up as far as it must to stay on screen.
    return { left, top: Math.max(8, Math.min(a.bottom + 6, vh - Math.min(560, vh - 16) - 8)) };
  });

  constructor() {
    effect(() => {
      const c = this.card();
      untracked(() => this.load(c.id, c.project));
    });
    inject(BoardSocketService).events$.pipe(
      filter((e) => e.type === 'board-changed' && e.cardId === this.card().id),
      takeUntilDestroyed(inject(DestroyRef)),
    ).subscribe(() => this.load(this.card().id, null));
  }

  private load(id: string, project: string | null): void {
    this.api.questions(id).subscribe({ next: (r) => this.rows.set(r), error: (e) => this.error.set(messageOf(e)) });
    this.api.activity(id).subscribe({ next: (p) => this.history.set(p.entries), error: (e) => this.error.set(messageOf(e)) });
    if (project !== null) this.api.liveRunner(project).subscribe({ next: (r) => this.runner.set(r), error: () => this.runner.set(null) });
  }

  /** The recommended option first, then the rest as Claude wrote them. */
  options(q: DialogQuestion) {
    return [...q.ask.options].sort((a, b) => Number(!!b.recommended) - Number(!!a.recommended));
  }

  choose(q: DialogQuestion, label: string): void {
    this.send(q, { chose: [label] }, `✓ Answered "${label}" - Claude acts on it.`);
  }

  decide(): void {
    const words = this.text().trim();
    if (!words) return;
    const q = this.question();
    if (q) {
      this.send(q, { chose: [], other: words }, '✓ Sent as your answer - Claude acts on it.');
      return;
    }
    this.comment(words, undefined, { waitingOn: 'CLAUDE' }, '✓ Sent - the card is Claude\'s turn now.');
  }

  askFirst(): void {
    const words = this.text().trim();
    const q = this.question();
    if (!words || !q) return;
    this.comment(words, q.entryId, { keepOpen: true }, '✓ Asked - the question stays open; Claude replies here.');
  }

  decideProposal(accept: boolean): void {
    const c = this.card();
    this.busy.set(true);
    (accept ? this.api.acceptProposal(c.id) : this.api.dismissProposal(c.id)).subscribe({
      next: () => { this.busy.set(false); this.closed.emit(); },
      error: (e) => { this.busy.set(false); this.error.set(messageOf(e)); },
    });
  }

  act(a: CardAction): void {
    this.action.emit(a);
    this.closed.emit();
  }

  private send(q: DialogQuestion, answer: { chose: string[]; other?: string }, done: string): void {
    this.busy.set(true);
    this.api.answers(this.card().id, [{ entry: q.entryId, answers: { [q.row.header]: answer } }], true).subscribe({
      next: () => this.sent(done),
      error: (e) => { this.busy.set(false); this.error.set(messageOf(e)); },
    });
  }

  private comment(text: string, replyTo: number | undefined, opts: { keepOpen?: boolean; waitingOn?: 'CLAUDE' }, done: string): void {
    this.busy.set(true);
    this.api.comment(this.card().id, text, replyTo, false, opts).subscribe({
      next: () => this.sent(done),
      error: (e) => { this.busy.set(false); this.error.set(messageOf(e)); },
    });
  }

  private sent(done: string): void {
    this.busy.set(false);
    this.error.set(null);
    this.text.set('');
    this.note.set(done);
    this.load(this.card().id, null);
  }

  @HostListener('document:keydown.escape')
  onEscape(): void {
    this.closed.emit();
  }
}

function oneLine(s: string, max: number): string {
  const flat = s.replace(/```[\s\S]*?```/g, '').replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}
