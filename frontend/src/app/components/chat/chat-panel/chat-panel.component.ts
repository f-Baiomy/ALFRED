import { AfterViewChecked, Component, ElementRef, HostListener, computed, effect, inject, input, signal, untracked, viewChild } from '@angular/core';
import { ChatMessage, ChatRecord, ChatSearchFilter, ChatSettings, ChatSharedGroup, ChatWatch, DEFAULT_CHAT_SETTINGS, PROJECT_SCOPE, TerminalItem } from '../../../core/models/chat.models';
import { ChatApiService } from '../../../core/services/chat-api.service';
import { BoardApiService } from '../../../core/services/board-api.service';
import { ChatMute, ChatStateService } from '../../../core/state/chat-state.service';
import { LiveWorkStateService } from '../../../core/state/live-work-state.service';
import { ReturnPointService } from '../../../core/services/return-point.service';
import { MentionRef } from '../../../core/models/board.models';
import { MentionChipComponent } from '../../board/mention-chip/mention-chip.component';
import { cardChip, withChip } from '../../../shared/utils/chat-context';
import { CHAT_SKILLS, slashSkill } from '../../../shared/utils/chat-skills';
import { ChatMessageComponent } from '../chat-message/chat-message.component';
import { MentionEditorComponent } from '../../board/mention-editor/mention-editor.component';
import { MarkdownViewComponent } from '../../board/markdown-view/markdown-view.component';
import { copyToClipboard } from '../../../shared/utils/clipboard';
import { dayLine, initials, queuePosition, sinceSummary, threadsOf, tokens, unreadOf } from '../../../shared/utils/chat-queue';
import { ChatView } from '../../../core/models/chat.models';
import { SelectOption, SelectPickerComponent } from '../../select-picker/select-picker.component';
import { DesktopNotificationsService } from '../../../core/services/desktop-notifications.service';

/** A summary and the messages folded under it, or one message, in the order the stream shows them. */
type Item = { kind: 'msg'; m: ChatMessage; day: string | null; unreadLine: number | null }
  | { kind: 'fold'; summary: ChatMessage; folded: ChatMessage[]; day: string | null };

/**
 * The open chat (specs/022 FR-001…019): its head (who answers, the two memories, the meter, views), the start steps
 * when no Claude answers it, the stream (summaries fold what they cover - nothing deleted), and the composer. Docked
 * beside the chats bar, wider, the whole page, or in its own window - one component, the view is a class.
 */
