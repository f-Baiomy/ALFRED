import { Component, ElementRef, HostListener, computed, inject, input, output, signal } from '@angular/core';
import { ChatMessage, ChatRecord, TerminalItem } from '../../../core/models/chat.models';
import { ChatApiService } from '../../../core/services/chat-api.service';
import { ChatQuestionsComponent } from './chat-questions.component';
import { ChatProposalsComponent } from './chat-proposals.component';
import { ChatConsentComponent } from './chat-consent.component';
import { BoardApiService } from '../../../core/services/board-api.service';
import { Router } from '@angular/router';
import { ChatStateService } from '../../../core/state/chat-state.service';
import { MarkdownViewComponent } from '../../board/markdown-view/markdown-view.component';
import { MentionEditorComponent } from '../../board/mention-editor/mention-editor.component';
import { LiveWorkBoxComponent } from '../../board/live-work-box/live-work-box.component';
import { MentionChipComponent } from '../../board/mention-chip/mention-chip.component';
import { mentionsIn } from '../../../shared/utils/mention-syntax';
import { copyToClipboard } from '../../../shared/utils/clipboard';
import { nth, ticksOf } from '../../../shared/utils/chat-queue';
import { messageOf } from '../../../core/state/board-state.service';

/**
 * One chat message (specs/022): who and when, the ticks and place in line of the user's own, the text as the board
 * shows text (mentions as chips), Claude's live steps while it answers, the automatic records with Undo, and the hover
 * actions (reply in a thread, quote, make a card, copy a link). The user's messages sit on the right.
 */
