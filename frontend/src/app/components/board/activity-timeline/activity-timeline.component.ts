import { TeamsStateService } from '../../../core/state/teams-state.service';
import { TextDirectionStateService } from '../../../core/state/text-direction-state.service';
import { choiceLabel, nextChoice } from '../../../shared/utils/text-direction';
import { NgTemplateOutlet } from '@angular/common';
import { Component, ElementRef, Injector, computed, effect, inject, input, output, signal, untracked } from '@angular/core';
import { ActivityEntry, MentionRef, REACTIONS, TextVersion } from '../../../core/models/board.models';
import { BoardApiService } from '../../../core/services/board-api.service';
import { GlobalVariablesService } from '../../../core/services/global-variables.service';
import { copyRichToClipboard, copyToClipboard } from '../../../shared/utils/clipboard';
import { blocksToHtml, textAsMarkdown, textAsPlain, textBlocks } from '../../../shared/utils/rich-html';
import { BoardMentionsService, CardPickTarget } from '../../../core/services/board-mentions.service';
import { ClaudeParts, changeText, claudeParts } from '../../../shared/utils/board-activity';
import { QuestionLine, questionLines, withoutBlocks } from '../../../shared/utils/question-blocks';
import { HistoryItem, Reaction, historyThreads, openQuestions, reactionsOf } from '../../../shared/utils/board-threads';
import { parseMentions } from '../../../shared/utils/mention-syntax';
import { MarkdownViewComponent } from '../markdown-view/markdown-view.component';
import { MentionChipComponent } from '../mention-chip/mention-chip.component';
import { MentionEditorComponent } from '../mention-editor/mention-editor.component';

/** A reply written in the timeline: to which comment, and whether answering clears Needs decision. */
export interface TimelineReply {
  readonly text: string;
  readonly replyTo: number;
  readonly clearDecision: boolean;
}

/**
 * A card's history, oldest first (FR-027, FR-028): comments in full, every change in one line, and the replies to a
 * comment gathered under it. Every comment has ↩ Reply; Claude's open question has Answer, with "clear Needs decision"
 * ticked when it is the last open one.
 */