@Component({
  selector: 'app-chat-panel',
  standalone: true,
  imports: [ChatMessageComponent, MentionEditorComponent, MarkdownViewComponent, MentionChipComponent, SelectPickerComponent],
  template: `
    @if (scope(); as sc) {
      <aside class="chat-dock" [class.wide]="view() === 'expanded'" [class.full]="view() === 'full' || inWindow()"
             [style.width.px]="view() === 'docked' && !inWindow() ? state.prefs().width : null" aria-label="Board chat">
        @if (view() === 'docked' && !inWindow()) { <div class="chat-resize" (mousedown)="startResize($event)" title="Drag to resize"></div> }
        <div class="chat-head">
          <span class="bar-av" [class.project]="isProject()" [class.cycle]="!isProject()">{{ avatar() }}<span class="bar-st" [class.on]="claudeOn()"></span></span>
          <div class="chat-who">
            <b [title]="title()">{{ title() }}</b>
            <small>
              @if (answering()) { <span class="busy">● answering<span class="bar-typing"><i></i><i></i><i></i></span></span> }
              @else if (claudeOn()) { <span class="on">● Claude on</span> }
              @else { <span>○ Claude off - messages wait</span> }
              @if (summary()?.terminal?.host; as h) { <span> · {{ h }}</span> }
              @if (waitingCount()) { <span> · {{ waitingCount() }} waiting</span> }
              @if (busyCards().length) { <span title="Claude finishes this card first; waiting messages come after it"> · busy on #{{ busyCards()[0] }}</span> }
            </small>
          </div>
          <button type="button" class="chat-icon" [class.on]="searching()" title="Search this chat" aria-label="Search" (click)="toggleSearch()"><svg class="ico" viewBox="0 0 16 16" aria-hidden="true"><path [attr.d]="icons['search']"/></svg></button>
          <span class="chat-views-menu">
            <button type="button" class="chat-icon" [class.on]="menuOpen()" title="More" aria-label="More" (click)="menuOpen.set(!menuOpen()); splitOpen.set(false)"><svg class="ico" viewBox="0 0 16 16" aria-hidden="true"><path [attr.d]="icons['more']"/></svg></button>
            @if (menuOpen()) {
              <div class="ctxmenu open chat-views-pop chat-menu" (mouseleave)="menuOpen.set(false); splitOpen.set(false)">
                <div class="chat-menu-sec">This chat</div>
                <button type="button" [class.on]="sharedOpen()" (click)="menu(toggleSharedFn)">🗂 Shared - everything mentioned</button>
                @if (!isProject() && editable()) {
                  <button type="button" [class.on]="settings().watching" (click)="menu(toggleWatchingFn)">◉ Watch while I test{{ settings().watching ? ' ✓' : '' }}</button>
                }
                <button type="button" [disabled]="!editable()" (click)="menu(compactFn)">⇊ Compact now</button>
                <button type="button" (click)="menu(openMemory)">🧠 What it remembers</button>
                @if (!isProject() && editable()) {
                  <button type="button" (click)="menu(refreshFn)">↻ Catch up with the terminal now</button>
                  <button type="button" (click)="menu(openTerminal)">📤 What the terminal got</button>
                  <button type="button" (click)="menu(openContinue)">⇱ Continue in a terminal</button>
                }
                <button type="button" [class.on]="settingsOpen()" (click)="menu(toggleSettingsFn)">⚙ Settings &amp; notifications</button>
                @if (!inWindow() && !second()) {
                  <div class="chat-menu-sec">View</div>
                  @if (!second()) {
                    <button type="button" (click)="splitOpen.set(!splitOpen())">◫ Open another chat beside ▸</button>
                    @if (splitOpen()) {
                      <div class="chat-menu-sub">
                        @for (r of otherChats(); track r.scope) { <button type="button" (click)="state.openSplit(r.scope); menuOpen.set(false); splitOpen.set(false)">{{ r.label }}</button> }
                        @if (!otherChats().length) { <span class="board-dim">No other chat yet</span> }
                      </div>
                    }
                  }
                }
              </div>
            }
          </span>
          @if (second()) { <button type="button" class="chat-icon" title="Make this the main chat" aria-label="Swap" (click)="state.swapSplit()"><svg class="ico" viewBox="0 0 16 16" aria-hidden="true"><path [attr.d]="icons['swap']"/></svg></button> }
          @if (!inWindow() && !second()) {
            <span class="chat-modes" role="group" aria-label="Chat view">
              @for (v of headViews; track v.id) {
                <button type="button" class="chat-icon" [class.on]="view() === v.id" [attr.aria-pressed]="view() === v.id"
                        [title]="view() === v.id && v.id !== 'window' ? 'Back to the window above the pill' : v.label + (v.keys ? ' (' + v.keys + ')' : '')"
                        [attr.aria-label]="v.label" (click)="setView(view() === v.id && v.id !== 'window' ? 'docked' : v.id)"><svg class="ico" viewBox="0 0 16 16" aria-hidden="true"><path [attr.d]="icons[v.id]"/></svg></button>
              }
            </span>
          }
          @if (!inWindow()) {
            <button type="button" class="chat-icon" title="Fold to a tab beside the pill" aria-label="Minimize" (click)="state.minimize(sc)"><svg class="ico" viewBox="0 0 16 16" aria-hidden="true"><path [attr.d]="icons['minimize']"/></svg></button>
            <button type="button" class="chat-icon" title="Close" aria-label="Close" (click)="second() ? state.closeSplit() : state.close()"><svg class="ico" viewBox="0 0 16 16" aria-hidden="true"><path [attr.d]="icons['close']"/></svg></button>
          }
        </div>
        @if (contextLine()) {
          <button type="button" class="chat-ctxline" [class.open]="ctxOpen()" (click)="ctxOpen.set(!ctxOpen())" title="What this chat knows and remembers">
            @if (movedOn()) { <span class="dot"></span><span class="grow">Terminal moved on · next answer catches up</span> }
            @else if (settings().watching) { <span class="dot green"></span><span class="grow">◉ Watching while you test</span> }
            @else { <span class="grow">🔔 {{ watches().length }} watch{{ watches().length === 1 ? '' : 'es' }} set</span> }
            <span class="pill" title="Messages since the last summary / auto-compact at">{{ counter() }}</span><span class="chev">{{ ctxOpen() ? '▴' : '▾' }}</span>
          </button>
        }
        @if (ctxOpen()) {
          <div class="chat-ctxopen">
            <div class="row"><span>🧠 Claude's memory</span><b>{{ claudeMemory() }}</b></div>
            <div class="row"><span>🗂 Alfred keeps</span><b>{{ alfredMemory() }}</b></div>
            @if (meter(); as mt) { <div class="row"><span>Last answer</span><b>{{ mt.input }} in · {{ mt.cached }} cached · {{ mt.output }} out{{ mt.saved ? ' · ' + mt.saved + ' from cache' : '' }}</b></div> }
            @if (settings().watching || watches().length) {
              <div class="chat-watches">
                @if (settings().watching) { <span class="chat-chip watching">◉ watching while you test@if (editable()) {<button type="button" title="Stop watching" (click)="toggleWatching()">✕</button>}</span> }
                @for (w of watches(); track w.id) {
                  <span class="chat-chip">🔔 {{ w.label }}@if (editable()) {<button type="button" title="Remove this watch" (click)="cancelWatch(w.id)">✕</button>}</span>
                }
              </div>
            }
            @if (!isProject() && editable()) {
              <div class="acts">
                <button type="button" class="action-btn" (click)="refresh()">↻ Catch up now</button>
                <button type="button" class="action-btn" (click)="terminalOpen.set(true)">What the terminal got</button>
                <button type="button" class="action-btn" (click)="continueOpen.set(true)">Continue in a terminal</button>
              </div>
            }
          </div>
        }

        @if (!editable()) { <div class="chat-banner view">View only from here - {{ howToEdit() }}</div> }
        @if (!claudeOn() && editable()) {
          <div class="chat-banner start">
            <h6>Start Claude for this chat</h6>
            @if (isProject()) {
              <div>In a Claude Code session in the app's repo:</div>
              <div class="chat-cmd"><code>{{ projectCommand() }}</code><button type="button" class="action-btn" (click)="copy(projectCommand())">Copy</button></div>
            } @else {
              <div>In the cycle's terminal session (the chat copies it), in the app's repo:</div>
              <div class="chat-cmd"><code>{{ cycleCommand() }}</code><button type="button" class="action-btn" (click)="copy(cycleCommand())">Copy</button></div>
            }
            <div class="board-dim">Your messages wait and are answered when it starts.</div>
          </div>
        }
        @if (settingsOpen()) {
          <div class="pop open chat-settings">
            <h6>This chat</h6>
            <label><input type="checkbox" [checked]="settings().autoN > 0" (change)="setAuto($any($event.target).checked ? 100 : 0)" /> Auto-compact every
              <input type="number" min="20" max="1000" [value]="settings().autoN || 100" [disabled]="!settings().autoN" (change)="setAuto(+$any($event.target).value)" /> messages</label>
            <div class="note">Claude writes a summary; the messages fold under it, never deleted.</div>
            <label>Digest after <input type="number" min="5" max="600" [value]="settings().digestGapMin" (change)="setDigest(+$any($event.target).value)" /> min away</label>
            <label>Notify me
              <app-select-picker class="select-compact" ariaLabel="Notify me" [options]="muteOptions" [value]="mute()" (valueChange)="setMute($any($event))" /></label>
            <label><input type="checkbox" [checked]="state.prefs().notify" (change)="setNotify($any($event.target).checked)" /> Desktop notifications</label>
          </div>
        }
        @if (searching()) {
          <div class="chat-search">
            <input type="search" placeholder="Search this chat…" [value]="query()" (input)="query.set($any($event.target).value)" (keydown.enter)="search()" />
            <button type="button" class="action-btn" (click)="search()">Find</button>
          </div>
          <div class="chat-filters">
            @for (f of filters; track f.id) {
              <button type="button" class="board-tog" [class.on]="filter() === f.id" (click)="filter.set(f.id); search()">{{ f.label }}</button>
            }
          </div>
          @if (hits(); as h) { <div class="chat-search-sum">{{ h.length }} match{{ h.length === 1 ? '' : 'es' }}{{ foldedHits() ? ' · ' + foldedHits() + ' in summaries (opened)' : '' }}</div> }
        }
        @if (sharedOpen()) {
          <div class="chat-shared">
            @if (shared(); as groups) {
              @if (!groups.length) { <div class="board-dim">Nothing mentioned yet.</div> }
              @for (g of groups; track g.type) {
                <div class="chat-shared-group"><b>{{ sharedLabel(g.type) }}</b> <span class="board-dim">{{ g.refs.length }}</span>
                  <div class="chat-shared-refs">
                    @for (r of g.refs; track r.mention.ref) {
                      <span class="chat-chip"><app-mention-chip [mention]="r.mention" [showPreview]="false" />
                        <button type="button" title="Go to the message" (click)="goTo(r.messageId)">↗</button></span>
                    }
                  </div>
                </div>
              }
            } @else { <div class="board-dim">Loading…</div> }
          </div>
        }
        @if (digest(); as d) {
          <details class="chat-digest" [open]="!digestRead()" (toggle)="digestRead.set(true)">
            <summary>While you were away - {{ d.lines.length }} change{{ d.lines.length === 1 ? '' : 's' }} on the board</summary>
            <app-markdown-view [text]="d.text" [previews]="false" />
          </details>
        }
        @if (state.error(); as e) { <div class="chat-banner view" role="alert">{{ e }} <button type="button" class="board-link" (click)="state.error.set(null)">✕</button></div> }

        <div class="chat-stream" #stream (scroll)="onScroll()" (wheel)="onReadUp($event)" (keydown)="onReadUp($event)">
          @if (thread()?.more) { <div class="chat-day"><button type="button" class="board-link" (click)="state.loadOlder(sc)">Load earlier messages</button></div> }
          @if (!thread()) { <div class="board-empty">Loading…</div> }
          @else if (!items().length) {
            <div class="board-empty">No messages yet. Ask anything about {{ isProject() ? 'this project' : 'this cycle' }} - Claude answers with
              {{ isProject() ? "Alfred's view of every cycle" : "everything the cycle's terminal session knows" }}.</div>
          }
          @for (it of items(); track it.kind === 'msg' ? it.m.id : 'f' + it.summary.id) {
            @if (it.day) { <div class="chat-day">{{ it.day }}</div> }
            @if (it.kind === 'fold') {
              <div class="chat-fold summary">
                <div class="chat-fold-head" (click)="toggleFold(it.summary.id)">📌 <b>Summary</b> · covers up to #{{ it.summary.coversTo }} ·
                  {{ it.folded.length }} message{{ it.folded.length === 1 ? '' : 's' }} folded, nothing deleted
                  <span style="margin-left:auto">{{ openFolds().has(it.summary.id) ? '▾' : '▸' }}</span></div>
                <div class="chat-fold-body">
                  <app-markdown-view [text]="it.summary.text" [previews]="false" />
                  @if (openFolds().has(it.summary.id)) {
                    <div class="chat-old">
                      @for (m of it.folded; track m.id) {
                        <app-chat-message [message]="m" [records]="recordsOf(m.id)" [claudeOn]="claudeOn()" [editable]="false" [focusId]="state.focusId()" [hitIds]="hitIds()" />
                      }
                    </div>
                  }
                </div>
              </div>
            } @else {
              @if (it.unreadLine) { <div class="chat-newline">{{ it.unreadLine }} new</div> }
              <app-chat-message [message]="it.m" [replies]="repliesOf(it.m.id)" [records]="recordsOf(it.m.id)" [terminal]="terminalOf(it.m.id)" [claudeOn]="claudeOn()"
                                [editable]="editable()" [position]="positionOf(it.m.id)" [focusId]="state.focusId()" [hitIds]="hitIds()"
                                [recordsOf]="recordsFn" [positionOf]="positionFn" (quote)="quote.set($event)" />
            }
          }
          @if (!atBottom()) { <div class="chat-jump"><button type="button" class="action-btn" (click)="toBottom()">↓ Latest</button></div> }
        </div>

        @if (editable()) {
          <div class="chat-composer">
            @if (quote(); as q) { <div class="chat-quote"><span>❝ {{ q }}</span><button type="button" (click)="quote.set(null)">✕</button></div> }
            @if (chips().length) {
              <div class="chat-chips" title="Sent with your message so Claude sees what you are looking at - ✕ to leave one out">
                <span class="board-dim">looking at</span>
                @for (c of chips(); track c.type + ':' + c.ref) {
                  <span class="chat-chip"><app-mention-chip [mention]="c" [showPreview]="false" /><button type="button" title="Leave it out" (click)="dropChip(c)">✕</button></span>
                }
              </div>
            }
            <app-mention-editor [project]="state.project()" [cycleId]="isProject() ? null : sc" [(value)]="text" [draftKey]="state.draftKey(sc)" [commands]="skills"
                                [rows]="1" [compact]="true" submitLabel="Send" [placeholder]="placeholder()" (submitted)="send($event)" (valueChange)="state.draftChanged()">
              <button editorTools type="button" class="board-editor-cbtn urgent" [class.on]="urgent()" (mousedown)="$event.preventDefault()" (click)="urgent.set(!urgent())"
                      [title]="urgent() ? 'Answered before the waiting messages - click to send normally' : 'Answer first: Claude answers this before the waiting messages'">⚡</button>
            </app-mention-editor>
            @if (isProject() && state.cycles().length) {
              <div class="chat-crow">
                <label class="board-dim" title="Ask the Claude of a cycle - the question and its answer show here and in that cycle's chat">Ask
                  <app-select-picker class="select-compact" ariaLabel="Who answers" [options]="askOptions()" [value]="askCycle() ?? ''" (valueChange)="askCycle.set($event || null)" /></label>
              </div>
            }
            @if (urgent()) { <div class="chat-hint">⚡ answered before the waiting messages</div> }
          </div>
        }

        @if (memoryOpen()) {
          <div class="dialog-backdrop" (click)="memoryOpen.set(false)">
            <div class="dialog-card" (click)="$event.stopPropagation()">
              <h2>What this chat remembers</h2>
              <p class="sub">Two memories work together: the chat's own Claude session, and what Alfred keeps for any session.</p>
              <div class="mem-grid">
                <div class="mem-col claude"><h4>🧠 Claude session</h4>
                  <ul>
                    @if (isProject()) { <li>The project live runner's session - Alfred's context of every cycle.</li> }
                    @else if (summary()?.terminal?.forkedFrom) {
                      <li>A copy of the terminal session <code>{{ short(summary()!.terminal!.forkedFrom!) }}</code> - everything it did up to the copy.</li>
                      <li>Caught up to {{ when(summary()!.terminal!.seenUpTo) }}.</li>
                    } @else { <li>No copy yet - made at the first answer (when the terminal session is on that machine).</li> }
                    @if (summary()?.terminal?.chatSessionId; as id) { <li>Session <code>{{ short(id) }}</code> on {{ summary()?.terminal?.host ?? '?' }}.</li> }
                    <li>Every exchange is also written to the terminal's chat log, so the terminal knows what the chat did.</li>
                  </ul></div>
                <div class="mem-col alfred"><h4>🗂 Alfred</h4>
                  <ul>
                    <li>{{ summariesCount() }} summar{{ summariesCount() === 1 ? 'y' : 'ies' }} · {{ decisionsCount() }} decision{{ decisionsCount() === 1 ? '' : 's' }} recorded</li>
                    <li>Every message, kept in Alfred and exported with the board - a new session reads it through task_context.</li>
                    <li>Records the chat made (brief, cards, items, fix reports) stay on the board.</li>
                  </ul></div>
              </div>
              <div class="dialog-foot"><button type="button" class="action-btn" (click)="memoryOpen.set(false)">Close</button></div>
            </div>
          </div>
        }
        @if (terminalOpen()) {
          <div class="dialog-backdrop" (click)="terminalOpen.set(false)">
            <div class="dialog-card wide" (click)="$event.stopPropagation()">
              <h2>Sent to the terminal session</h2>
              <p class="sub">Every exchange is written to the chat log the terminal follows - ⚡ lines it acts on before its next step, 💬 lines are
                context only. Masked always; long parts travel as references.</p>
              @for (t of terminalItems(); track t.id) {
                <div class="term-row">
                  <span>{{ t.urgent ? '⚡' : '💬' }}</span><span class="term-preview">{{ t.text }}</span>
                  <span class="board-dim">{{ t.state.toLowerCase() }}</span>
                  @if (t.state !== 'READ' && t.state !== 'UNDONE') { <button type="button" class="board-link" (click)="undoTerminal(t.id)">Undo</button> } @else { <span></span> }
                </div>
              } @empty { <p class="board-dim">Nothing yet.</p> }
              <div class="dialog-foot"><button type="button" class="action-btn" (click)="terminalOpen.set(false)">Close</button></div>
            </div>
          </div>
        }
        @if (continueOpen()) {
          <div class="dialog-backdrop" (click)="continueOpen.set(false)">
            <div class="dialog-card" (click)="$event.stopPropagation()">
              <h2>Continue in a terminal</h2>
              @if (summary()?.terminal?.chatSessionId; as id) {
                <p class="sub">The chat's session lives on <b>{{ summary()?.terminal?.host ?? 'the runner\\'s machine' }}</b>. There, in the app's repo:</p>
                <div class="chat-cmd"><code>claude --resume {{ id }}</code><button type="button" class="action-btn" (click)="copy('claude --resume ' + id)">Copy</button></div>
                <p class="board-dim">The chat keeps answering here; both write to the same session, so use one at a time.</p>
              } @else {
                <p class="sub">This chat has no session yet - it is made at Claude's first answer.</p>
              }
              <div class="dialog-foot"><button type="button" class="action-btn" (click)="continueOpen.set(false)">Close</button></div>
            </div>
          </div>
        }
      </aside>
    }`,
})
export class ChatPanelComponent implements AfterViewChecked {
  readonly state = inject(ChatStateService);
  private readonly api = inject(ChatApiService);
  private readonly board = inject(BoardApiService);
  private readonly desk = inject(DesktopNotificationsService);
  private readonly liveWork = inject(LiveWorkStateService);
  /** The card open in a drawer anywhere - the drawer keeps it here for the "back" button too. */
  private readonly returns = inject(ReturnPointService);
  private readonly stream = viewChild<ElementRef<HTMLElement>>('stream');