@Component({
  selector: 'app-chat-message',
  standalone: true,
  imports: [MarkdownViewComponent, MentionEditorComponent, LiveWorkBoxComponent, MentionChipComponent, ChatQuestionsComponent, ChatProposalsComponent, ChatConsentComponent],
  template: `
    @let m = message();
    @if (m.kind === 'SYSTEM') {
      <div class="chat-sys" [attr.data-chat-id]="m.id">{{ plain(m.text) }}</div>
    } @else if (m.kind === 'TASK') {
      <div class="chat-sys" [attr.data-chat-id]="m.id">
        {{ m.origin === 'compact' ? '⇊ compact' : m.origin === 'refresh' ? '↻ refresh from the terminal session' : '✦ task' }}
        · {{ m.state === 'WAITING' ? (claudeOn() ? 'waiting for Claude' : 'waits for Claude to start') : m.state === 'TAKEN' ? 'Claude is on it' : 'done' }}
      </div>
    } @else {
      <div class="chat-msg" [class.me]="mine()" [class.claude]="m.author === 'CLAUDE'" [class.alfred]="m.author === 'ALFRED'"
           [class.flash]="flash()" [class.hit]="hit()" [attr.data-chat-id]="m.id">
        <div class="board-ev-who">
          <span class="who-dot"></span>
          <b>{{ m.author === 'USER' ? 'You' : m.author === 'CLAUDE' ? 'Claude' : 'Alfred' }}</b>
          <span class="board-dim"> · {{ time(m.createdAt) }}{{ m.editedAt ? ' · edited' : '' }}</span>
          @if (m.urgent && m.state === 'WAITING') { <span class="chat-urgent">⚡ answer first</span> }
          @if (m.decision) { <span class="chat-decision">★ decision</span> }
          @if (m.origin && m.origin !== 'typed') { <span class="chat-origin">{{ origin(m.origin) }}</span> }
          @if (m.bridgeFrom === 'project') { <span class="chat-origin">from the project chat</span> }
          @if (m.superseded) { <span class="chat-super">asked again</span> }
          @if (ticks(); as t) { <span class="chat-tick" [class.got]="t.tone === 'got'" [class.done]="t.tone === 'done'" [title]="t.text">{{ t.marks }} {{ t.text }}</span> }
          @if (position(); as n) { <span class="board-ev-badge dim">{{ nthOf(n) }} in line</span> }
          @if (editable() && !editing()) {
            <!-- On the name/time row, never over the text: three quiet icons on hover, the rest under ⋯. -->
            <div class="chat-hover" [class.open]="moreOpen()">
              <button type="button" title="Reply in a thread" aria-label="Reply" (click)="replying.set(!replying())">↩</button>
              @for (e of quickReactions(); track e) {
                <button type="button" [title]="e === '❓' ? 'Explain more - Claude answers in the thread' : 'React ' + e" (click)="react(e)">{{ e }}</button>
              }
              <button type="button" class="more" title="More" aria-label="More" [class.on]="moreOpen()" [attr.aria-expanded]="moreOpen()" (click)="toggleMore($event)">⋯</button>
              @if (moreOpen()) {
                <div class="chat-hover-menu" role="menu" [class.up]="moreUp()">
                  <button type="button" role="menuitem" (click)="moreOpen.set(false); quote.emit(plain(m.text))">❝ Quote in my next message</button>
                  <button type="button" role="menuitem" (click)="moreOpen.set(false); makeCard()">＋ Make a card from it</button>
                  <button type="button" role="menuitem" (click)="moreOpen.set(false); openToCard()">→ Post it to a card</button>
                  <button type="button" role="menuitem" (click)="moreOpen.set(false); toggleDecision()">{{ m.decision ? '☆ No longer a decision' : '★ Mark as a decision' }}</button>
                  @if (m.author === 'CLAUDE' && m.replyTo != null && !m.superseded) {
                    <button type="button" role="menuitem" (click)="moreOpen.set(false); askingAgain.set(true)">↻ Ask again with more context</button>
                  }
                  <button type="button" role="menuitem" (click)="moreOpen.set(false); copyLink()">🔗 Copy a link to it</button>
                  @if (moreReactions().length) {
                    <div class="chat-hover-reacts">
                      @for (e of moreReactions(); track e) {
                        <button type="button" [title]="e === '❓' ? 'Explain more - Claude answers in the thread' : 'React ' + e" (click)="moreOpen.set(false); react(e)">{{ e }}</button>
                      }
                    </div>
                  }
                </div>
              }
            </div>
          }
        </div>
        @if (contextRefs().length) {
          <div class="chat-ctx">looking at @for (r of contextRefs(); track $index) { <app-mention-chip [mention]="r" /> }</div>
        }
        @if (m.quote) { <div class="chat-quote"><span>{{ m.quote }}</span></div> }
        @if (editing()) {
          <app-mention-editor [project]="m.project" [cycleId]="m.scope === 'project' ? null : m.scope" [(value)]="draft" submitLabel="Save"
                              [cancellable]="true" (submitted)="saveEdit($event)" (cancelled)="editing.set(false)" />
        } @else {
          <div class="board-ev-body"><app-markdown-view [text]="m.text" [previews]="m.author === 'CLAUDE'" [snippetContext]="snippetContext()"
            [snippetOwner]="m.author === 'CLAUDE' ? 'inline:chat:' + m.id + ':a' : null" /></div>
        }
        @if (hasQuestions()) { <app-chat-questions [message]="m" [editable]="editable()" /> }
        @if (hasProposals()) { <app-chat-proposals [message]="m" [editable]="editable()" /> }
        <app-chat-consent [message]="m" [editable]="editable()" />
        @if (toCard()) {
          <div class="chat-again">
            <b>Post to a card</b> <span class="board-dim">- as a comment linked back to this message</span>
            <input type="number" class="board-input" min="1" placeholder="#" [value]="cardNo" (input)="cardNo = +$any($event.target).value" style="width:5rem" />
            <textarea class="board-input" rows="3" [value]="cardText" (input)="cardText = $any($event.target).value"></textarea>
            <div class="board-ev-acts">
              <button type="button" class="action-btn primary" [disabled]="!cardNo || !cardText.trim()" (click)="postToCard()">Post</button>
              <button type="button" class="board-link" (click)="toCard.set(false)">Cancel</button>
            </div>
          </div>
        }
        @if (reactionList().length) {
          <div class="chat-reacts">
            @for (r of reactionList(); track r.emoji) {
              <button type="button" class="chat-react" [disabled]="!editable()" title="Take your reaction back" (click)="react(r.emoji)">{{ r.emoji }}</button>
            }
          </div>
        }
        @if (askingAgain()) {
          <div class="chat-again">
            <b>Ask again</b> <span class="board-dim">- the answer stays, marked "asked again"; Claude also reads:</span>
            <label><input type="checkbox" [checked]="again.logs" (change)="again.logs = $any($event.target).checked" /> log lines</label>
            <label><input type="checkbox" [checked]="again.sql" (change)="again.sql = $any($event.target).checked" /> SQL</label>
            <label><input type="checkbox" [checked]="again.items" (change)="again.items = $any($event.target).checked" /> acceptance items</label>
            <textarea class="board-input" rows="2" maxlength="4000" placeholder="Anything to add (optional)" [value]="again.text"
                      (input)="again.text = $any($event.target).value"></textarea>
            <div class="board-ev-acts">
              <button type="button" class="action-btn primary" (click)="askAgain()">↻ Ask again</button>
              <button type="button" class="board-link" (click)="askingAgain.set(false)">Cancel</button>
            </div>
          </div>
        }
        @if (mine() && m.state === 'WAITING' && editable() && !editing()) {
          <div class="board-ev-acts">
            <button type="button" class="board-link" (click)="startEdit()">Edit</button>
            <button type="button" class="board-link" (click)="cancel()">Cancel</button>
            @if (!m.urgent) { <button type="button" class="board-link" title="Claude answers this before the others" (click)="urgent()">⚡ Answer first</button> }
          </div>
        }
        @if (mine() && (m.state === 'TAKEN' || work())) {
          <app-live-work-box [project]="m.project" [chatMessageId]="m.id" [editable]="editable()" [compact]="true" />
        }
        @if (records().length || terminal().length) {
          <div class="chat-tags">
            @for (r of records(); track r.id) {
              <span class="chat-tag rec" [class.undone]="!!r.undoneAt" [title]="r.kind.toLowerCase() + ': ' + r.line"><span class="t">✓ {{ r.line }}</span>
                @if (!r.undoneAt && editable()) { <button type="button" class="board-link" (click)="undo(r)">Undo</button> }</span>
            }
            @if (terminal().length) {
              <span class="chat-tag term" [class.urgent]="termUrgent()" [title]="termTitle()"><span class="t">↗ terminal{{ termUrgent() ? ' ⚡' : '' }} · {{ termState() }}</span>
                @if (termUndoable().length && editable()) { <button type="button" class="board-link" (click)="undoTerminalAll()">Undo</button> }</span>
            }
          </div>
        }
        @if (error(); as e) { <div class="board-error" role="alert">{{ e }}</div> }
        @if (replies().length || replying()) {
          <div class="board-ev-reply" [class.claude]="m.author === 'CLAUDE'">
            @if (replies().length && !threadOpen()) {
              <button type="button" class="chat-thread-toggle" (click)="threadOpen.set(true)">{{ replies().length }} repl{{ replies().length === 1 ? 'y' : 'ies' }} ▸</button>
            } @else {
              @for (r of replies(); track r.id) {
                <app-chat-message [message]="r" [records]="recordsOf()(r.id)" [claudeOn]="claudeOn()" [editable]="editable()" [position]="positionOf()(r.id)"
                                  [focusId]="focusId()" [hitIds]="hitIds()" [recordsOf]="recordsOf()" [positionOf]="positionOf()" (quote)="quote.emit($event)" />
              }
            }
            @if (replying()) {
              <div class="board-ev-replybox">
                <div class="board-ev-replyto"><span>Reply in this thread</span><button type="button" class="board-link" (click)="replying.set(false)">✕</button></div>
                <app-mention-editor [project]="m.project" [cycleId]="m.scope === 'project' ? null : m.scope" submitLabel="Send" [rows]="2"
                                    [draftKey]="'chat-thread:' + m.id" (submitted)="sendReply($event)" />
              </div>
            }
          </div>
        }
      </div>
    }`,
})
export class ChatMessageComponent {
  /** The reactions a message takes (the board's, plus ❓ "explain more" on Claude's answers). */
  private static readonly REACTIONS = ['👍', '✅', '🤔', '👀', '🎉', '❌'];
  readonly askingAgain = signal(false);
  again = { logs: false, sql: false, items: false, text: '' };
  private readonly api = inject(ChatApiService);
  private readonly board = inject(BoardApiService);
  private readonly router = inject(Router);
  readonly state = inject(ChatStateService);