@Component({
  selector: 'app-activity-timeline',
  standalone: true,
  imports: [MarkdownViewComponent, MentionChipComponent, MentionEditorComponent, NgTemplateOutlet],
  template: `
    <div class="board-timeline">
      @for (item of items(); track item.entry.id) {
        @if (item.entry.kind === 'COMMENT') {
          <div class="board-ev" [class.claude]="item.entry.actor === 'CLAUDE'" [class.me]="item.entry.actor === 'USER'" [attr.data-entry]="item.entry.id">
            <div class="board-ev-who"><b>{{ who(item.entry) }}</b> · {{ when(item.entry.at) }}
              @if (item.question) {
                <span class="board-ev-badge" [class.answered]="item.answered">{{ item.answered ? '✓ answered' : 'waiting for you' }}</span>
              }
              @if (item.edited) { <button type="button" class="board-link board-dim" title="See the earlier texts" (click)="showHistory(item.entry)">edited · history</button> }
              <ng-container [ngTemplateOutlet]="dirSwitch" [ngTemplateOutletContext]="{ $implicit: item.entry }" />
            </div>
            @if (editingId() === item.entry.id) {
              <app-mention-editor [value]="item.entry.text ?? ''" [project]="project()" [cycleId]="cycleId()" [card]="card()" [attach]="card() ? { card: card()!.id } : null" [rows]="4"
                                  [cancellable]="true" [enterSends]="false" submitLabel="Save" [draftKey]="card() ? 'edit:' + card()!.id + ':' + item.entry.id : null"
                                  (submitted)="saveEdit(item.entry, $event)" (cancelled)="editingId.set(null)" />
              @if (error()) { <div class="run-msg run-msg-err">{{ error() }}</div> }
            } @else {
              <ng-container [ngTemplateOutlet]="body" [ngTemplateOutletContext]="{ $implicit: item.entry }" />
            }
            <div class="board-ev-acts">
              @for (r of item.reactions; track r.emoji) {
                <button type="button" class="board-react" [class.mine]="r.mine" [disabled]="!editable()" [title]="reactionTitle(item.entry, r)"
                        (click)="react(item.entry, r.emoji)">{{ r.emoji }} {{ r.count }}</button>
              }
              @if (editable()) {
                <span class="board-editor-dd">
                  <button type="button" class="board-link" title="React - ✅ on Claude's plan or question is your go-ahead" (click)="toggleMenu('react', item.entry.id)">☺+</button>
                  @if (menuOpen('react', item.entry.id)) {
                    <span class="board-editor-dd-menu board-react-menu">
                      @for (e of reactions; track e) {
                        <button type="button" class="board-react" [title]="e === '✅' && item.entry.actor === 'CLAUDE' ? 'Go - Claude may go ahead' : e" (click)="react(item.entry, e)">{{ e }}</button>
                      }
                    </span>
                  }
                </span>
                @if (item.question && !item.answered && hasOptions(item)) {
                  <button type="button" class="board-link" (click)="answerQuestions.emit()">❓ Answer…</button>
                  <button type="button" class="board-link" (click)="startReply(item)">↩ Reply</button>
                } @else {
                  <button type="button" class="board-link" (click)="startReply(item)">
                    {{ item.question && !item.answered ? '↩ Answer' : '↩ Reply' }}</button>
                }
                @if (item.entry.actor === 'USER' && card()) { <button type="button" class="board-link" (click)="startEdit(item.entry)">✎ Edit</button> }
              }
              <ng-container [ngTemplateOutlet]="copyMenu" [ngTemplateOutletContext]="{ $implicit: item.entry }" />
              @if (item.replies.length) { <span class="board-dim">{{ item.replies.length }} {{ item.replies.length === 1 ? 'reply' : 'replies' }}</span> }
            </div>
            @for (r of item.replies; track r.id) {
              <div class="board-ev-reply" [class.claude]="r.actor === 'CLAUDE'" [attr.data-entry]="r.id">
                <div class="board-ev-who"><b>{{ who(r) }}</b> · {{ when(r.at) }}
                  @if (item.question && r.actor === 'USER') { <span class="board-dim">answer</span> }
                  <ng-container [ngTemplateOutlet]="dirSwitch" [ngTemplateOutletContext]="{ $implicit: r }" />
                </div>
                <ng-container [ngTemplateOutlet]="body" [ngTemplateOutletContext]="{ $implicit: r }" />
                <div class="board-ev-acts">
                  @for (x of reactionsOf(r); track x.emoji) {
                    <button type="button" class="board-react" [class.mine]="x.mine" [disabled]="!editable()" [title]="reactionTitle(r, x)" (click)="react(r, x.emoji)">{{ x.emoji }} {{ x.count }}</button>
                  }
                  @if (editable()) {
                    <span class="board-editor-dd">
                      <button type="button" class="board-link" title="React" (click)="toggleMenu('react', r.id)">☺+</button>
                      @if (menuOpen('react', r.id)) {
                        <span class="board-editor-dd-menu board-react-menu">
                          @for (e of reactions; track e) { <button type="button" class="board-react" (click)="react(r, e)">{{ e }}</button> }
                        </span>
                      }
                    </span>
                    <button type="button" class="board-link" (click)="startReply(item)">↩ Reply</button>
                  }
                  <ng-container [ngTemplateOutlet]="copyMenu" [ngTemplateOutletContext]="{ $implicit: r }" />
                </div>
              </div>
            }
            @if (replyingTo() === item.entry.id) {
              <div class="board-ev-replybox">
                <div class="board-ev-replyto">
                  <span>{{ item.question && !item.answered ? 'Answering' : 'Replying to' }} {{ who(item.entry) }}: “{{ quote(item.entry) }}”</span>
                  <button type="button" class="board-link" title="Cancel" (click)="replyingTo.set(null)">✕</button>
                </div>
                <app-mention-editor [project]="project()" [cycleId]="cycleId()" [card]="card()" [attach]="card() ? { card: card()!.id } : null" [rows]="2" [cancellable]="true"
                                    [submitLabel]="item.question && !item.answered ? 'Answer' : 'Reply'"
                                    placeholder="Write your reply… type @ to mention, / for blocks" [draftKey]="card() ? 'reply:' + card()!.id + ':' + item.entry.id : null"
                                    (submitted)="send(item, $event)"
                                    (cancelled)="replyingTo.set(null)" />
                @if (item.question && !item.answered) {
                  <label class="board-ev-clear"><input type="checkbox" [checked]="clearDecision()" (change)="clearDecision.set($any($event.target).checked)" />
                    Clear "Needs decision"{{ otherOpen(item) ? ' (' + otherOpen(item) + ' other question' + (otherOpen(item) === 1 ? '' : 's') + ' still open - stays on)' : '' }}</label>
                }
              </div>
            }
          </div>
        } @else {
          <div class="board-ev sys" [attr.data-entry]="item.entry.id">
            @for (seg of change(item.entry); track $index) {
              @if (seg.mention; as m) { <app-mention-chip [mention]="m" [showPreview]="false" /> } @else { {{ seg.text }} }
            } · {{ when(item.entry.at) }}
          </div>
        }
      } @empty {
        <div class="board-dim">No history yet.</div>
      }
    </div>
    <ng-template #dirSwitch let-e>
      <button type="button" class="board-link board-ev-dir" [class.on]="dirs.choice(e.id) !== 'auto'"
              title="Text direction: auto (from its words), right-to-left or left-to-right - for you, in this browser" (click)="flipDir(e)">
        {{ dirLabel(dirs.choice(e.id)) }}</button>
      <button type="button" class="board-link board-ev-dir" [class.on]="dirs.wraps(e.id)"
              [title]="dirs.wraps(e.id) ? 'Long lines wrap - click to keep table rows and code lines whole and scroll them sideways' : 'Table rows and code lines stay whole and scroll sideways - click to wrap them'"
              (click)="dirs.toggleWrap(e.id)">{{ dirs.wraps(e.id) ? '⤶ Wrap' : '⇥ Scroll' }}</button>
    </ng-template>
    <ng-template #copyMenu let-e>
      <span class="board-editor-dd">
        <button type="button" class="board-link" title="Copy this comment out - to mail, a chat or a document" (click)="toggleMenu('copy', e.id)">
          {{ copied() === e.id ? '✓ copied' : '⧉ Copy' }}</button>
        @if (menuOpen('copy', e.id)) {
          <span class="board-editor-dd-menu">
            <button type="button" class="board-editor-swatch" (click)="copy(e, 'rich')">Formatted (mail, Word, Teams)</button>
            <button type="button" class="board-editor-swatch" (click)="copy(e, 'md')">Markdown</button>
            <button type="button" class="board-editor-swatch" (click)="copy(e, 'plain')">Plain text</button>
          </span>
        }
      </span>
    </ng-template>
    <ng-template #body let-e>
      <div class="board-ev-body" [class.folded]="long(e) && !expanded().has(e.id)">
        @if (questionViews().get(e.id); as qs) {
          <div class="board-ev-part"><span class="board-ev-label">QUESTIONS</span>
            <span class="board-dim">{{ qs.length }} question{{ qs.length === 1 ? '' : 's' }}</span></div>
          <div class="board-qlist">
            @for (q of qs; track q.header) {
              <div class="board-qline" [class]="'board-qline board-qline-' + q.state">
                <div class="board-qline-head"><span class="board-qline-mark">{{ q.state === 'answered' ? '✓' : q.state === 'withdrawn' ? '⊘' : q.state === 'later' ? '⏰' : '❓' }}</span>
                  <b>{{ q.followUp ? '↳ ' : '' }}{{ q.header }}</b> <app-markdown-view [text]="q.question" />
                  @if (q.state !== 'answered') { <span class="board-dim">{{ q.state === 'open' ? 'still open' : q.state === 'later' ? 'put off' : 'withdrawn' }}</span> }</div>
                @if (q.options.length) {
                  <div class="board-qline-opts">
                    @for (o of q.options; track o.label) { <span class="board-qline-o" [class.picked]="o.picked">{{ o.label }}{{ o.recommended ? ' ★' : '' }}</span> }
                  </div>
                }
                @if (q.other) { <div class="board-qline-said">“{{ q.other }}”</div> }
                @if (q.note) { <div class="board-qline-said board-dim">note: {{ q.note }}</div> }
              </div>
            }
          </div>
        } @else {
        @if (parts(e.text); as ps) {
          @for (p of ps; track $index) {
            <div class="board-ev-part"><span class="board-ev-label">{{ p.label }}</span><app-markdown-view [text]="p.text" [dir]="dirs.choice(e.id)" [wrap]="dirs.wraps(e.id)"
              [snippetOwner]="snippetOwner(e.id, $index)" [snippetContext]="snippetContext(e.id)" /></div>
          }
        } @else {
          <app-markdown-view [text]="e.text" [dir]="dirs.choice(e.id)" [wrap]="dirs.wraps(e.id)" [snippetOwner]="snippetOwner(e.id, null)"
                             [snippetContext]="snippetContext(e.id)" />
        }
        }
      </div>
      @if (long(e)) {
        <button type="button" class="board-link board-ev-more" (click)="toggleExpanded(e.id)">{{ expanded().has(e.id) ? '▴ Show less' : '▾ Show all' }}</button>
      }
    </ng-template>
    @if (history(); as h) {
      <div class="run-dialog-bg" (click)="history.set(null)">
        <div class="run-dialog board-versions" role="dialog" aria-label="Earlier texts" (click)="$event.stopPropagation()">
          <div class="run-dialog-head"><b>Earlier texts</b><button type="button" class="board-link" (click)="history.set(null)">✕</button></div>
          <div class="board-version now"><div class="board-dim">Now</div><app-markdown-view [text]="h.now" /></div>
          @for (v of h.versions; track $index) {
            <div class="board-version"><div class="board-dim">{{ v.actor === 'CLAUDE' ? '✦ Claude' : 'You' }} · until {{ when(v.at) }}</div><app-markdown-view [text]="v.text" /></div>
          } @empty {
            <div class="board-dim">{{ h.loading ? 'Loading…' : 'No earlier texts.' }}</div>
          }
        </div>
      </div>
    }`,
})
export class ActivityTimelineComponent {
  private readonly teamsState = inject(TeamsStateService);
  /** The ⇄ choice per comment (auto unless the user changed it). */
  readonly dirs = inject(TextDirectionStateService);
  readonly dirLabel = choiceLabel;
  readonly entries = input.required<readonly ActivityEntry[]>();
  readonly editable = input(false);
  readonly project = input('');
  readonly cycleId = input<string | null>(null);
  readonly card = input<CardPickTarget | null>(null);
  private readonly host = inject(ElementRef<HTMLElement>);
  private readonly mentions = inject(BoardMentionsService);

