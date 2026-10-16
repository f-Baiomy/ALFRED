import { TeamsStateService } from '../../../core/state/teams-state.service';
import { TextDirectionStateService } from '../../../core/state/text-direction-state.service';
import { choiceLabel, nextChoice } from '../../../shared/utils/text-direction';
import { NgTemplateOutlet } from '@angular/common';
import { ChangeDetectionStrategy, Component, ElementRef, Injector, afterNextRender, computed, effect, inject, input, output, signal, untracked, viewChild } from '@angular/core';
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
import { depthTintClass } from '../../../shared/utils/call-tree';
import { EARLIER_PAGE, RECENT_THREADS, ReplyNode, TimelineFilter, isNewEntry, pathTo, replyTree, timelineRows } from '../../../shared/utils/timeline-view';
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
 * A card's history (FR-027, FR-028; layout specs/023): day dividers, each comment with its replies as one thread, runs of
 * changes as one line. On a long card the history before the last few threads waits behind one "Show N earlier" line
 * (never an open question or anything new), a long thread folds its middle replies, and a comment's actions sit in a bar that shows on hover. Every thread has
 * Reply…; Claude's open question has Answer, with "clear Needs decision" ticked when it is the last open one.
 */
@Component({
  selector: 'app-activity-timeline',
  standalone: true,
  // all of its state is signals: the drawer's scrolling, typing and hovering never re-check a long history
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MarkdownViewComponent, MentionChipComponent, MentionEditorComponent, NgTemplateOutlet],
  template: `
    <div class="board-timeline cd-timeline">
      @for (row of rows(); track row.key) {
        @switch (row.kind) {
          @case ('day') { <div class="cd-day">{{ row.label }}</div> }
          @case ('changes') {
            @if (row.entries.length === 1 || openChanges().has(row.key)) {
              @for (c of row.entries; track c.entry.id) {
                <div class="board-ev sys cd-change" [attr.data-entry]="c.entry.id">
                  @for (seg of change(c.entry); track $index) {
                    @if (seg.mention; as m) { <app-mention-chip [mention]="m" [showPreview]="false" /> } @else { {{ seg.text }} }
                  } <span class="cd-time" [title]="full(c.entry.at)">· {{ time(c.entry.at) }}</span>
                </div>
              }
            } @else {
              <button type="button" class="cd-changes" (click)="openChange(row.key)" [title]="'Show the ' + row.entries.length + ' changes'">
                · {{ row.entries.length }} changes - {{ changesSummary(row.entries) }}</button>
            }
          }
          @case ('thread') {
            @let item = row.item;
            @let kids = treeOf(item);
              <div class="cd-thread" [class]="kids.length && repliesOpen(item.entry.id) ? 'cd-thread cd-has-open ' + kidsTint(1) : 'cd-thread'">
                <ng-container [ngTemplateOutlet]="comment" [ngTemplateOutletContext]="{ $implicit: item.entry, item: item, root: true }" />
                @if (kids.length) {
                  <div class="cd-branch">
                    <div class="cd-fold-row"><ng-container [ngTemplateOutlet]="fold" [ngTemplateOutletContext]="{ id: item.entry.id, size: item.replies.length, fresh: freshIn(kids) }" /></div>
                    @if (repliesOpen(item.entry.id)) {
                      <div [class]="'cd-kids ' + tint(1)">
                        <button type="button" class="cd-rail" title="Fold these replies" aria-label="Fold these replies" (click)="toggleReplies(item.entry.id)"></button>
                        @for (n of kids; track n.entry.id) { <ng-container [ngTemplateOutlet]="node" [ngTemplateOutletContext]="{ $implicit: n, item: item, depth: 1 }" /> }
                      </div>
                    }
                  </div>
                }
                @if (replyingTo() === item.entry.id) {
                  <ng-container [ngTemplateOutlet]="replyForm" [ngTemplateOutletContext]="{ $implicit: item.entry, item: item }" />
                } @else if (editable()) {
                  <div class="cd-thread-foot">
                    @if (item.question && !item.answered && hasOptions(item)) {
                      <button type="button" class="action-btn" (click)="answerQuestions.emit()">❓ Answer…</button>
                    }
                    <button type="button" class="cd-reply-line" (click)="startReply(item)">{{ item.question && !item.answered ? '↩ Answer in your own words…' : 'Reply…' }}</button>
                  </div>
                }
              </div>
          }
          @case ('earlier') {
            <button type="button" class="cd-earlier" (click)="showMore()">
              ▸ Show {{ row.threads }} earlier {{ row.threads === 1 ? 'thread' : 'threads' }}{{ row.changes ? ' and ' + row.changes + (row.changes === 1 ? ' change' : ' changes') : '' }}</button>
          }
        }
      } @empty {
        <div class="board-dim">{{ query() ? 'Nothing in the activity matches “' + query() + '”.' : 'No history yet.' }}</div>
      }
    </div>
    <!-- a reply in the thread's tree (specs/023): one step right of what it answers; its own replies fold under it -->
    <ng-template #node let-n let-item="item" let-depth="depth">
      <div [class]="n.children.length && repliesOpen(n.entry.id) ? 'cd-kid cd-has-open ' + kidsTint(depth + 1) : 'cd-kid'">
        <ng-container [ngTemplateOutlet]="comment" [ngTemplateOutletContext]="{ $implicit: n.entry, item: item, root: false }" />
        @if (replyingTo() === n.entry.id) {
          <ng-container [ngTemplateOutlet]="replyForm" [ngTemplateOutletContext]="{ $implicit: n.entry, item: item }" />
        }
        @if (n.children.length) {
          <div class="cd-branch">
            <div class="cd-fold-row"><ng-container [ngTemplateOutlet]="fold" [ngTemplateOutletContext]="{ id: n.entry.id, size: n.size, fresh: n.fresh }" /></div>
            @if (repliesOpen(n.entry.id)) {
              <div [class]="'cd-kids ' + tint(depth + 1)">
                <button type="button" class="cd-rail" title="Fold these replies" aria-label="Fold these replies" (click)="toggleReplies(n.entry.id)"></button>
                @for (c of n.children; track c.entry.id) { <ng-container [ngTemplateOutlet]="node" [ngTemplateOutletContext]="{ $implicit: c, item: item, depth: depth + 1 }" /> }
              </div>
            }
          </div>
        }
      </div>
    </ng-template>
    <ng-template #fold let-id="id" let-size="size" let-fresh="fresh">
      <button type="button" class="cd-fold" [attr.aria-expanded]="repliesOpen(id)" (click)="toggleReplies(id)">
        {{ repliesOpen(id) ? '▾' : '▸' }} {{ size }} {{ size === 1 ? 'reply' : 'replies' }}@if (fresh && !repliesOpen(id)) {<span class="cd-fold-new"> · {{ fresh }} new</span>}</button>
    </ng-template>
    <ng-template #replyForm let-to let-item="item">
      @let answering = to.id === item.entry.id && item.question && !item.answered;
      <div class="board-ev-replybox">
        <div class="board-ev-replyto">
          <span>{{ answering ? 'Answering' : 'Replying to' }} {{ name(to) }}: “{{ quote(to, 80) }}”</span>
          <button type="button" class="board-link" title="Cancel" (click)="replyingTo.set(null)">✕</button>
        </div>
        <app-mention-editor #replyBox [project]="project()" [cycleId]="cycleId()" [card]="card()" [attach]="card() ? { card: card()!.id } : null" [rows]="2" [cancellable]="true"
                            [compact]="true" [submitLabel]="answering ? 'Answer' : 'Reply'"
                            placeholder="Write your reply… @ to mention, / for blocks" [draftKey]="card() ? 'reply:' + card()!.id + ':' + to.id : null"
                            (submitted)="send(item, $event, to.id)" (cancelled)="replyingTo.set(null)" />
        @if (answering) {
          <label class="board-ev-clear"><input type="checkbox" [checked]="clearDecision()" (change)="clearDecision.set($any($event.target).checked)" />
            Clear "Needs decision"{{ otherOpen(item) ? ' (' + otherOpen(item) + ' other question' + (otherOpen(item) === 1 ? '' : 's') + ' still open - stays on)' : '' }}</label>
        }
      </div>
    </ng-template>
    <ng-template #comment let-e let-item="item" let-root="root">
      <div class="board-ev cd-c" [class.claude]="e.actor === 'CLAUDE'" [class.me]="e.actor === 'USER'" [class.cd-new]="isNew(e)" [attr.data-entry]="e.id"
           [attr.data-new]="isNew(e) ? '' : null">
        <span class="cd-av" [class.claude]="e.actor === 'CLAUDE'" aria-hidden="true">{{ e.actor === 'CLAUDE' ? '✦' : 'Y' }}</span>
        <div class="cd-c-main">
          <div class="board-ev-who cd-who"><b>{{ who(e) }}</b> <span class="cd-time" [title]="full(e.at)">{{ time(e.at) }}</span>
            @if (isNew(e)) { <span class="cd-newdot" title="New since you last looked"></span> }
            @if (root && item.question) {
              <span class="board-ev-badge" [class.answered]="item.answered">{{ item.answered ? '✓ answered' : 'waiting for you' }}</span>
            }
            @if (!root && item.question && e.actor === 'USER') { <span class="board-dim">answer</span> }
            @if (root && item.edited) { <button type="button" class="board-link board-dim cd-edited" title="See the earlier texts" (click)="showHistory(e)">· edited</button> }
            <span class="cd-hov" [class.keep]="menuFor(e.id)">
              @if (editable()) {
                <span class="board-editor-dd">
                  <button type="button" class="cd-ib" title="React - ✅ on Claude's plan or question is your go-ahead" (click)="toggleMenu('react', e.id)">☺</button>
                  @if (menuOpen('react', e.id)) {
                    <span class="board-editor-dd-menu board-react-menu">
                      @for (x of reactions; track x) {
                        <button type="button" class="board-react" [title]="x === '✅' && e.actor === 'CLAUDE' ? 'Go - Claude may go ahead' : x" (click)="react(e, x)">{{ x }}</button>
                      }
                    </span>
                  }
                </span>
                <button type="button" class="cd-ib" [title]="root && item.question && !item.answered ? 'Answer' : 'Reply'" (click)="startReply(item, e)">↩</button>
              }
              <ng-container [ngTemplateOutlet]="copyMenu" [ngTemplateOutletContext]="{ $implicit: e }" />
              <span class="board-editor-dd">
                <button type="button" class="cd-ib" title="More: text direction, long lines, edit, history" (click)="toggleMenu('more', e.id)">⋯</button>
                @if (menuOpen('more', e.id)) {
                  <span class="board-editor-dd-menu cd-more-menu">
                    <button type="button" class="board-editor-swatch" (click)="flipDir(e)">⇄ Text direction: {{ dirLabel(dirs.choice(e.id)) }}</button>
                    <button type="button" class="board-editor-swatch" (click)="dirs.toggleWrap(e.id); menu.set(null)">{{ dirs.wraps(e.id) ? '⇥ Long lines: scroll sideways' : '⤶ Long lines: wrap' }}</button>
                    @if (e.actor === 'USER' && card() && editable()) { <button type="button" class="board-editor-swatch" (click)="startEdit(e)">✎ Edit</button> }
                    @if (item.edited && root) { <button type="button" class="board-editor-swatch" (click)="menu.set(null); showHistory(e)">🕘 Earlier texts</button> }
                  </span>
                }
              </span>
            </span>
          </div>
          @if (editingId() === e.id) {
            <app-mention-editor [value]="e.text ?? ''" [project]="project()" [cycleId]="cycleId()" [card]="card()" [attach]="card() ? { card: card()!.id } : null" [rows]="4"
                                [cancellable]="true" [enterSends]="false" submitLabel="Save" [draftKey]="card() ? 'edit:' + card()!.id + ':' + e.id : null"
                                (submitted)="saveEdit(e, $event)" (cancelled)="editingId.set(null)" />
            @if (error()) { <div class="run-msg run-msg-err">{{ error() }}</div> }
          } @else {
            <ng-container [ngTemplateOutlet]="body" [ngTemplateOutletContext]="{ $implicit: e }" />
          }
          @if (reactionsOf(e); as rs) {
            @if (rs.length) {
              <div class="board-ev-acts cd-reacts">
                @for (r of rs; track r.emoji) {
                  <button type="button" class="board-react" [class.mine]="r.mine" [disabled]="!editable()" [title]="reactionTitle(e, r)" (click)="react(e, r.emoji)">{{ r.emoji }} {{ r.count }}</button>
                }
                @if (goAhead(e, rs)) { <span class="board-dim">✅ go-ahead given</span> }
              </div>
            }
          }
        </div>
      </div>
    </ng-template>
    <ng-template #copyMenu let-e>
      <span class="board-editor-dd">
        <button type="button" class="cd-ib" title="Copy this comment out - to mail, a chat or a document" (click)="toggleMenu('copy', e.id)">
          {{ copied() === e.id ? '✓' : '⧉' }}</button>
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
            <div class="cd-part" [class]="'cd-part cd-part-' + p.label.toLowerCase()">
              @if (p.label && p.label !== 'REPLY') { <div class="cd-ph">{{ partHead(p.label) }}</div> }
              <app-markdown-view [text]="p.text" [dir]="dirs.choice(e.id)" [wrap]="dirs.wraps(e.id)"
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
  /** All, the conversation, or the changes (the drawer's filter). */
  readonly filter = input<TimelineFilter>('all');
  readonly newestFirst = input(false);
  /** Find in the activity: only the threads that hold it. */
  readonly query = input('');
  /** Entries after this, not the user's own, are new since the user last looked (null: nothing is). */
  readonly newSince = input<string | null>(null);
  private readonly host = inject(ElementRef<HTMLElement>);
  private readonly mentions = inject(BoardMentionsService);

  constructor() {
    // specs/021: a reference to a comment ("your answer · 4:38 PM") opened this card - scroll to that entry and flash it.
    effect(() => {
      const id = this.mentions.entryToShow();
      if (id === null || !this.entries().some((e) => e.id === id)) return;
      untracked(() => {
        this.mentions.entryToShow.set(null);
        // the entry may sit in the earlier history or inside folded replies: show both first
        const thread = this.items().find((i) => i.entry.id === id || i.replies.some((r) => r.id === id));
        if (thread) {
          this.recent.set(Infinity);
          this.openPath(thread, id);
        }
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

  /** The entries this card already showed - one that arrives after is shown, never folded away. */
  private known = new Set<number>();
  /** undefined until the first entries came: then they are the card's opening state, not arrivals. */
  private knownCard: string | null | undefined = undefined;

  /**
   * New replies are shown, not folded (specs/023): on opening a card, the branches holding replies that are new since
   * the user looked open; while it is open, a reply that arrives (Claude answering, say) opens its branch.
   */
  private readonly revealNew = effect(() => {
    const entries = this.entries();
    // the card the entries belong to - not the card input, which can change a moment before its history arrives
    const cardId = entries[0]?.cardId ?? null;
    const since = this.newSince();
    if (cardId === null) return;
    untracked(() => {
      const fresh = cardId !== this.knownCard;
      const reveal = entries.filter((e) => e.kind === 'COMMENT' && e.replyTo != null
        && (fresh ? isNewEntry(e, since) : !this.known.has(e.id)));
      // on opening, Claude's latest answer in the newest thread shows too, even when already seen: it is where the
      // conversation stands
      const last = [...this.items()].reverse().find((i) => i.entry.kind === 'COMMENT');
      const answer = last?.replies[last.replies.length - 1];
      if (fresh && answer?.actor === 'CLAUDE' && answer.kind === 'COMMENT') reveal.push(answer);
      if (fresh) {
        this.knownCard = cardId;
        this.known = new Set();
      }
      entries.forEach((e) => this.known.add(e.id));
      for (const e of reveal) {
        const thread = this.items().find((i) => i.entry.id === e.replyTo);
        if (thread) this.openPath(thread, e.id);
      }
    });
  });

  /** The rail colour of a level of replies - the call waterfall's ramp, its first colour for the first level. */
  tint(depth: number): string {
    return depthTintClass(depth - 1);
  }

  /** The same colour for the line a comment drops to its replies (`--kids-color`, see styles.scss). */
  kidsTint(depth: number): string {
    return this.tint(depth).replace('depth-tint-', 'kids-tint-');
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
  private readonly replyBox = viewChild('replyBox', { read: MentionEditorComponent });
  readonly reactions = REACTIONS;

  readonly items = computed(() => historyThreads(this.entries()));
  /** How many of the latest threads show; the earlier history comes in a page at a time (a long card stays light). */
  readonly recent = signal(RECENT_THREADS);
  /** Older history waits behind the "Show N earlier" line (the drawer brings it in when the user scrolls up to it). */
  readonly hasEarlier = computed(() => this.rows().some((r) => r.kind === 'earlier'));
  /** Comments whose replies are open (specs/023): every thread starts with its replies folded, level 1 too. */
  readonly openReplies = signal<ReadonlySet<number>>(new Set());
  /** Each thread's replies as a tree, by its first comment. */
  readonly trees = computed(() => {
    const since = this.newSince();
    return new Map(this.items().map((i) => [i.entry.id, replyTree(i.replies, since)]));
  });
  readonly openChanges = signal<ReadonlySet<string>>(new Set());
  readonly rows = computed(() => timelineRows(this.items(), {
    filter: this.filter(), newestFirst: this.newestFirst(), query: this.query(), newSince: this.newSince(), recent: this.recent(),
    now: new Date(), textOf: (e) => textAsPlain(e.text),
  }));
  showMore(): void {
    this.recent.update((n) => n + EARLIER_PAGE);
  }

  readonly replyingTo = signal<number | null>(null);
  readonly clearDecision = signal(true);
  readonly editingId = signal<number | null>(null);
  readonly error = signal<string | null>(null);
  /** The open menu: a reaction picker or the copy menu, of one entry. */
  readonly menu = signal<{ kind: 'react' | 'copy' | 'more'; id: number } | null>(null);
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

  menuFor(id: number): boolean {
    return this.menu()?.id === id;
  }

  menuOpen(kind: 'react' | 'copy' | 'more', id: number): boolean {
    const m = this.menu();
    return !!m && m.kind === kind && m.id === id;
  }

  toggleMenu(kind: 'react' | 'copy' | 'more', id: number): void {
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

  isNew(e: ActivityEntry): boolean {
    return isNewEntry(e, this.newSince());
  }

  treeOf(item: HistoryItem): readonly ReplyNode[] {
    return this.trees().get(item.entry.id) ?? [];
  }

  /** New replies anywhere under a thread's first comment. */
  freshIn(kids: readonly ReplyNode[]): number {
    return kids.reduce((n, k) => n + (this.isNew(k.entry) ? 1 : 0) + k.fresh, 0);
  }

  /** Find shows every reply: a match must never sit in a folded branch. */
  repliesOpen(id: number): boolean {
    return !!this.query().trim() || this.openReplies().has(id);
  }

  toggleReplies(id: number): void {
    this.openReplies.update((s) => {
      const next = new Set(s);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  }

  /** Opens the replies on the way to an entry - its thread and every reply above it. */
  openPath(item: HistoryItem, id: number): void {
    const way = id === item.entry.id ? [] : [item.entry.id, ...pathTo(item.replies, id)];
    if (way.length) this.openReplies.update((s) => new Set([...s, ...way]));
  }

  /** Every reply of every thread, open (the drawer's ⊞). */
  openAll(): void {
    const all = new Set<number>();
    const walk = (ns: readonly ReplyNode[]) => ns.forEach((n) => { if (n.children.length) { all.add(n.entry.id); walk(n.children); } });
    for (const [root, kids] of this.trees()) {
      if (kids.length) all.add(root);
      walk(kids);
    }
    this.openReplies.set(all);
  }

  /** Back to the start: every set of replies folded (the drawer's ⊟). */
  foldAll(): void {
    this.openReplies.set(new Set());
  }

  /** "✓ Did", "⚑ Found", "→ Next" - the heading line of a part of Claude's report. */
  partHead(label: string): string {
    const icon: Record<string, string> = { DID: '✓', FOUND: '⚑', NEXT: '→', IMPACT: '◎', QUESTION: '❓', ANSWERS: '✓', WITHDRAWN: '⊘' };
    return `${icon[label] ?? ''} ${label.charAt(0)}${label.slice(1).toLowerCase()}`.trim();
  }

  openChange(key: string): void {
    this.openChanges.update((s) => new Set(s).add(key));
  }

  /** "Claude added Frontend; moved Inbox → To do" - the first two changes of a run, for its one line. */
  changesSummary(run: readonly HistoryItem[]): string {
    const lines = run.slice(0, 2).map((c) => this.change(c.entry).map((s) => s.text ?? s.mention?.label ?? '').join('').trim());
    return lines.join('; ') + (run.length > 2 ? '…' : '');
  }

  /** ✅ from the user on Claude's comment: Claude may go ahead. */
  goAhead(e: ActivityEntry, rs: readonly Reaction[]): boolean {
    return e.actor === 'CLAUDE' && rs.some((r) => r.emoji === '✅' && r.mine);
  }


  /** Reply… under a thread answers its first comment; ↩ on a reply answers that reply. */
  startReply(item: HistoryItem, to?: ActivityEntry): void {
    this.menu.set(null);
    this.clearDecision.set(true);
    this.replyingTo.set(to?.id ?? item.entry.id);
    // ready to type at once, as after clicking into a box
    afterNextRender(() => this.replyBox()?.focus(), { injector: this.injector });
  }

  send(item: HistoryItem, text: string, to: number = item.entry.id): void {
    const answering = to === item.entry.id && item.question && !item.answered;
    this.replied.emit({ text, replyTo: to, clearDecision: answering && this.clearDecision() });
    this.replyingTo.set(null);
    // the new reply lands under what it answers: keep that open so the user sees it arrive
    this.openPath(item, to);
    this.openReplies.update((s) => new Set(s).add(to));
  }

  /** Claude's other unanswered questions on the card - while any stays open, the flag stays on. */
  otherOpen(item: HistoryItem): number {
    return Math.max(0, openQuestions(this.entries()) - (item.question && !item.answered ? 1 : 0));
  }

  who(e: ActivityEntry): string {
    return e.actor === 'CLAUDE' ? 'Claude' : 'You';
  }

  name(e: ActivityEntry): string {
    return this.who(e);
  }

  quote(e: ActivityEntry, max = 80): string {
    const plain = textAsPlain(withoutBlocks(e.text)).replace(/^\*\*(Did|Found|Next|Impact|Reply|Question|Answers|Withdrawn)\*\*\s*/, '').replace(/@\[[a-z]+:[^|\]]*\|([^\]]*)\]/g, '$1')
      .replace(/\s+/g, ' ').trim();
    return plain.length > max ? `${plain.slice(0, max)}…` : plain;
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
    return this.full(iso);
  }

  /** The time of day - the day is in the divider above. */
  time(iso: string): string {
    return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  full(iso: string): string {
    const d = new Date(iso);
    return `${d.toLocaleDateString()} ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
  }
}