  readonly message = input.required<ChatMessage>();
  readonly replies = input<readonly ChatMessage[]>([]);
  readonly records = input<readonly ChatRecord[]>([]);
  /** What this exchange sent the terminal session (FR-050, FR-051). */
  readonly terminal = input<readonly TerminalItem[]>([]);
  readonly claudeOn = input(false);
  /** Where a visual in the answer runs (FR-032): a cycle chat's visuals can be pinned to its task or saved as a widget. */
  readonly snippetContext = computed<Record<string, unknown>>(() => {
    const m = this.message();
    return m.scope === 'project' ? { project: m.project, chat: m.id } : { project: m.project, cycleId: m.scope, chat: m.id };
  });
  readonly hasProposals = computed(() => Array.isArray((this.message().extra as { proposals?: unknown } | null)?.proposals));
  readonly toCard = signal(false);
  cardNo = 0;
  cardText = '';

  /** "→ Card" (FR-027): the message, or what is selected of it, as a comment on a card, linked back to the chat. */
  openToCard(): void {
    const sel = typeof window !== 'undefined' ? window.getSelection()?.toString().trim() ?? '' : '';
    this.cardText = sel || this.plain(this.message().text);
    this.toCard.set(true);
  }

  postToCard(): void {
    const m = this.message();
    const n = Math.round(this.cardNo);
    const text = `${this.cardText.trim()}\n\nFrom the board chat: @[chat:${m.project}/${m.scope}#${m.id}|chat #${m.id}]`;
    this.call(this.board.cardByNumber(m.project, n), (card) => this.call(this.board.comment(card.id, text), () => {
      this.toCard.set(false);
      this.cardText = '';
    }));
  }