  constructor() {
    // specs/021: a reference to a comment ("your answer · 4:38 PM") opened this card - scroll to that entry and flash it.
    effect(() => {
      const id = this.mentions.entryToShow();
      if (id === null || !this.entries().some((e) => e.id === id)) return;
      untracked(() => {
        this.mentions.entryToShow.set(null);
        setTimeout(() => {
          const el = (this.host.nativeElement as HTMLElement).querySelector(`[data-entry="${id}"]`) as HTMLElement | null;
          if (!el) return;
          el.scrollIntoView({ block: 'center' });
          el.classList.remove('flash');
          void el.offsetWidth;
          el.classList.add('flash');
        });
      });
    });
  }

  /** Where a comment's snippets keep state and shots (specs/017): its card and entry; a part of a Did/Found/Next comment adds its place. */
  snippetOwner(entryId: number, part: number | null): string | null {
    const c = this.card();
    return c ? `inline:card:${c.id}:${entryId}${part == null ? '' : 'p' + part}` : null;
  }

  /**
   * The same object for an entry on every check: a new one each time is a changed input, which re-runs the snippet's
   * effect, which asks for another check - a loop that froze the page as soon as a comment held a snippet.
   */
  snippetContext(entryId: number): Record<string, unknown> {
    const cache = this.contexts();
    let ctx = cache.get(entryId);
    if (!ctx) {
      const c = this.card();
      ctx = c ? { card: c.number, cardId: c.id, project: c.project, cycleId: c.cycleId, comment: entryId } : {};
      cache.set(entryId, ctx);
    }
    return ctx;
  }