  /** The window page shows the panel alone, full size. */
  readonly inWindow = input(false);

  readonly views: { id: ChatView; icon: string; label: string; keys: string }[] = [
    { id: 'docked', icon: '▥', label: 'Window above the pill', keys: '' },
    { id: 'expanded', icon: '▭', label: 'Expanded', keys: '' },
    { id: 'full', icon: '⛶', label: 'Full screen', keys: 'Ctrl+Shift+F' },
    { id: 'window', icon: '⧉', label: 'Separate window', keys: '' },
  ];
  /** The modes the header switches between with one click; a mode's own button takes the chat back to the window. */
  readonly headViews = this.views.filter((v) => v.id !== 'docked');
  /** The header's icons: one 16px stroke set, so every button has the same size and baseline (text glyphs did not). */
  readonly icons: Record<string, string> = {
    search: 'M10.5 10.5 14 14M11.5 7a4.5 4.5 0 1 1-9 0 4.5 4.5 0 0 1 9 0',
    more: 'M3.5 8h.01M8 8h.01M12.5 8h.01',
    expanded: 'M9.5 2.5h4v4M13.5 2.5 9 7M6.5 13.5h-4v-4M2.5 13.5 7 9',
    full: 'M2.5 6V2.5H6M10 2.5h3.5V6M13.5 10v3.5H10M6 13.5H2.5V10',
    window: 'M9 2.5h4.5V7M13.5 2.5l-6 6M12 10v3.5H2.5V4H6',
    minimize: 'M3.5 8h9',
    close: 'M4 4l8 8M12 4l-8 8',
    swap: 'M2.5 5.5h10L10 3M13.5 10.5h-10L6 13',
  };
  readonly filters: { id: ChatSearchFilter; label: string }[] = [
    { id: 'all', label: 'All' }, { id: 'mine', label: 'Mine' }, { id: 'claude', label: 'Claude' }, { id: 'decisions', label: '★ Decisions' }, { id: 'calls', label: '⇄ Calls' },
  ];

