import { Component, DestroyRef, HostListener, computed, effect, inject, input, output, signal, untracked } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { filter } from 'rxjs';
import { ActivityEntry, BoardQuestion, CardDetail, EntryAnswers, QuestionAnswer } from '../../../core/models/board.models';
import { BoardApiService } from '../../../core/services/board-api.service';
import { BoardSocketService } from '../../../core/services/board-socket.service';
import { messageOf } from '../../../core/state/board-state.service';
import { AskOption, DialogQuestion, dialogQuestions } from '../../../shared/utils/question-blocks';
import { MarkdownViewComponent } from '../markdown-view/markdown-view.component';

/** What the user has given one question so far - nothing is sent until Send. */
interface Draft {
  readonly pick: readonly string[];
  readonly other: string;
  readonly note: string;
  readonly later: boolean;
}

const EMPTY: Draft = { pick: [], other: '', note: '', later: false };

/**
 * Claude's open questions on a card in one dialog (specs/019, docs/board.md "Questions"), like Claude in chat: a tab per
 * question, options that say what Claude will then do (one Recommended), a preview on hover, Something else, a note,
 * Decide later, and a Review. Answer all or some and Send once - one answer comment per question comment; what is left
 * stays open. A follow-up an option opens shows at once; questions Claude asks because of the answers arrive live (the
 * board signal, no polling).
 */
