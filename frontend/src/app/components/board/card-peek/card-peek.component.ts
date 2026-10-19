import { Component, DestroyRef, ElementRef, computed, effect, inject, input, output, signal, untracked, viewChild } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { filter } from 'rxjs';
import {
  ActivityEntry, BoardQuestion, CardDetail, CardSummary, FLAG_LABELS, Flag, MENTION_ICONS, RESOLUTION_LABELS, RetestCheck, STATUS_LABELS, ageText,
  implementedChip, mentionTypeOf, workedChip,
} from '../../../core/models/board.models';
import { BoardApiService } from '../../../core/services/board-api.service';
import { BoardSocketService } from '../../../core/services/board-socket.service';
import { userLabel } from '../../../core/links/remote-ref';
import { DialogQuestion, dialogQuestions } from '../../../shared/utils/question-blocks';
import { AutoDirDirective } from '../../../shared/directives/auto-dir.directive';
import { MarkdownViewComponent } from '../markdown-view/markdown-view.component';
import { CardAction, proposalText } from '../board-card/board-card.component';
import { confidenceLabel, confidenceOf } from '../../../shared/utils/triage-advice';

/** Where the card is on screen: the peek sits beside it. */
export interface PeekAnchor {
  readonly top: number;
  readonly bottom: number;
  readonly left: number;
  readonly right: number;
}

interface Loaded {
  readonly key: string;
  readonly detail: CardDetail;
  readonly questions: readonly BoardQuestion[];
  readonly history: readonly ActivityEntry[];
}

const WIDTH = 440;
const GAP = 10;
/** What was read for a card, by its id and last change: hovering the same card again costs nothing. */
const cache = new Map<string, Loaded>();

/**
 * A card's peek (the board's hover): the card read whole beside its tile without opening it - its questions with every
 * option and Claude's advice, what it waits on, the Fixed checks, a proposal, a block, the description, the acceptance
 * items, the evidence, Claude's latest comment and the keys. Read-only except for the same buttons the tile has; Open
 * goes to the drawer. Loaded when shown, kept per card until the card changes (the board signal, no polling).
 */