  /** The second chat of the split view (FR-047) - its own scope, send box and draft. */
  readonly second = input(false);
  readonly scope = computed(() => (this.second() ? this.state.splitScope() : this.state.openScope()));
  readonly view = computed(() => (this.state.view() === 'window' ? 'docked' : this.state.view()));
  readonly thread = computed(() => {
    const sc = this.scope();
    return sc == null ? null : this.state.threads().get(sc) ?? null;
  });
  readonly summary = this.state.openSummary;
  readonly isProject = computed(() => this.scope() === PROJECT_SCOPE);
  readonly title = computed(() => (this.isProject() ? (this.state.project() || 'No project') : this.state.cycleNames().get(this.scope() ?? '') ?? this.scope() ?? ''));
  readonly claudeOn = computed(() => this.summary()?.claudeOn ?? false);
  readonly access = signal({ editable: true, howToEdit: '' });
  readonly editable = computed(() => this.access().editable);
  readonly howToEdit = computed(() => this.access().howToEdit || 'open Alfred on its own machine to write');
  readonly settings = signal<ChatSettings>(DEFAULT_CHAT_SETTINGS);
  readonly mute = computed<ChatMute>(() => this.state.prefs().mute[`${this.state.project()}/${this.scope()}`] ?? 'all');

  readonly viewsOpen = signal(false);
  readonly menuOpen = signal(false);
  readonly ctxOpen = signal(false);
  /** The quiet context line shows only when something is worth knowing. */
  readonly contextLine = computed(() => this.movedOn() || this.settings().watching || this.watches().length > 0);
  readonly avatar = computed(() => (this.isProject() ? 'PR' : initials(this.title())));
  /** Claude is answering in this chat right now (the bar's typing mark). */
  readonly answering = computed(() => this.state.rows().find((r) => r.scope === this.scope())?.typing ?? false);
  readonly openMemory = () => this.memoryOpen.set(true);
  readonly openTerminal = () => this.terminalOpen.set(true);
  readonly openContinue = () => this.continueOpen.set(true);
  readonly toggleSharedFn = () => this.toggleShared();
  readonly toggleWatchingFn = () => this.toggleWatching();
  readonly compactFn = () => this.compact();
  readonly refreshFn = () => this.refresh();
  readonly toggleSettingsFn = () => this.toggleSettings();
  readonly settingsOpen = signal(false);
  readonly memoryOpen = signal(false);
  readonly continueOpen = signal(false);
  readonly terminalOpen = signal(false);
  readonly searching = signal(false);
  readonly query = signal('');
  readonly filter = signal<ChatSearchFilter>('all');
  readonly hits = signal<{ id: number; folded: boolean }[] | null>(null);
  readonly hitIds = computed<ReadonlySet<number>>(() => new Set((this.hits() ?? []).map((h) => h.id)));
  readonly foldedHits = computed(() => (this.hits() ?? []).filter((h) => h.folded).length);
  readonly openFolds = signal<ReadonlySet<number>>(new Set());
  readonly quote = signal<string | null>(null);
  readonly terminalItems = signal<readonly TerminalItem[]>([]);
  readonly urgent = signal(false);
  readonly atBottom = signal(true);
  text = '';
  /** The unread line is placed when a chat opens and stays there while the user reads it. */
  private readonly unreadFrom = signal<{ scope: string; lastSeen: number } | null>(null);
  private stickToBottom = true;
  private scrolledFor: number | null = null;
  private lastHeight = 0;