  /** One context per entry, made again only when the card changes. */
  private readonly contexts = computed(() => {
    this.card();
    return new Map<number, Record<string, unknown>>();
  });
  readonly replied = output<TimelineReply>();
  /** Open the questions dialog (a question with options is answered there). */
  readonly answerQuestions = output<void>();
  private readonly injector = inject(Injector);
  readonly reactions = REACTIONS;

  readonly items = computed(() => historyThreads(this.entries()));
  readonly replyingTo = signal<number | null>(null);
  readonly clearDecision = signal(true);
  readonly editingId = signal<number | null>(null);
  readonly error = signal<string | null>(null);
  /** The open menu: a reaction picker or the copy menu, of one entry. */
  private readonly menu = signal<{ kind: 'react' | 'copy'; id: number } | null>(null);
  readonly copied = signal<number | null>(null);
  /** Long comments the user opened in full. */
  readonly expanded = signal<ReadonlySet<number>>(new Set());
  readonly history = signal<{ now: string; versions: readonly TextVersion[]; loading: boolean } | null>(null);

  private api(): BoardApiService {
    return this.injector.get(BoardApiService);
  }

  reactionsOf(e: ActivityEntry): Reaction[] {
    return reactionsOf(this.entries(), e.id);
  }

  reactionTitle(e: ActivityEntry, r: Reaction): string {
    const go = r.emoji === '✅' && e.actor === 'CLAUDE' ? ' - Go: Claude may go ahead' : '';
    return `${r.mine ? 'You reacted' : 'Reacted'} ${r.emoji}${go}${this.editable() ? (r.mine ? ' · click to take it back' : ' · click to add yours') : ''}`;
  }