  readonly hasQuestions = computed(() => Array.isArray((this.message().extra as { questions?: unknown } | null)?.questions));
  readonly reactionChoices = computed(() => (this.message().author === 'CLAUDE' ? [...ChatMessageComponent.REACTIONS.slice(0, 3), '❓'] : ChatMessageComponent.REACTIONS.slice(0, 3)));
  readonly reactionList = computed(() => Object.entries(this.message().reactions ?? {}).filter(([, n]) => n > 0).map(([emoji]) => ({ emoji })));

  toggleDecision(): void {
    const m = this.message();
    this.state.run(this.api.decision(m.id, !m.decision), m.scope);
  }

  react(emoji: string): void {
    const m = this.message();
    this.state.run(this.api.react(m.id, emoji), m.scope);
  }

  askAgain(): void {
    const m = this.message();
    const a = this.again;
    this.state.run(this.api.again(m.id, { logs: a.logs, sql: a.sql, items: a.items, ...(a.text.trim() ? { text: a.text.trim() } : {}) }), m.scope, () => {
      this.askingAgain.set(false);
      this.again = { logs: false, sql: false, items: false, text: '' };
    });
  }
  readonly editable = input(true);
  /** Place in line while it waits (null otherwise). */
  readonly position = input<number | null>(null);
  readonly focusId = input<number | null>(null);
  /** Lookups for the thread's replies (records and place in line by message id). */
  readonly recordsOf = input<(id: number) => readonly ChatRecord[]>(() => []);
  readonly positionOf = input<(id: number) => number | null>(() => null);
  readonly quote = output<string>();

  readonly editing = signal(false);
  readonly replying = signal(false);
  readonly moreOpen = signal(false);
  /** The ⋯ menu opens upward when the chat has no room for it below (it would hide behind the composer). */
  readonly moreUp = signal(false);
  private readonly host = inject(ElementRef<HTMLElement>);

  toggleMore(e: MouseEvent): void {
    if (this.moreOpen()) {
      this.moreOpen.set(false);
      return;
    }
    const btn = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const box = (this.host.nativeElement.closest('.chat-stream, .chat-dock') as HTMLElement | null)?.getBoundingClientRect();
    const below = (box ? box.bottom : window.innerHeight) - btn.bottom;
    this.moreUp.set(below < 300 && btn.top - (box ? box.top : 0) > below);
    this.moreOpen.set(true);
  }

  /** The menu stays while the pointer travels to it; a click elsewhere or Esc closes it. */
  @HostListener('document:click', ['$event'])
  closeMoreOutside(e: MouseEvent): void {
    if (this.moreOpen() && !this.host.nativeElement.querySelector('.chat-hover')?.contains(e.target as Node)) this.moreOpen.set(false);
  }

  @HostListener('document:keydown.escape')
  closeMore(): void {
    this.moreOpen.set(false);
  }
  /** On the bar itself: the two most used reactions; the rest sit in the ⋯ menu. */
  readonly quickReactions = computed(() => this.reactionChoices().slice(0, 2));
  readonly moreReactions = computed(() => this.reactionChoices().slice(2));
  readonly threadOpen = signal(true);
  readonly error = signal<string | null>(null);
  draft = '';

  readonly mine = computed(() => this.message().author === 'USER');
  readonly ticks = computed(() => ticksOf(this.message(), this.claudeOn()));
  readonly work = computed(() => this.state.workByMessage().get(this.message().id) ?? null);
  readonly flash = computed(() => this.focusId() === this.message().id);
  /** The ids the chat's search found - a found message is outlined. */
  readonly hitIds = input<ReadonlySet<number>>(new Set());
  readonly hit = computed(() => this.hitIds().has(this.message().id));
  readonly contextRefs = computed(() => mentionsIn(this.message().context.join(' ')));