  readonly messages = computed(() => this.thread()?.messages ?? []);
  readonly threads = computed(() => threadsOf(this.messages()));
  readonly waitingCount = computed(() => this.messages().filter((m) => m.author === 'USER' && m.state === 'WAITING').length);
  readonly counter = computed(() => `${sinceSummary(this.messages())}/${this.settings().autoN || '∞'}`);
  readonly summariesCount = computed(() => this.messages().filter((m) => m.kind === 'SUMMARY').length);
  readonly decisionsCount = computed(() => this.messages().filter((m) => m.decision).length
    + this.messages().reduce((n, m) => n + (m.records ?? []).filter((r) => r.kind === 'DECISION' && !r.undoneAt).length, 0));
  readonly movedOn = computed(() => {
    const t = this.summary()?.terminal;
    return !!t?.terminalAt && (!t.seenUpTo || Date.parse(t.terminalAt) > Date.parse(t.seenUpTo));
  });
  readonly claudeMemory = computed(() => {
    if (this.isProject()) return this.claudeOn() ? 'project session' : 'off';
    const t = this.summary()?.terminal;
    if (!t?.chatSessionId) return 'no copy yet';
    return t.forkedFrom ? `copy of the terminal · ${this.when(t.seenUpTo)}` : 'own session';
  });
  readonly alfredMemory = computed(() => `${this.messages().length} msgs · ${this.summariesCount()} summ. · ${this.decisionsCount()} dec.`);
  readonly meter = computed(() => {
    const answers = this.messages().filter((m) => m.author === 'CLAUDE' && m.replyTo != null);
    for (let i = answers.length - 1; i >= 0; i--) {
      const u = this.state.workByMessage().get(answers[i].replyTo!)?.usage;
      if (u) {
        const cached = u['cacheRead'] ?? 0;
        return { input: tokens(u['input'] ?? 0), cached: tokens(cached), output: tokens(u['output'] ?? 0),
          saved: cached > 0 ? `${Math.round((cached / Math.max(1, cached + (u['input'] ?? 0))) * 100)}%` : null };
      }
    }
    return null;
  });
  readonly placeholder = computed(() => (this.isProject() ? 'Message Claude about the project… @ mention · / skills' : 'Message Claude about this cycle… @ mention · / skills'));
  readonly projectCommand = computed(() => `/alfred-live ${this.state.project() || '""'}`);
  readonly cycleCommand = computed(() => `/alfred-live ${this.state.project() || '""'} ${this.scope()}`);