  menuOpen(kind: 'react' | 'copy', id: number): boolean {
    const m = this.menu();
    return !!m && m.kind === kind && m.id === id;
  }

  toggleMenu(kind: 'react' | 'copy', id: number): void {
    this.menu.set(this.menuOpen(kind, id) ? null : { kind, id });
  }

  react(e: ActivityEntry, emoji: string): void {
    const c = this.card();
    this.menu.set(null);
    if (!c || !this.editable()) return;
    this.api().react(c.id, e.id, emoji).subscribe({ error: () => this.error.set('The reaction could not be saved') });
  }

  startEdit(e: ActivityEntry): void {
    this.error.set(null);
    this.menu.set(null);
    this.editingId.set(e.id);
  }

  saveEdit(e: ActivityEntry, text: string): void {
    const c = this.card();
    if (!c) return;
    this.api().editComment(c.id, e.id, text).subscribe({
      next: () => this.editingId.set(null),
      error: (err) => this.error.set(err?.error?.message ?? 'The comment could not be saved'),
    });
  }

  showHistory(e: ActivityEntry): void {
    this.history.set({ now: e.text ?? '', versions: [], loading: true });
    this.api().versions(`comment:${e.id}`).subscribe({
      next: (versions) => this.history.set({ now: e.text ?? '', versions, loading: false }),
      error: () => this.history.set({ now: e.text ?? '', versions: [], loading: false }),
    });
  }