@Component({
  selector: 'app-quick-answer',
  standalone: true,
  imports: [MarkdownViewComponent],
  template: `
    <div class="dialog-backdrop" (click)="closed.emit()">
      <div class="dialog-card board-quick-answer" role="dialog" aria-label="Claude's questions" (click)="$event.stopPropagation()">
        @if (card(); as c) {
          <div class="board-quick-head"><b>#{{ c.number }} {{ c.title }}</b>
            <button type="button" class="board-drawer-x" title="Close (Esc)" (click)="closed.emit()">✕</button></div>
          @if (visible().length) {
            <div class="board-qa-meta">✦ Claude asks {{ visible().length }} question{{ visible().length === 1 ? '' : 's' }}
              @if (aboutText(); as about) { <span class="board-qa-about">about “{{ about }}”</span> }</div>
            <div class="board-qa-tabs" role="tablist">
              @for (q of visible(); track q.key; let i = $index) {
                <button type="button" role="tab" class="board-qa-tab" [class.on]="i === cur()" [class.ans]="answered(q)" [class.fu]="!!q.parent || isNew(q)"
                        [attr.aria-selected]="i === cur()" (click)="go(i)">{{ q.parent ? '↳ ' : '' }}{{ q.ask.header }}</button>
              }
              <button type="button" role="tab" class="board-qa-tab" [class.on]="cur() === visible().length" (click)="go(visible().length)">Review</button>
            </div>
            @if (current(); as q) {
              @if (q.parent) { <div class="board-qa-fu">↳ Follow-up · because {{ q.parent.header }} = {{ q.parent.option }}</div> }
              @else if (becauseText(q)) { <div class="board-qa-fu">✦ New from Claude · because {{ becauseText(q) }}</div> }
              <div class="board-qa-q"><app-markdown-view [text]="q.ask.question" />@if (q.ask.multiSelect) { <span class="board-dim"> (choose any)</span> }</div>
              @if (q.ask.why) { <div class="board-qa-why"><b>Why I ask:</b> <app-markdown-view [text]="q.ask.why" /></div> }
              <div class="board-qa-body">
                <div class="board-qa-opts" [class.multi]="q.ask.multiSelect" (mouseleave)="hover.set(null)">
                  @for (o of q.ask.options; track o.label; let k = $index) {
                    <div class="board-qa-opt" role="option" tabindex="0" [class.sel]="draft(q).pick.includes(o.label)" [attr.aria-selected]="draft(q).pick.includes(o.label)"
                         (click)="pick(q, o.label)" (keydown.enter)="pick(q, o.label)" (keydown.space)="$event.preventDefault(); pick(q, o.label)"
                         (mouseenter)="hover.set(k)" (focus)="hover.set(k)">
                      <span class="board-qa-key">{{ k + 1 }}</span>
                      <div><div class="board-qa-ol">{{ o.label }}</div>
                        @if (o.description) { <div class="board-qa-od"><app-markdown-view [text]="o.description" /></div> }
                        @if (o.then) { <div class="board-qa-then"><b>Then I will:</b> {{ o.then }}</div> }
                        @if (o.followUp) { <div class="board-qa-then">↳ asks next: {{ o.followUp.header }}</div> }
                      </div>
                      @if (o.recommended) { <span class="board-qa-rec">Recommended</span> } @else { <span></span> }
                    </div>
                  }
                  <div class="board-qa-opt board-qa-other" [class.sel]="!!draft(q).other.trim()">
                    <span class="board-qa-key">{{ q.ask.options.length + 1 }}</span>
                    <div><div class="board-qa-ol">{{ q.ask.options.length ? 'Something else' : 'Your answer' }}</div>
                      <textarea rows="2" [value]="draft(q).other" placeholder="In your own words…" aria-label="Your own answer"
                                (input)="setOther(q, $any($event.target).value)" (keydown)="$event.stopPropagation()"></textarea></div>
                    <span></span>
                  </div>
                </div>
                @if (q.ask.options.length) {
                  <div class="board-qa-preview" aria-live="polite">
                    <div class="board-qa-pvt">{{ previewTitle(q) }}</div>
                    @if (previewOption(q); as o) {
                      @if (o.preview) { <app-markdown-view [text]="o.preview" /> }
                      @else {
                        @if (o.description) { <app-markdown-view [text]="o.description" /> }
                        @if (o.then) { <p><b>Then I will:</b> {{ o.then }}</p> }
                        @if (!o.description && !o.then) { <p class="board-dim">Claude gave no preview for this option.</p> }
                      }
                    } @else {
                      <p class="board-dim">Hover an option: what it changes, how it looks on the recorded calls, what it covers, and why.</p>
                    }
                  </div>
                }
              </div>
              <label class="board-qa-note">Note for Claude on this question (optional)
                <input type="text" [value]="draft(q).note" (input)="setNote(q, $any($event.target).value)" (keydown)="$event.stopPropagation()" /></label>
              <div class="board-qa-row">
                <button type="button" class="action-btn" [class.on]="draft(q).later" title="Put it off until tomorrow - it comes back open"
                        (click)="toggleLater(q)">{{ draft(q).later ? '⏰ Later - undo' : '⏰ Decide later' }}</button>
              </div>
            } @else {
              <div class="board-qa-review">
                <p class="board-dim">Send what you answered; the rest stays open on the card. Your answers may make Claude ask more - they arrive here.</p>
                @for (q of visible(); track q.key; let i = $index) {
                  <div class="board-qa-rv">
                    <span class="board-qa-h">{{ q.parent ? '↳ ' : '' }}{{ q.ask.header }}</span>
                    <span [class.board-dim]="!answered(q)">{{ summary(q) }}</span>
                    <button type="button" class="board-link" (click)="go(i)">edit</button>
                  </div>
                }
              </div>
            }
            <div class="board-qa-foot">
              <button type="button" class="action-btn" [disabled]="cur() === 0" (click)="go(cur() - 1)">‹ Back</button>
              <button type="button" class="action-btn" [disabled]="cur() >= visible().length" (click)="go(cur() + 1)">Next ›</button>
              <span class="board-qa-grow"></span>
              <label class="board-ev-clear"><input type="checkbox" [checked]="clear()" (change)="clear.set($any($event.target).checked)" />
                Clear "Needs decision" when none is left</label>
              <button type="button" class="action-btn primary" [disabled]="!answeredCount() || sending()" (click)="send()">{{ sendLabel() }}</button>
            </div>
          } @else if (loaded()) {
            <div class="board-quick-done">✓ No open question on this card.</div>
          } @else {
            <div class="board-dim">Loading…</div>
          }
          @if (sentNote()) { <div class="board-qa-sent">{{ sentNote() }}</div> }
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
  readonly rows = signal<readonly BoardQuestion[]>([]);
  readonly loaded = signal(false);
  readonly drafts = signal<Readonly<Record<string, Draft>>>({});
  readonly cur = signal(0);
  readonly hover = signal<number | null>(null);
  readonly clear = signal(true);
  readonly sending = signal(false);
  readonly error = signal<string | null>(null);
  readonly sentNote = signal<string | null>(null);
  /** Questions already shown when the dialog opened: one arriving later is marked new. */
  private seen: Set<string> | null = null;

  readonly all = computed(() => dialogQuestions(this.rows(), this.history()));
  /** The questions to answer now: a follow-up only while the option that opens it is picked. */
  readonly visible = computed(() => {
    const qs = this.all();
    const d = this.drafts();
    return qs.filter((q) => {
      if (!q.parent || q.row.state !== 'PENDING') return true;
      const parent = qs.find((p) => p.entryId === q.entryId && p.ask.header === q.parent!.header);
      return !!parent && (d[parent.key]?.pick ?? []).includes(q.parent.option) && !d[parent.key]?.later;
    });
  });
  readonly current = computed(() => this.visible()[this.cur()] ?? null);
  readonly answeredCount = computed(() => this.visible().filter((q) => this.answered(q)).length);
  readonly sendLabel = computed(() => {
    const n = this.answeredCount(), all = this.visible().length;
    return this.sending() ? 'Sending…' : n === 0 ? 'Send 0 answers' : n === all ? `Send all ${n} answer${n === 1 ? '' : 's'}` : `Send ${n} of ${all} answers`;
  });
  readonly aboutText = computed(() => {
    const about = this.all().find((q) => q.block?.about != null)?.block?.about;
    const e = about == null ? undefined : this.history().find((h) => h.id === about);
    return e?.text ? oneLine(e.text.replace(/^\*\*\w+\*\*\s*/, ''), 80) : null;
  });

  constructor() {
    effect(() => {
      const id = this.cardId();
      untracked(() => this.load(id));
    });
    inject(BoardSocketService).events$.pipe(
      filter((e) => e.type === 'board-changed' && e.cardId === this.cardId()),
      takeUntilDestroyed(inject(DestroyRef)),
    ).subscribe(() => this.load(this.cardId(), false));
  }

  private load(id: string, card = true): void {
    if (card) this.api.card(id).subscribe({ next: (c) => this.card.set(c), error: (e) => this.error.set(messageOf(e)) });
    this.api.activity(id).subscribe({ next: (p) => this.history.set(p.entries), error: (e) => this.error.set(messageOf(e)) });
    this.api.questions(id).subscribe({
      next: (rows) => {
        this.rows.set(rows);
        this.loaded.set(true);
        if (!this.seen) this.seen = new Set(dialogQuestions(rows, this.history()).map((q) => q.key));
      },
      error: (e) => { this.error.set(messageOf(e)); this.loaded.set(true); },
    });
  }

  draft(q: DialogQuestion): Draft {
    return this.drafts()[q.key] ?? EMPTY;
  }

  answered(q: DialogQuestion): boolean {
    const d = this.draft(q);
    return d.later || d.pick.length > 0 || d.other.trim() !== '';
  }

  isNew(q: DialogQuestion): boolean {
    return !!this.seen && !this.seen.has(q.key);
  }

  becauseText(q: DialogQuestion): string | null {
    const b = q.block?.because;
    if (!b) return this.isNew(q) ? 'your answers' : null;
    return b.header ? `your answer to ${b.header}` : 'your answers';
  }

  private set(q: DialogQuestion, change: Partial<Draft>): void {
    this.sentNote.set(null);
    this.drafts.update((d) => ({ ...d, [q.key]: { ...(d[q.key] ?? EMPTY), ...change } }));
  }

  pick(q: DialogQuestion, label: string): void {
    const d = this.draft(q);
    if (q.ask.multiSelect) {
      this.set(q, { pick: d.pick.includes(label) ? d.pick.filter((l) => l !== label) : [...d.pick, label], later: false });
    } else {
      this.set(q, { pick: d.pick.includes(label) ? [] : [label], other: '', later: false });
    }
  }

  setOther(q: DialogQuestion, text: string): void {
    this.set(q, q.ask.multiSelect || !text.trim() ? { other: text, later: false } : { other: text, pick: [], later: false });
  }

  setNote(q: DialogQuestion, note: string): void {
    this.set(q, { note });
  }

  toggleLater(q: DialogQuestion): void {
    const later = !this.draft(q).later;
    this.set(q, later ? { later, pick: [], other: '' } : { later });
  }

  go(i: number): void {
    this.hover.set(null);
    this.cur.set(Math.max(0, Math.min(i, this.visible().length)));
  }

  /** 1-4 picks an option, ← → move between the tabs (not while typing). */
  @HostListener('document:keydown', ['$event'])
  onKey(e: KeyboardEvent): void {
    if (e.key === 'Escape') { this.closed.emit(); return; }
    const t = e.target as HTMLElement | null;
    if (t && /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)) return;
    if (e.key === 'ArrowRight') this.go(this.cur() + 1);
    else if (e.key === 'ArrowLeft') this.go(this.cur() - 1);
    else if (/^[1-9]$/.test(e.key)) {
      const q = this.current();
      const o = q?.ask.options[Number(e.key) - 1];
      if (q && o) this.pick(q, o.label);
    }
  }

  previewOption(q: DialogQuestion): AskOption | null {
    const h = this.hover();
    if (h != null) return q.ask.options[h] ?? null;
    const picked = this.draft(q).pick;
    return picked.length ? q.ask.options.find((o) => o.label === picked[picked.length - 1]) ?? null : null;
  }

  previewTitle(q: DialogQuestion): string {
    const h = this.hover();
    if (h != null) return `Preview · if you pick ${h + 1}`;
    return this.draft(q).pick.length ? 'Preview · your answer' : 'Preview';
  }

  summary(q: DialogQuestion): string {
    const d = this.draft(q);
    if (d.later) return 'later - comes back open tomorrow';
    if (!this.answered(q)) return 'not answered - stays open';
    const said = [...d.pick, ...(d.other.trim() ? [`"${d.other.trim()}"`] : [])].join(' · ');
    return said + (d.note.trim() ? ` - ${d.note.trim()}` : '');
  }

  send(): void {
    const c = this.card();
    if (!c || this.sending()) return;
    const tomorrow = new Date(Date.now() + 24 * 3600_000).toISOString();
    const byEntry = new Map<number, Record<string, QuestionAnswer>>();
    for (const q of this.visible()) {
      if (!this.answered(q)) continue;
      const d = this.draft(q);
      const a: QuestionAnswer = d.later ? { later: tomorrow }
        : { chose: d.pick, ...(d.other.trim() ? { other: d.other.trim() } : {}), ...(d.note.trim() ? { note: d.note.trim() } : {}) };
      (byEntry.get(q.entryId) ?? byEntry.set(q.entryId, {}).get(q.entryId)!)[q.row.header] = a;
    }
    const answers: EntryAnswers[] = [...byEntry.entries()].map(([entry, a]) => ({ entry, answers: a }));
    const n = this.answeredCount();
    this.sending.set(true);
    this.api.answers(c.id, answers, this.clear()).subscribe({
      next: () => {
        this.sending.set(false);
        this.error.set(null);
        const sentKeys = new Set(this.visible().filter((q) => this.answered(q)).map((q) => q.key));
        this.drafts.update((d) => Object.fromEntries(Object.entries(d).filter(([k]) => !sentKeys.has(k))));
        this.seen = new Set([...(this.seen ?? []), ...this.all().map((q) => q.key)]);
        this.cur.set(0);
        this.sentNote.set(`✓ Sent ${n} answer${n === 1 ? '' : 's'} - Claude acts on them; what is left stays open.`);
        this.load(c.id, false);
      },
      error: (e) => { this.sending.set(false); this.error.set(messageOf(e)); },
    });
  }
}

function oneLine(s: string, max: number): string {
  const flat = s.replace(/```[\s\S]*?```/g, '').replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}