  readonly items = computed<Item[]>(() => {
    const { top } = this.threads();
    const folded = this.state.folded();
    const unread = this.unreadFrom();
    const firstUnread = unread && unread.scope === this.scope() ? unreadOf(this.messages(), unread.lastSeen) : null;
    const out: Item[] = [];
    let lastAt: string | null = null;
    for (const m of top) {
      if (folded.has(m.id)) continue;
      const day = dayLine(m.createdAt, lastAt);
      lastAt = m.createdAt;
      if (m.kind === 'SUMMARY') {
        const prev = out.filter((x): x is Extract<Item, { kind: 'fold' }> => x.kind === 'fold').map((x) => x.summary.coversTo ?? 0);
        const from = prev.length ? Math.max(...prev) : 0;
        out.push({ kind: 'fold', summary: m, folded: top.filter((x) => folded.has(x.id) && x.id > from && x.id <= (m.coversTo ?? 0)), day });
      } else {
        out.push({ kind: 'msg', m, day, unreadLine: firstUnread?.firstId === m.id && firstUnread.count ? firstUnread.count : null });
      }
    }
    return out;
  });

  readonly recordsFn = (id: number): readonly ChatRecord[] => this.recordsOf(id);
  readonly positionFn = (id: number): number | null => this.positionOf(id);

  constructor() {
    this.board.access().subscribe({ next: (a) => this.access.set({ editable: a.editable, howToEdit: a.howToEdit }), error: () => undefined });
    effect(() => {
      const sc = this.scope();
      const project = this.state.project();
      if (sc == null) return;
      untracked(() => {
        this.unreadFrom.set({ scope: sc, lastSeen: this.state.lastSeen(sc) });
        this.hits.set(null);
        this.quote.set(null);
        this.stickToBottom = true;
        this.scrolledFor = null;
        this.api.settings(project, sc).subscribe({ next: (s) => this.settings.set(s), error: () => this.settings.set(DEFAULT_CHAT_SETTINGS) });
        this.loadWatches(project, sc);
      });
    });
    // What the chat sent the terminal: re-read with the chat (a cycle chat only - the project chat has no terminal).
    effect(() => {
      const sc = this.scope();
      this.thread();
      if (sc == null || sc === PROJECT_SCOPE) { untracked(() => this.terminalItems.set([])); return; }
      untracked(() => this.api.terminal(this.state.project(), sc).subscribe({ next: (t) => this.terminalItems.set(t), error: () => undefined }));
    });
    // Seen: the newest message, once the chat is open and loaded.
    effect(() => {
      const sc = this.scope();
      const last = this.messages().at(-1);
      if (sc != null && last) untracked(() => this.state.markSeen(sc, last.id));
    });
  }

  ngAfterViewChecked(): void {
    const el = this.stream()?.nativeElement;
    if (!el) return;
    const focus = this.state.focusId();
    if (focus != null && this.scrolledFor !== focus) {
      const target = el.querySelector(`[data-chat-id="${focus}"]`);
      if (target) {
        this.scrolledFor = focus;
        this.stickToBottom = false;
        // scroll the stream only: scrollIntoView also scrolled the window around it and pushed its header out of sight
        const t = (target as HTMLElement).getBoundingClientRect();
        const box = el.getBoundingClientRect();
        el.scrollTop += t.top - box.top - (el.clientHeight - Math.min(t.height, el.clientHeight)) / 2;
        return;
      }
    }
    // Follow new content only when it grew: forcing the bottom on every check fought the user's own scrolling (a smooth
    // wheel's first frame is still "at the bottom", and the next check snapped it back - it flickered and never went up).
    if (this.stickToBottom && el.scrollHeight !== this.lastHeight) el.scrollTop = el.scrollHeight;
    this.lastHeight = el.scrollHeight;
  }