  /** A comment long enough to fold: many lines or a lot of text (a log, a table) - opened with Show all. */
  long(e: ActivityEntry): boolean {
    const t = textAsPlain(e.text);
    return t.length > 1600 || t.split('\n').length > 28;
  }

  toggleExpanded(id: number): void {
    this.expanded.update((s) => {
      const next = new Set(s);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  }

  /** Copies a comment out: formatted, Markdown or plain - variables as their value in plain text, a secret never. */
  copy(e: ActivityEntry, how: 'rich' | 'md' | 'plain'): void {
    this.menu.set(null);
    const text = e.text ?? '';
    const plain = this.withValues(textAsPlain(text));
    const done = () => {
      this.copied.set(e.id);
      setTimeout(() => this.copied.set(null), 1500);
    };
    const run = how === 'rich' ? copyRichToClipboard(blocksToHtml(textBlocks(text)), plain)
      : copyToClipboard(how === 'md' ? textAsMarkdown(text) : plain);
    run.then(done, () => this.error.set('Copy failed'));
  }

  private withValues(text: string): string {
    const vars = this.injector.get(GlobalVariablesService);
    const values = vars.state().variables;
    return text.replace(/\{\{([\w.-]+)\}\}/g, (all, name: string) => (values[name] !== undefined && !vars.isSecret(name) ? values[name] : all));
  }

  startReply(item: HistoryItem): void {
    this.clearDecision.set(true);
    this.replyingTo.set(item.entry.id);
  }

  send(item: HistoryItem, text: string): void {
    const answering = item.question && !item.answered;
    this.replied.emit({ text, replyTo: item.entry.id, clearDecision: answering && this.clearDecision() });
    this.replyingTo.set(null);
  }

  /** Claude's other unanswered questions on the card - while any stays open, the flag stays on. */
  otherOpen(item: HistoryItem): number {
    return Math.max(0, openQuestions(this.entries()) - (item.question && !item.answered ? 1 : 0));
  }

  who(e: ActivityEntry): string {
    return e.actor === 'CLAUDE' ? '✦ Claude' : 'You';
  }

  quote(e: ActivityEntry): string {
    const plain = textAsPlain(withoutBlocks(e.text)).replace(/^\*\*(Did|Found|Next|Impact|Reply|Question|Answers|Withdrawn)\*\*\s*/, '').replace(/@\[[a-z]+:[^|\]]*\|([^\]]*)\]/g, '$1')
      .replace(/\s+/g, ' ').trim();
    return plain.length > 80 ? `${plain.slice(0, 80)}…` : plain;
  }

  flipDir(e: ActivityEntry): void {
    this.dirs.set(e.id, nextChoice(this.dirs.choice(e.id)));
  }

  /** An answer comment shows its summary line - its ```answers block is for Claude and the question view above. */
  parts(text: string | null): ClaudeParts[] | null {
    return claudeParts(text?.startsWith('**Answers**') ? withoutBlocks(text) : text);
  }

  /** Question comments with options, as their questions and the answers their replies hold (specs/019). */
  readonly questionViews = computed(() => {
    const out = new Map<number, QuestionLine[]>();
    for (const item of this.items()) {
      const lines = item.question ? questionLines(item.entry, item.replies) : null;
      if (lines) out.set(item.entry.id, lines);
    }
    return out;
  });

  /** A question with options is answered in the questions dialog, not a free reply. */
  hasOptions(item: HistoryItem): boolean {
    return this.questionViews().has(item.entry.id);
  }

  /** The one-line change, its mentions (a link added or removed) as pills rather than their `@[...]` text. */
  change(e: ActivityEntry): { text?: string; mention?: MentionRef }[] {
    return parseMentions(changeText(e, (id) => this.teamsState.byId().get(id)?.name ?? id)).map((s) => ('mention' in s ? { mention: s.mention } : { text: s.text }));
  }

  when(iso: string): string {
    const d = new Date(iso);
    return `${d.toLocaleDateString()} ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
  }
}