  nthOf(n: number): string {
    return nth(n);
  }

  time(iso: string): string {
    return new Date(iso).toTimeString().slice(0, 5);
  }

  origin(o: string): string {
    return o.startsWith('skill:') ? '/' + o.slice(6) : o === 'ask-item' ? 'asked from the board' : o === 'explain' ? '❓ explain more' : o.replace(/-/g, ' ');
  }

  /** The words of a text (HTML from the editor or Markdown) for a quote or a system line. */
  plain(text: string): string {
    return text.replace(/<[^>]*>/g, ' ').replace(/@\[[a-z]+:[^|\]]*\|([^\]]*)]/g, '$1').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
  }

  startEdit(): void {
    this.draft = this.message().text;
    this.editing.set(true);
  }

  saveEdit(text: string): void {
    this.call(this.api.edit(this.message().id, text), () => this.editing.set(false));
  }

  cancel(): void {
    this.call(this.api.cancel(this.message().id));
  }

  urgent(): void {
    this.call(this.api.urgent(this.message().id));
  }

  reasonOf(reason: string | null): string {
    return reason === 'contradicts' ? 'contradicts what it is doing' : reason === 'changed-files' ? 'files it edited changed'
      : reason === 'compact' ? 'the chat was compacted' : reason === 'addressed' ? 'a message for it' : reason ?? 'a note';
  }

  stateOf(state: TerminalItem['state']): string {
    return state === 'WAITING' ? 'held - no terminal now' : state === 'QUEUED' ? 'at its next turn' : state.toLowerCase();
  }

  canUndo(t: TerminalItem): boolean {
    return t.state !== 'READ' && t.state !== 'UNDONE';
  }

  undoTerminal(id: number): void {
    this.call(this.api.undoTerminal(id));
  }

  /** What this exchange sent the terminal, as one tag: urgent if any part was, its state, every part in the tooltip. */
  readonly termUrgent = computed(() => this.terminal().some((t) => t.urgent && t.state !== 'UNDONE'));
  readonly termUndoable = computed(() => this.terminal().filter((t) => this.canUndo(t)));
  readonly termState = computed(() => {
    const live = this.terminal().filter((t) => t.state !== 'UNDONE');
    if (!live.length) return 'undone';
    return live.every((t) => t.state === 'READ') ? 'read' : this.stateOf(live[0].state);
  });
  readonly termTitle = computed(() => this.terminal()
    .map((t) => `${t.urgent ? '⚡' : '💬'} ${t.mirror ? 'mirrored to the terminal session' : 'to the terminal: ' + this.reasonOf(t.reason)} - ${this.stateOf(t.state)}`)
    .join('\n'));

  undoTerminalAll(): void {
    for (const t of this.termUndoable()) this.undoTerminal(t.id);
  }

  undo(r: ChatRecord): void {
    this.call(this.api.undoRecord(r.id));
  }

  sendReply(text: string): void {
    const m = this.message();
    this.state.send(m.scope, { text, parentId: m.parentId ?? m.id }, () => this.replying.set(false));
  }

  copyLink(): void {
    const m = this.message();
    void copyToClipboard(`@[chat:${m.project}/${m.scope}#${m.id}|chat #${m.id}]`);
  }

  /** A card in the Inbox with the message as its description and a chip back to it (FR-010). */
  makeCard(): void {
    const m = this.message();
    const words = this.plain(m.text);
    const title = words.length > 90 ? `${words.slice(0, 89)}…` : words || `From chat #${m.id}`;
    const link = { type: 'chat', ref: `${m.project}/${m.scope}#${m.id}`, label: `chat #${m.id}` };
    this.call(this.board.create({ project: m.project, kind: 'TASK', title, cycleId: m.scope === 'project' ? null : m.scope,
      description: `${m.text}\n\nFrom the board chat: @[chat:${link.ref}|${link.label}]` }),
    (card) => void this.router.navigate(['/board'], { queryParams: { project: card.project || null, cycle: card.cycleId ?? null, card: card.number } }));
  }

  private call<T>(obs: import('rxjs').Observable<T>, then?: (v: T) => void): void {
    obs.subscribe({ next: (v) => { this.error.set(null); then?.(v); }, error: (e) => this.error.set(messageOf(e)) });
  }
}