@Component({
  selector: 'app-card-peek',
  standalone: true,
  imports: [MarkdownViewComponent, AutoDirDirective],
  host: { '(mouseenter)': 'entered.emit()', '(mouseleave)': 'left.emit()' },
  template: `
    @let c = card();
    <div #box class="card-peek" role="dialog" [attr.aria-label]="'Card #' + c.number" [style.top.px]="pos().top" [style.left.px]="pos().left"
         [style.max-height.px]="pos().maxHeight" [class.left]="pos().flip">
      <span class="card-peek-arrow" [style.top.px]="pos().arrow"></span>
      <div class="card-peek-in">
        <div class="card-peek-head">
          <span class="board-kind" [class]="'board-kind board-kind-' + c.kind">{{ kindLabel() }}</span>
          <span class="card-peek-num">#{{ c.number }}</span>
          <span class="card-peek-st">{{ statusLabel() }}</span>
          @for (f of c.flags; track f) { <span class="board-flag" [class]="'board-flag board-flag-' + f">{{ flagLabel(f) }}</span> }
          <span class="card-peek-sp"></span>
          <button type="button" class="card-peek-open" title="Open the card (Enter)" (click)="open.emit()">Open ⤢</button>
        </div>
        <div class="card-peek-title" [appAutoDir]="c.title">{{ c.title }}</div>
        @if (c.shortName) { <div class="card-peek-short" [appAutoDir]="c.shortName">“{{ c.shortName }}”</div> }
        <div class="card-peek-meta">
          @if (c.author === 'CLAUDE') { <span class="board-ai">✦ Claude</span> } @else { <span>{{ who(c.author) }}</span> }
          opened {{ ago(c.createdAt) }} ago · changed {{ ago(c.updatedAt) }} ago by {{ who(c.updatedBy) }}
          @if (c.commentCount) { · 💬 {{ c.commentCount }} }
        </div>

        @if (waitLine(); as w) {
          <div class="card-peek-wait" [class]="'card-peek-wait card-peek-wait-' + c.waiting!.who">⏳ <span>{{ w }}</span></div>
        }

        @if (liveStep()) {
          <div class="card-peek-sec"><div class="card-peek-live"><span class="live-spinner"></span>✦ {{ liveStep() }}</div></div>
        }

        @for (q of questions(); track q.key; let qi = $index) {
          <div class="card-peek-sec">
            <div class="card-peek-lbl">Question <span class="card-peek-qh" [appAutoDir]="q.ask.header">{{ q.ask.header }}</span>
              <span class="card-peek-sp"></span><span class="card-peek-dim">asked {{ ago(q.row.askedAt) }} ago</span></div>
            <div class="card-peek-q"><app-markdown-view [text]="q.ask.question" [previews]="false" /></div>
            @if (q.ask.why) {
              <div class="card-peek-why" [appAutoDir]="q.ask.why"><span class="card-peek-why-l">Why it matters</span><bdi>{{ q.ask.why }}</bdi></div>
            }
            @if (q.ask.options.length) {
              <div class="card-peek-opts">
                @for (o of q.ask.options; track o.label; let k = $index) {
                  <div class="card-peek-opt" [class.rec]="o.recommended" [appAutoDir]="o.label + ' ' + (o.description ?? '')">
                    <span class="card-peek-key">{{ k + 1 }}</span>
                    <div class="card-peek-ot">
                      <b>{{ o.label }}</b>
                      @if (o.recommended) {
                        <span class="card-peek-rec">✦ Claude advises@if (o.confidence || confidence()) { · <i class="board-conf" [class]="'board-conf board-conf-' + (o.confidence || confidence())!.toLowerCase()">{{ confText(o.confidence || confidence()!) }}</i> }</span>
                      }
                      @if (o.description) { <div class="card-peek-od"><app-markdown-view [text]="o.description" [previews]="false" /></div> }
                      @if (o.then) { <div class="card-peek-then" [appAutoDir]="o.then">→ {{ o.then }}</div> }
                    </div>
                  </div>
                }
              </div>
            }
            @if (editable() && qi === questions().length - 1) {
              <div class="card-peek-acts"><button type="button" class="card-peek-btn pri" (click)="answer.emit()">Answer… <kbd>A</kbd></button></div>
            }
          </div>
        }
        @if (!questions().length && loaded() && c.openQuestions) {
          <div class="card-peek-sec"><div class="card-peek-lbl">❓ {{ c.openQuestions }} open question{{ c.openQuestions === 1 ? '' : 's' }}</div>
            @if (editable()) { <div class="card-peek-acts"><button type="button" class="card-peek-btn pri" (click)="answer.emit()">Answer… <kbd>A</kbd></button></div> }</div>
        }
        @if (!questions().length && c.advice) {
          <div class="card-peek-sec"><div class="card-peek-lbl">✦ Claude advises</div>
            <div class="card-peek-q" [appAutoDir]="c.advice"><b>{{ c.advice }}</b></div>
            @if (c.adviceDetail?.reason; as why) { <div class="card-peek-why" [appAutoDir]="why">{{ why }}</div> }
            @if (c.adviceDetail?.checked; as ch) { <div class="card-peek-why" [appAutoDir]="ch"><span class="card-peek-why-l">Checked</span><bdi>{{ ch }}</bdi></div> }
          </div>
        }
        @if (c.status === 'INBOX' && c.adviceDetail?.rank) {
          <div class="card-peek-line card-peek-rank">▲ {{ c.adviceDetail?.rank }}{{ c.adviceDetail?.of ? ' of ' + c.adviceDetail?.of : '' }} in the Inbox{{ c.adviceDetail?.note ? ' · ' + c.adviceDetail?.note : '' }}</div>
        }

        @if (checks(); as two) {
          <div class="card-peek-sec"><div class="card-peek-lbl">Ready for Verified?</div>
            @for (k of two; track k.text) {
              <div class="card-peek-vc" [class]="'card-peek-vc card-peek-vc-' + k.tone"><b>{{ k.text }}</b>@if (k.detail) { <span>{{ k.detail }}</span> }</div>
            }
            @if (editable()) {
              <div class="card-peek-acts">
                @if (retest()?.verdict === 'PASSES') { <button type="button" class="card-peek-btn pri" (click)="act({ kind: 'move', status: 'VERIFIED' })">✓ Verified</button> }
                <button type="button" class="card-peek-btn" (click)="act({ kind: 'retest' })">▶ Re-test</button>
              </div>
            }
          </div>
        } @else if (retest()) {
          <div class="card-peek-sec"><div class="card-peek-lbl">Re-test</div><div class="card-peek-line" [appAutoDir]="retest()!.summary">{{ retest()!.summary }}</div></div>
        }
        @if (c.proposal; as p) {
          <div class="card-peek-sec card-peek-prop"><div class="card-peek-lbl">✦ Claude proposes</div><div class="card-peek-q">{{ proposal(p) }}</div>
            <div class="card-peek-dim">Open the card to accept or dismiss it.</div></div>
        }
        @if (c.blockedBy?.length) {
          <div class="card-peek-sec"><div class="card-peek-lbl">🔒 Blocked by</div>
            @for (b of c.blockedBy; track b.number) { <div class="card-peek-line" [appAutoDir]="b.title">#{{ b.number }} {{ b.title }} <span class="card-peek-dim">{{ statusOf(b.status) }}</span></div> }</div>
        }
        @if (c.status === 'INBOX' && c.similarClosed; as s) {
          <div class="card-peek-sec"><div class="card-peek-lbl">⚠ Looks like a closed card</div>
            <div class="card-peek-line" [appAutoDir]="s.title">#{{ s.number }} {{ s.title }} - closed as {{ resLabel(s.resolution) }}{{ s.reason ? ': ' + s.reason : '' }}</div></div>
        }
        @if (toAzure()) {
          <div class="card-peek-sec"><div class="card-peek-lbl">⇪ To Azure</div><div class="card-peek-line">{{ toAzure() }} change{{ toAzure() === 1 ? '' : 's' }} wait for your approval - open the card.</div></div>
        }
        @if (c.resolution; as r) {
          <div class="card-peek-sec"><div class="card-peek-lbl">Closed as {{ resLabel(r) }}</div>
            @if (c.reason) { <div class="card-peek-why" [appAutoDir]="c.reason">“{{ c.reason }}”</div> }</div>
        }

        @if (detail()?.description; as d) {
          <div class="card-peek-sec"><div class="card-peek-lbl">Description</div><div class="card-peek-md"><app-markdown-view [text]="d" [previews]="false" [cycleId]="c.cycleId" /></div></div>
        }
        @if (detail()?.specItems?.length) {
          <div class="card-peek-sec"><div class="card-peek-lbl">Acceptance</div>
            @for (s of detail()!.specItems!; track s.itemKey) {
              <div class="card-peek-line" [appAutoDir]="s.text">◇ {{ s.text ?? 'item removed from the spec' }} <span class="card-peek-dim">{{ s.fileName }}</span></div>
            }
          </div>
        }
        @if (evidence().length) {
          <div class="card-peek-sec"><div class="card-peek-lbl">Evidence <span class="card-peek-dim">{{ evidence().length }}</span></div>
            <div class="card-peek-ev">
              @for (m of evidence(); track m.type + m.ref) { <span class="board-mention" [class]="'board-mention board-mention-' + m.kind" [title]="m.label">{{ m.icon }} {{ m.label }}</span> }
            </div>
          </div>
        }
        @if (latest(); as e) {
          <div class="card-peek-sec"><div class="card-peek-lbl">Latest comment<span class="card-peek-sp"></span><span class="card-peek-dim">{{ e.actor === 'CLAUDE' ? '✦ Claude' : who(e.actor) }} · {{ ago(e.at) }} ago</span></div>
            <div class="card-peek-md"><app-markdown-view [text]="e.text" [previews]="false" [cycleId]="c.cycleId" /></div></div>
        }
        @if (!loaded()) { <div class="card-peek-sec card-peek-dim">Loading…</div> }
        @if (error()) { <div class="card-peek-sec card-peek-dim">{{ error() }}</div> }

        <div class="card-peek-facts">
          <div><span>Board</span><b [title]="boardName()">{{ boardName() || '-' }}</b></div>
          <div><span>Teams</span><b>{{ (c.teams ?? []).join(', ') || 'none' }}</b></div>
          <div><span>Scope</span><b>{{ scopeText() }}</b></div>
        </div>
        <div class="card-peek-keys">
          <kbd>Enter</kbd> open
          @if (editable() && c.openQuestions) { <kbd>A</kbd> answer }
          @if (editable() && c.status === 'INBOX') { <kbd>F</kbd> fine <kbd>N</kbd> not in flow <kbd>T</kbd> to do }
          <kbd>Esc</kbd> close
        </div>
      </div>
    </div>`,
})
export class CardPeekComponent {
  private readonly api = inject(BoardApiService);
  private readonly box = viewChild<ElementRef<HTMLElement>>('box');