  /** Reading up (wheel, keys) lets go of the bottom at once, before the scroll lands. */
  onReadUp(e: WheelEvent | KeyboardEvent): void {
    const up = e instanceof WheelEvent ? e.deltaY < 0 : ['ArrowUp', 'PageUp', 'Home'].includes(e.key);
    if (up) this.stickToBottom = false;
  }

  onScroll(): void {
    const el = this.stream()?.nativeElement;
    if (!el) return;
    const bottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    this.stickToBottom = bottom;
    if (bottom !== this.atBottom()) this.atBottom.set(bottom);
  }

  toBottom(): void {
    this.stickToBottom = true;
    this.lastHeight = 0;
    this.atBottom.set(true);
    const el = this.stream()?.nativeElement;
    if (el) el.scrollTop = el.scrollHeight;
  }

  repliesOf(id: number): readonly ChatMessage[] {
    return this.threads().replies.get(id) ?? [];
  }

  terminalOf(id: number): readonly TerminalItem[] {
    return this.terminalItems().filter((t) => t.messageId === id);
  }

  recordsOf(id: number): readonly ChatRecord[] {
    return this.messages().find((m) => m.id === id)?.records ?? [];
  }

  /** Cards Claude is answering in this project right now (FR-037) - a waiting message's place in line counts them. */
  readonly busyCards = computed(() => this.liveWork.all()
    .filter((w) => w.state === 'WORKING' && w.cardNumber > 0 && w.chatMessageId == null && w.project === this.state.project())
    .map((w) => w.cardNumber));

  /** The card open in the drawer of this chat's board, offered as a chip until the user leaves it out (FR-020). */
  readonly openCard = computed<MentionRef | null>(() => {
    const card = this.returns.openCard();
    if (!card || card.project !== this.state.project()) return null;
    return cardChip(card.project, card.number, card.title);
  });
  readonly droppedCard = signal<string | null>(null);
  readonly chips = computed<readonly MentionRef[]>(() => {
    const sc = this.scope();
    if (sc == null) return [];
    const own = this.state.chipsOf(sc);
    const card = this.openCard();
    return card && card.ref !== this.droppedCard() ? withChip(own, card) : own;
  });

  dropChip(c: MentionRef): void {
    const sc = this.scope();
    if (sc == null) return;
    if (c.type === 'card' && c.ref === this.openCard()?.ref) this.droppedCard.set(c.ref);
    this.state.removeChip(sc, c);
  }

  positionOf(id: number): number | null {
    return queuePosition(this.messages(), id, this.busyCards().length);
  }

  send(text: string): void {
    const sc = this.scope();
    if (sc == null || !text.trim()) return;
    const quote = this.quote();
    const context = this.chips();
    const skill = slashSkill(text);
    const bridge = this.isProject() ? this.askCycle() : null;
    const origin = bridge ? `bridge:${bridge}` : skill ? `skill:${skill.skill}` : null;
    this.state.send(sc, { text, quote, urgent: this.urgent(), ...(context.length ? { context } : {}), ...(origin ? { origin } : {}) }, () => {
      this.text = '';
      this.quote.set(null);
      this.state.clearChips(sc);
      this.droppedCard.set(this.openCard()?.ref ?? null);
      this.urgent.set(false);
      this.state.draftChanged();
      this.toBottom();
    });
  }

  undoTerminal(id: number): void {
    const sc = this.scope();
    this.state.run(this.api.undoTerminal(id), sc);
  }

  compact(): void {
    const sc = this.scope();
    if (sc != null) this.state.run(this.api.compact(this.state.project(), sc), sc);
  }

  refresh(): void {
    const sc = this.scope();
    if (sc != null) this.state.run(this.api.refresh(this.state.project(), sc), sc);
  }

  /** The "/" menu's skills (FR-022): run by the chat's Claude in its own session. */
  readonly skills = CHAT_SKILLS;
  /** FR-035: the cycle whose Claude a project-chat message asks (null: the project's). */
  readonly askCycle = signal<string | null>(null);
  readonly askOptions = computed<SelectOption[]>(() => [
    { value: '', label: "this project's Claude" },
    ...this.state.cycles().map((c) => ({ value: c.id, label: `the Claude of ${c.name}` })),
  ]);
  readonly muteOptions: SelectOption[] = [
    { value: 'all', label: 'every message' },
    { value: 'questions', label: 'only questions and failures' },
    { value: 'none', label: 'never (muted)' },
  ];
  readonly splitOpen = signal(false);
  readonly otherChats = computed(() => this.state.rows().filter((r) => r.scope !== this.scope()));
  readonly sharedOpen = signal(false);
  readonly shared = signal<readonly ChatSharedGroup[] | null>(null);
  private static readonly SHARED_LABELS: Record<string, string> = { call: '⇄ Calls', stmt: '◆ Statements', log: '▤ Log lines', redis: '⬢ Redis',
    card: '▣ Cards', spec: '☑ Spec items', code: '‹› Code', cycle: '◷ Cycles', spacer: '— Steps', rule: '⚡ Rules', chat: '💬 Messages' };

  sharedLabel(type: string): string {
    return ChatPanelComponent.SHARED_LABELS[type] ?? type;
  }

  toggleShared(): void {
    const sc = this.scope();
    this.sharedOpen.set(!this.sharedOpen());
    if (!this.sharedOpen() || sc == null) return;
    this.shared.set(null);
    this.api.shared(this.state.project(), sc).subscribe({ next: (r) => this.shared.set(r.groups), error: () => this.shared.set([]) });
  }

  goTo(messageId: number): void {
    const sc = this.scope();
    if (sc != null) this.state.openChat(sc, messageId);
  }