  readonly card = input.required<CardSummary>();
  readonly anchor = input.required<PeekAnchor>();
  readonly editable = input(true);
  readonly boardName = input('');
  readonly retest = input<RetestCheck | null>(null);
  /** /alfred-live's current step on the card, when it works on it. */
  readonly liveStep = input<string | null>(null);
  /** Changes for Azure waiting on the user, from this card. */
  readonly toAzure = input(0);
  readonly now = input(Date.now());
  readonly open = output<void>();
  readonly answer = output<void>();
  readonly action = output<CardAction>();
  readonly entered = output<void>();
  readonly left = output<void>();

  readonly loaded = signal(false);
  readonly error = signal<string | null>(null);
  private readonly data = signal<Loaded | null>(null);
  readonly detail = computed(() => this.data()?.detail ?? null);
  /** Claude's open questions with what it wrote for each - the dialog's own reading of them. */
  readonly questions = computed<DialogQuestion[]>(() => {
    const d = this.data();
    return d ? dialogQuestions(d.questions, d.history).filter((q) => !q.parent) : [];
  });
  /** Claude's (or the user's) last comment that is not a question, an answer or a withdrawal - what happened last. */
  readonly latest = computed(() => {
    const h = this.data()?.history ?? [];
    for (let i = h.length - 1; i >= 0; i--) {
      const e = h[i];
      if (e.kind !== 'COMMENT' || !e.text) continue;
      if (/^\*\*(Question|Answers?|Withdrawn)\*\*/.test(e.text) || /```(questions|answers)/.test(e.text)) continue;
      return e;
    }
    return null;
  });
  readonly evidence = computed(() => (this.detail()?.links ?? this.card().mentionChips ?? []).map((m) => {
    const kind = mentionTypeOf(m);
    return { ...m, kind, icon: MENTION_ICONS[kind] ?? '•' };
  }));
  readonly checks = computed(() => {
    const r = this.retest();
    return r && this.card().status === 'FIXED' ? [implementedChip(r), workedChip(r)] : null;
  });
  readonly confidence = computed(() => confidenceOf(this.card()));
  readonly kindLabel = computed(() => this.card().kind.charAt(0) + this.card().kind.slice(1).toLowerCase());
  readonly statusLabel = computed(() => STATUS_LABELS[this.card().status]);
  readonly scopeText = computed(() => ({ IN_SCOPE: 'In scope', OUT_OF_SCOPE: 'Out of scope' } as Record<string, string>)[this.card().scope] ?? 'Not decided');
  readonly waitLine = computed(() => {
    const c = this.card();
    const w = c.waiting;
    if (!w || w.who === 'NONE') return null;
    const user = userLabel(c.id);
    const who = w.who === 'USER' ? (user === 'You' ? 'you' : user) : w.who === 'CLAUDE' ? 'Claude' : 'a re-test';
    const n = c.openQuestions ?? 0;
    return `Waiting on ${who} for ${this.ago(w.since)}${n ? ` · ${n} open question${n === 1 ? '' : 's'}` : ''}`;
  });

  /** Beside the card: on its right when there is room, else on its left; never off the screen. */
  readonly pos = computed(() => {
    const a = this.anchor();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const flip = a.right + GAP + WIDTH > vw - 8 && a.left - GAP - WIDTH >= 8;
    const left = flip ? a.left - GAP - WIDTH : Math.min(a.right + GAP, vw - WIDTH - 8);
    const maxHeight = vh - 24;
    const h = Math.min(this.height(), maxHeight);
    const top = Math.max(12, Math.min(a.top - 6, vh - 12 - h));
    const arrow = Math.max(14, Math.min(a.top + 18 - top, h - 20));
    return { top, left, maxHeight, flip, arrow };
  });
  private readonly height = signal(480);

  constructor() {
    effect(() => {
      const c = this.card();
      untracked(() => this.load(c));
    });
    inject(BoardSocketService).events$.pipe(
      filter((e) => e.type === 'board-changed' && e.cardId === this.card().id),
      takeUntilDestroyed(inject(DestroyRef)),
    ).subscribe(() => {
      cache.delete(this.card().id);
      this.load(this.card());
    });
    // the panel's real height decides how high it can sit (its content loads after it opens)
    const ro = new ResizeObserver(() => {
      const box = this.box()?.nativeElement;
      const inner = box?.querySelector('.card-peek-in') as HTMLElement | null;
      if (inner) this.height.set(inner.scrollHeight + 2);
    });
    effect(() => {
      const box = this.box()?.nativeElement;
      const inner = box?.querySelector('.card-peek-in');
      ro.disconnect();
      if (inner) { ro.observe(inner); for (const c of Array.from(inner.children)) ro.observe(c); }
      void this.data();
    });
    inject(DestroyRef).onDestroy(() => ro.disconnect());
  }

  private load(c: CardSummary): void {
    const key = c.id + '|' + c.updatedAt + '|' + c.commentCount + '|' + (c.openQuestions ?? 0);
    const hit = cache.get(c.id);
    if (hit && hit.key === key) {
      this.data.set(hit);
      this.loaded.set(true);
      return;
    }
    if (!hit || hit.key !== key) this.loaded.set(!!hit && hit.detail.id === c.id);
    if (hit) this.data.set(hit);
    let detail: CardDetail | null = null;
    let questions: readonly BoardQuestion[] | null = null;
    let history: readonly ActivityEntry[] | null = null;
    const done = () => {
      if (!detail || !questions || !history || this.card().id !== c.id) return;
      const v: Loaded = { key, detail, questions, history };
      cache.set(c.id, v);
      this.data.set(v);
      this.loaded.set(true);
    };
    this.error.set(null);
    this.api.card(c.id).subscribe({ next: (d) => { detail = d; done(); }, error: () => this.failed() });
    this.api.questions(c.id).subscribe({ next: (q) => { questions = q; done(); }, error: () => { questions = []; done(); } });
    this.api.activity(c.id).subscribe({ next: (p) => { history = p.entries; done(); }, error: () => { history = []; done(); } });
  }

  private failed(): void {
    this.loaded.set(true);
    this.error.set('Could not read the card - open it for the details.');
  }

  act(a: CardAction): void {
    this.action.emit(a);
  }

  ago(iso: string): string {
    return ageText(iso, this.now());
  }

  who(actor: string): string {
    return actor === 'CLAUDE' ? 'Claude' : userLabel(this.card().id) === 'You' ? 'you' : userLabel(this.card().id);
  }

  flagLabel(f: Flag): string {
    return FLAG_LABELS[f];
  }

  statusOf(s: CardSummary['status']): string {
    return STATUS_LABELS[s];
  }

  resLabel(r: keyof typeof RESOLUTION_LABELS): string {
    return RESOLUTION_LABELS[r];
  }

  proposal(p: NonNullable<CardSummary['proposal']>): string {
    return proposalText(p);
  }

  confText(c: string): string {
    return confidenceLabel(c);
  }
}