  /** "While you were away" (FR-023): once per opening, when the last look is at least the chat's digest gap old. */
  readonly digest = signal<{ lines: readonly string[]; text: string } | null>(null);
  readonly digestRead = signal(false);
  private readonly loadDigest = effect(() => {
    const sc = this.scope();
    const project = this.state.project();
    untracked(() => {
      const gap = this.settings().digestGapMin; // read, not followed: settings arriving later must not wipe the digest
      this.digest.set(null);
      this.digestRead.set(false);
      if (sc == null) return;
      const since = this.state.lookedAt(sc);
      this.state.markLooked(sc);
      if (since == null || Date.now() - since < gap * 60_000) return;
      this.api.digest(project, sc, since).subscribe({
        next: (d) => { if (d && d.lines.length && this.scope() === sc) this.digest.set({ lines: d.lines, text: d.lines.join('\n') }); },
        error: () => { /* no digest: the chat itself still shows */ },
      });
    });
  });

  /** A ⋯ menu entry: closes the menu, then does its thing. */
  menu(action: () => void): void {
    this.menuOpen.set(false);
    this.splitOpen.set(false);
    action();
  }

  toggleSearch(): void {
    this.searching.set(!this.searching());
    if (!this.searching()) this.hits.set(null);
  }

  toggleSettings(): void {
    this.settingsOpen.set(!this.settingsOpen());
  }

  search(): void {
    const sc = this.scope();
    if (sc == null) return;
    this.api.search(this.state.project(), sc, this.query(), this.filter()).subscribe({
      next: (r) => {
        this.hits.set(r.hits);
        // a match folded under a summary: its fold opens, so the match is there to see
        const folds = this.items().filter((it): it is Extract<Item, { kind: 'fold' }> => it.kind === 'fold');
        const open = new Set(this.openFolds());
        for (const h of r.hits.filter((x) => x.folded)) {
          const f = folds.find((x) => x.folded.some((m) => m.id === h.id));
          if (f) open.add(f.summary.id);
        }
        this.openFolds.set(open);
        if (r.hits.length) this.state.focusId.set(r.hits[0].id);
        this.scrolledFor = null;
      },
      error: () => this.hits.set([]),
    });
  }

  toggleFold(id: number): void {
    const next = new Set(this.openFolds());
    if (next.has(id)) next.delete(id); else next.add(id);
    this.openFolds.set(next);
  }

  setView(v: ChatView): void {
    this.viewsOpen.set(false);
    if (v === 'window') {
      const sc = this.scope();
      const url = `/chat?project=${encodeURIComponent(this.state.project())}&scope=${encodeURIComponent(sc ?? PROJECT_SCOPE)}`;
      window.open(url, `alfred-chat-${sc}`, 'width=560,height=820');
      this.state.close();
      return;
    }
    this.state.setView(v);
  }

  setAuto(n: number): void {
    const autoN = !n ? 0 : Math.max(20, Math.min(1000, Math.round(n)));
    this.putSettings({ ...this.settings(), autoN });
  }

  setDigest(n: number): void {
    this.putSettings({ ...this.settings(), digestGapMin: Math.max(5, Math.min(600, Math.round(n || 30))) });
  }

  setMute(m: ChatMute): void {
    const sc = this.scope();
    if (sc != null) this.state.setMute(sc, m);
  }

  readonly watches = signal<readonly ChatWatch[]>([]);
  /** A fired watch posts a line and is gone - the list is re-read when the chat changes, never on a timer. */
  private readonly rereadWatches = effect(() => {
    const n = this.thread()?.messages.length ?? 0;
    const sc = this.scope();
    untracked(() => { if (sc != null && n) this.loadWatches(this.state.project(), sc); });
  });

  private loadWatches(project: string, scope: string): void {
    this.api.watches(project, scope).subscribe({ next: (w) => this.watches.set(w), error: () => this.watches.set([]) });
  }

  cancelWatch(id: number): void {
    const sc = this.scope();
    this.state.run(this.api.cancelWatch(id), sc, () => { if (sc != null) this.loadWatches(this.state.project(), sc); });
  }

  /** ◉ "Watch while I test" (FR-030): the chat's own setting - Claude checks each batch of calls while it is on. */
  toggleWatching(): void {
    this.putSettings({ ...this.settings(), watching: !this.settings().watching });
  }

  setNotify(on: boolean): void {
    if (on) void this.desk.enable();
    this.state.setNotify(on);
  }

  private putSettings(s: ChatSettings): void {
    const sc = this.scope();
    if (sc == null) return;
    this.settings.set(s);
    this.state.run(this.api.putSettings(this.state.project(), sc, s), sc);
  }

  copy(text: string): void {
    void copyToClipboard(text);
  }

  short(id: string): string {
    return id.length > 13 ? `${id.slice(0, 8)}…` : id;
  }

  when(iso: string | null | undefined): string {
    if (!iso) return 'not yet';
    const d = new Date(iso);
    return d.toDateString() === new Date().toDateString() ? d.toTimeString().slice(0, 5) : d.toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  }

  startResize(e: MouseEvent): void {
    e.preventDefault();
    const startX = e.clientX;
    const start = this.state.prefs().width;
    // the handle is on the window's inner edge: towards the page widens it
    const sign = this.state.prefs().side === 'left' ? 1 : -1;
    const move = (ev: MouseEvent) => this.state.setWidth(start + sign * (ev.clientX - startX));
    const up = () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  }

  @HostListener('document:keydown', ['$event'])
  keys(e: KeyboardEvent): void {
    if (this.scope() == null || this.inWindow() || this.second()) return; // the main panel answers the keys once
    if (e.key === 'Escape' && this.menuOpen()) { this.menuOpen.set(false); return; }
    if (e.key === 'Escape' && this.state.view() === 'full') { this.state.setView('docked'); return; }
    if (e.ctrlKey && e.shiftKey && (e.key === 'F' || e.key === 'f')) {
      e.preventDefault();
      this.state.setView(this.state.view() === 'full' ? 'docked' : 'full');
    }
  }
}
