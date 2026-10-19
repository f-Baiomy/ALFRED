import { Component, DestroyRef, HostListener, computed, effect, inject, input, signal, untracked, viewChild } from '@angular/core';
import { VerifyGuardService } from '../../../core/services/verify-guard.service';
import { Title } from '@angular/platform-browser';
import {
  ALL_STATUSES, Actor, BoardFilters, NO_TEAM, BulkAction, defaultBoardId, CardKind, CardSummary, FLAGS, FLAG_LABELS, Flag, KINDS, OPEN_STATUSES, Resolution, STATUS_LABELS, Waiting,
} from '../../../core/models/board.models';
import { BoardNotifyService } from '../../../core/services/board-notify.service';
import { ConfirmDialogService } from '../../../core/services/confirm-dialog.service';
import { BoardSeenService } from '../../../core/services/board-seen.service';
import { NextStepsBarComponent } from '../next-steps-bar/next-steps-bar.component';
import { QuickAnswerComponent } from '../quick-answer/quick-answer.component';
import { WaitingAnchor, WaitingBarComponent } from '../waiting-bar/waiting-bar.component';
import { BoardApiService } from '../../../core/services/board-api.service';
import { BoardExportFormat, BoardExportService } from '../../../core/services/board-export.service';
import { BoardMentionsService } from '../../../core/services/board-mentions.service';
import { BoardStateService, messageOf } from '../../../core/state/board-state.service';
import { CardViewMode, CardViewModeService, CardWindowTarget } from '../../../core/services/card-view-mode.service';
import { TeamsStateService } from '../../../core/state/teams-state.service';
import { BoardDensityService } from '../../../core/services/board-density.service';
import { CardPeekComponent, PeekAnchor } from '../card-peek/card-peek.component';
import { LiveWorkStateService, currentStep } from '../../../core/state/live-work-state.service';
import { BundleOutboxService } from '../../../core/team/bundle-outbox.service';
import { RetestStateService } from '../../../core/state/retest-state.service';
import { RetestStripComponent } from '../retest-strip/retest-strip.component';
import { ActionMenuComponent } from '../../action-menu/action-menu.component';
import { CardAction } from '../board-card/board-card.component';
import { BoardColumnsComponent, CardDrop } from '../board-columns/board-columns.component';
import { BoardHelpComponent } from '../board-help/board-help.component';
import { BoardListViewComponent } from '../board-list-view/board-list-view.component';
import { BoardProgressComponent } from '../board-progress/board-progress.component';
import { BulkBarComponent } from '../bulk-bar/bulk-bar.component';
import { CardDrawerComponent, CardSiblings } from '../card-drawer/card-drawer.component';
import { LiveStripComponent } from '../live-strip/live-strip.component';
import { QuickAddComponent } from '../quick-add/quick-add.component';
import { TriageDecision, TriageDialogComponent, decisionOf } from '../triage-dialog/triage-dialog.component';
import { actionText, adviceAction } from '../../../shared/utils/triage-advice';
import { UndoToastComponent } from '../undo-toast/undo-toast.component';
import { QuestionsMenuComponent } from '../questions-menu/questions-menu.component';
import { QuestionsFormService } from '../../../core/services/questions-form.service';

/**
 * One board, wherever it is shown - the Board tab and a session cycle's Board tab use this same view (FR-039: two
 * views, one set of cards). Quick add, filters, Board / List, progress, the live strip, Inbox sorting, bulk actions,
 * the card drawer, export and the keyboard. Each instance has its own BoardStateService.
 */
import { BoardPagesComponent } from '../visuals/board-pages.component';
@Component({
  selector: 'app-board-view',
  standalone: true,
  providers: [BoardStateService, RetestStateService],
  imports: [ActionMenuComponent, CardPeekComponent, BoardPagesComponent, BoardColumnsComponent, BoardHelpComponent, BoardListViewComponent, BoardProgressComponent,
    BulkBarComponent, CardDrawerComponent, LiveStripComponent, NextStepsBarComponent, QuickAddComponent, QuickAnswerComponent, WaitingBarComponent, RetestStripComponent, TriageDialogComponent,
    UndoToastComponent, QuestionsMenuComponent],
  template: `
    @if (!windowMode()) {
    <app-live-strip [status]="state.agent()" [project]="project()" [cycleId]="cycleId()" [editable]="state.editable()" (action)="state.agentAction($event)" />
    <app-retest-strip [project]="project()" [editable]="state.editable()" />
    <div class="board-body" [hidden]="!showBody()">
    <div class="board-top">
      @if (state.editable()) {
        <app-quick-add #quick (added)="state.quickAdd($event)" />
      } @else {
        <span class="board-viewonly" [title]="state.access().howToEdit">👁 View only</span>
      }
      <div class="board-seg" role="group" aria-label="View">
        <button type="button" [class.on]="state.view() === 'board'" (click)="state.view.set('board')">▦ Board</button>
        <button type="button" [class.on]="state.view() === 'list'" (click)="state.view.set('list')">☰ List</button>
      </div>
      @if (state.view() === 'board') {
        <div class="board-seg board-density" role="group" aria-label="Card size">
          <button type="button" [class.on]="density.density() === 'compact'" title="Compact cards - hover a card for everything else"
                  (click)="density.set('compact')">▤ Compact</button>
          <button type="button" [class.on]="density.density() === 'comfortable'" title="Every detail on the card"
                  (click)="density.set('comfortable')">▦ Comfortable</button>
        </div>
      }
      <span class="board-top-gap"></span>
      <app-action-menu label="Export">
        <button type="button" class="filter-option-item" (click)="export('md')">Board → Markdown (.md)</button>
        <button type="button" class="filter-option-item" (click)="export('html')">Board → HTML (.html)</button>
        <button type="button" class="filter-option-item" (click)="export('json')">Board → JSON (re-importable)</button>
        <button type="button" class="filter-option-item" [disabled]="!state.selected().size" (click)="export('md', true)">Selected cards → .md</button>
        <button type="button" class="filter-option-item" [disabled]="!state.selected().size" (click)="export('json', true)">Selected cards → .json</button>
        @if (state.editable()) {
          <label class="filter-option-item">Import .json…<input type="file" accept=".json,application/json" hidden (change)="importFile($any($event.target))" /></label>
        }
      </app-action-menu>
      @if (project() && !cycleId()) {
        <button type="button" class="action-btn" [class.on]="showPages()" title="◈ The project's pages: dashboards and diagrams for the whole project"
                (click)="showPages.set(!showPages())">◈ Pages</button>
      }
      @if (notify.supported) {
        <button type="button" class="action-btn" [title]="notify.enabled() ? 'Desktop notifications are on - click to turn them off'
                : 'A desktop notification when Claude asks a question or proposes something (while an Alfred tab is open)'"
                (click)="toggleNotify()">{{ notify.enabled() ? '🔔' : '🔕' }}</button>
      }
      <button type="button" class="action-btn" title="Keyboard shortcuts (?)" (click)="help.set(true)">?</button>
    </div>
    <div class="board-filters">
      <input #search class="board-search" type="search" placeholder="Search cards…" [value]="state.filters().q"
             (keydown.enter)="setSearch(search.value)" (search)="setSearch(search.value)" />
      <button type="button" class="board-pill board-pill-wait" [class.on]="state.filters().waiting === 'USER'" (click)="toggleWaiting('USER')">Waiting on me</button>
      <app-action-menu class="board-fmenu" label="Type" [badge]="state.filters().kinds.length" [closeOnClick]="false" [panelWidth]="190">
        @for (k of kinds; track k) {
          <label class="filter-option-item board-fmenu-item"><input type="checkbox" [checked]="state.filters().kinds.includes(k)" (change)="toggleKind(k)" />{{ kindLabel(k) }}</label>
        }
      </app-action-menu>
      <app-action-menu class="board-fmenu" label="Flags" [badge]="state.filters().flags.length" [closeOnClick]="false" [panelWidth]="210">
        @for (f of flags; track f) {
          <label class="filter-option-item board-fmenu-item"><input type="checkbox" [checked]="state.filters().flags.includes(f)" (change)="toggleFlag(f)" />{{ flagLabels[f] }}</label>
        }
      </app-action-menu>
      <app-action-menu class="board-fmenu" label="Waiting" [badge]="state.filters().waiting ? 1 : 0" [closeOnClick]="false" [panelWidth]="210">
        <label class="filter-option-item board-fmenu-item"><input type="checkbox" [checked]="state.filters().waiting === 'USER'" (change)="toggleWaiting('USER')" />Waiting on me</label>
        <label class="filter-option-item board-fmenu-item"><input type="checkbox" [checked]="state.filters().waiting === 'CLAUDE'" (change)="toggleWaiting('CLAUDE')" />Waiting on Claude</label>
        <label class="filter-option-item board-fmenu-item"><input type="checkbox" [checked]="state.filters().waiting === 'RETEST'" (change)="toggleWaiting('RETEST')" />Needs re-test</label>
      </app-action-menu>
      @if (teamsState.teams().length) {
        <app-action-menu class="board-fmenu" label="Team" [badge]="(state.filters().teams ?? []).length" [closeOnClick]="false" [panelWidth]="220">
          @for (t of teamsState.teams(); track t.id) {
            <label class="filter-option-item board-fmenu-item" [title]="'Cards assigned to ' + t.name">
              <input type="checkbox" [checked]="(state.filters().teams ?? []).includes(t.id)" (change)="toggleTeam(t.id)" />
              <span class="board-fmenu-dot" [style.background]="t.color"></span>{{ t.icon ? t.icon + ' ' : '' }}{{ t.name }}</label>
          }
          <label class="filter-option-item board-fmenu-item" title="Cards with no team yet">
            <input type="checkbox" [checked]="(state.filters().teams ?? []).includes(noTeam)" (change)="toggleTeam(noTeam)" />No team</label>
        </app-action-menu>
      }
      <app-action-menu class="board-fmenu" label="More" [badge]="moreCount()" [closeOnClick]="false" [panelWidth]="250">
        <label class="filter-option-item board-fmenu-item"><input type="checkbox" [checked]="state.filters().author === 'CLAUDE'" (change)="toggleAuthor('CLAUDE')" />✦ Made by Claude</label>
        <label class="filter-option-item board-fmenu-item"><input type="checkbox" [checked]="state.filters().scopeNotDecided" (change)="toggleScope()" />Scope not decided</label>
        @if (cycleId()) {
          <label class="filter-option-item board-fmenu-item" title="Own only hides cards that live on another board and show here through a shared cycle or a related board">
            <input type="checkbox" [checked]="!!state.filters().ownOnly" (change)="setFilters({ ownOnly: !state.filters().ownOnly })" />Own only (hide related)</label>
        } @else {
          <label class="filter-option-item board-fmenu-item" title="Cards whose session cycle was deleted - clean them up">
            <input type="checkbox" [checked]="!!state.filters().cycleDeleted" (change)="toggleCycleDeleted()" />◷ Cycle deleted</label>
        }
      </app-action-menu>
    </div>
    @if (activeFilters().length) {
      <div class="board-fchips">
        @for (f of activeFilters(); track f.key) {
          <span class="board-fchip">{{ f.label }}<button type="button" [attr.aria-label]="'Remove ' + f.label" (click)="f.clear()">✕</button></span>
        }
        <button type="button" class="board-link board-fchips-clear" (click)="clearFilters(search)">Clear all</button>
      </div>
    }
    <div class="board-summary">
      @if (state.page(); as page) {
        <app-board-progress [label]="progressLabel()" [open]="page.counts.open" [fixed]="page.counts.fixed" [done]="page.counts.done" />
      }
      @if (questionCards().length) {
        <app-questions-menu [boardId]="boardIdNow()" [project]="project()" [total]="questionTotal()" [cards]="questionCards().length" [editable]="state.editable()"
                            (answer)="answering.set(questionCards()[0].id)" (showCards)="setFilters({ flags: ['NEEDS_DECISION'] })"
                            (formAll)="questionsForm(questionCards())" />
      }
    </div>
    @if (showNextSteps()) {
      <app-next-steps-bar [project]="project()" [cycleId]="cycleId()" [cycleName]="cycleName()" [version]="state.page()" (opened)="openNumber($event)" />
    }
    @if (showPages() && project() && !cycleId()) {
      <app-board-pages class="board-project-pages" [owner]="'project:' + project()" [canEdit]="state.editable()" [context]="{ project: project() }" />
    }
    @if (state.error()) { <div class="board-error" role="alert">{{ state.error() }} <button type="button" class="board-link" (click)="state.error.set(null)">✕</button></div> }
    @if (message()) { <div class="board-note">{{ message() }} <button type="button" class="board-link" (click)="message.set(null)">✕</button></div> }

    @if (state.view() === 'board') {
      <app-board-columns [cards]="state.cards()" [editable]="state.editable()" [selected]="state.selected()" [focusedId]="state.focusedId()"
                         [showCycle]="!cycleId()" [now]="now()" [retests]="retest.byNumber()" [viewBoard]="cycleId()" [boardNames]="boardNames()" (retest)="retest.start($event)"
                         (moved)="onMoved($event)" (opened)="openCard($event)" (toggled)="state.toggleSelected($event.id)"
                         (action)="onAction($event.card, $event.action)" (triage)="startTriage()" (acceptHigh)="acceptHigh($event)"
                         (answer)="answering.set($event.id)" (waiting)="waitingBar.set({ id: $event.card.id, anchor: $event.anchor })"
                         [compact]="density.density() === 'compact'" (hovered)="onHover($event.card, $event.el)" />
      @if (peekCard(); as pk) {
        <app-card-peek [card]="pk.card" [anchor]="pk.anchor" [editable]="state.editable()" [now]="now()" [retest]="retest.byNumber().get(pk.card.number) ?? null"
                       [boardName]="pk.card.cycleId ? (boardNames().get(pk.card.cycleId) ?? '') : ''" [liveStep]="peekLive()" [toAzure]="peekAzure()"
                       (entered)="keepPeek()" (left)="hidePeek()" (open)="closePeek(); openCard(pk.card)" (answer)="closePeek(); answering.set(pk.card.id)"
                       (action)="closePeek(); $event.kind === 'retest' ? retest.start([pk.card.number]) : onAction(pk.card, $event)" />
      }
    } @else {
      <app-board-list-view [cards]="sortedForList()" [editable]="state.editable()" [selected]="state.selected()" [focusedId]="state.focusedId()"
                           [now]="now()" [boardNames]="boardNames()" (opened)="openCard($event)" (toggled)="state.toggleSelected($event.id)" />
    }

    <app-bulk-bar [count]="state.selected().size" [total]="state.cards().length" [questions]="selectedQuestions()" (action)="bulk($event)" (cleared)="state.clearSelection()"
                  (selectAll)="selectAll()" (questionsForm)="questionsForm(selectedCards())" />
    <app-undo-toast [pending]="state.pendingUndo()" (undo)="state.undo()" (reason)="state.addReason($event)" (dismissed)="state.pendingUndo.set(null)" />
    @if (triageQueue(); as queue) {
      <app-triage-dialog [queue]="queue" (decided)="onTriage($event)" (closed)="triageQueue.set(null)" />
    }
    @if (help()) { <app-board-help (closed)="help.set(false)" /> }
    @if (answering(); as id) { <app-quick-answer [cardId]="id" (closed)="answering.set(null)" /> }
    @if (waitingCard(); as wb) {
      <app-waiting-bar [card]="wb.card" [anchor]="wb.anchor" [editable]="state.editable()" (closed)="waitingBar.set(null)"
                       (action)="onAction(wb.card, $event)" (openCard)="waitingBar.set(null); openCard(wb.card)"
                       (allQuestions)="waitingBar.set(null); answering.set(wb.card.id)" />
    }
    </div>
    }
    @if (state.openCardId(); as id) {
      <app-card-drawer [cardId]="id" [version]="state.openCardVersion()" [editable]="state.editable()" [inCycle]="!!cycleId()" [layout]="layout()"
                       [siblings]="openSiblings()" (step)="stepCard($event)" (modeChange)="changeMode(id, $event)" (closed)="closeCard()" (retestRequested)="retest.start([$event])" (closeRequested)="state.close($event, $event.resolution)" />
    }`,
})
export class BoardViewComponent {
  readonly state = inject(BoardStateService);
  readonly retest = inject(RetestStateService);
  private readonly confirm = inject(ConfirmDialogService);
  private readonly api = inject(BoardApiService);
  private readonly exports = inject(BoardExportService);
  private readonly mentions = inject(BoardMentionsService);

  readonly project = input('');
  /** ◈ The project's pages (specs/017 R29), shown above the board on request. */
  readonly showPages = signal(false);
  readonly cycleId = input<string | null>(null);
  readonly cycleName = input<string | null>(null);
  /** Opens with the "cycle deleted" filter on (Settings -> Storage -> show). */
  readonly onlyCycleDeleted = input(false);
  /** A card window (↗ Window): only the opened card is shown, the whole window. */
  readonly windowMode = input(false);
  /** The board page's other tabs (specs/029) hide the cards; the live strips above them stay. */
  readonly showBody = input(true);
  /** The next-steps bar: on the project's default board and All cards; a task board's Next card owns guidance (specs/032 D1). */
  readonly showNextSteps = input(true);
  private readonly cardMode = inject(CardViewModeService);
  readonly teamsState = inject(TeamsStateService);
  readonly density = inject(BoardDensityService);
  private readonly liveWork = inject(LiveWorkStateService);
  private readonly outbox = inject(BundleOutboxService);
  /** The card the pointer rests on, read whole beside it (the hover peek). */
  private readonly peek = signal<{ id: string; anchor: PeekAnchor } | null>(null);
  readonly peekCard = computed(() => {
    const p = this.peek();
    const card = p ? this.state.cards().find((c) => c.id === p.id) : undefined;
    return p && card ? { card, anchor: p.anchor } : null;
  });
  readonly peekLive = computed(() => {
    const c = this.peekCard()?.card;
    const w = c ? this.liveWork.working().find((x) => x.project === c.project && x.cardNumber === c.number) : undefined;
    return w ? currentStep(w) : null;
  });
  readonly peekAzure = computed(() => {
    const c = this.peekCard()?.card;
    return c ? (this.outbox.byCard().get(c.id) ?? []).reduce((n, b) => n + b.steps.filter((x) => x.ticked).length, 0) : 0;
  });
  private peekTimer: ReturnType<typeof setTimeout> | undefined;

  /** The pointer on a card: its peek after a short rest (350 ms), and the keys act on it. Off it: the peek goes unless the pointer moved into it. */
  onHover(card: CardSummary, el: HTMLElement | null): void {
    clearTimeout(this.peekTimer);
    if (!el) {
      this.peekTimer = setTimeout(() => this.peek.set(null), 220);
      return;
    }
    this.peekTimer = setTimeout(() => {
      if (!el.isConnected || this.state.openCardId() || document.querySelector('.cdk-drag-preview')) return;
      const r = el.getBoundingClientRect();
      this.state.focusedId.set(card.id);
      this.peek.set({ id: card.id, anchor: { top: r.top, bottom: r.bottom, left: r.left, right: r.right } });
    }, this.peek() ? 120 : 350);
  }

  keepPeek(): void {
    clearTimeout(this.peekTimer);
  }

  hidePeek(): void {
    clearTimeout(this.peekTimer);
    this.peekTimer = setTimeout(() => this.peek.set(null), 220);
  }

  closePeek(): void {
    clearTimeout(this.peekTimer);
    this.peek.set(null);
  }

  /** A scroll anywhere but in the peek moves the cards under it (it stays put): it goes; so does a resize. */
  private readonly peekScroll = (e: Event): void => {
    if (!this.peek()) return;
    const t = e.target as Element | null;
    if (t && typeof t.closest === 'function' && t.closest('app-card-peek')) return;
    this.closePeek();
  };
  readonly noTeam = NO_TEAM;
  /** The More menu's filters that are on. */
  readonly moreCount = computed(() => {
    const f = this.state.filters();
    return (f.author === 'CLAUDE' ? 1 : 0) + (f.scopeNotDecided ? 1 : 0) + (this.cycleId() ? (f.ownOnly ? 1 : 0) : (f.cycleDeleted ? 1 : 0));
  });
  /** Every filter that is on, as a chip under the menus - nothing filters the board unseen. */
  readonly activeFilters = computed(() => {
    const f = this.state.filters();
    const out: { key: string; label: string; clear: () => void }[] = [];
    for (const k of f.kinds) out.push({ key: 'k' + k, label: this.kindLabel(k), clear: () => this.toggleKind(k) });
    for (const x of f.flags) out.push({ key: 'f' + x, label: FLAG_LABELS[x], clear: () => this.toggleFlag(x) });
    if (f.waiting) {
      const w = f.waiting;
      out.push({ key: 'w', label: w === 'USER' ? 'Waiting on me' : w === 'CLAUDE' ? 'Waiting on Claude' : 'Needs re-test', clear: () => this.toggleWaiting(w) });
    }
    for (const id of f.teams ?? []) {
      const t = this.teamsState.teams().find((x) => x.id === id);
      out.push({ key: 't' + id, label: id === NO_TEAM ? 'No team' : 'Team: ' + (t?.name ?? id), clear: () => this.toggleTeam(id) });
    }
    if (f.author === 'CLAUDE') out.push({ key: 'a', label: '✦ Made by Claude', clear: () => this.toggleAuthor('CLAUDE') });
    if (f.scopeNotDecided) out.push({ key: 's', label: 'Scope not decided', clear: () => this.toggleScope() });
    if (this.cycleId() && f.ownOnly) out.push({ key: 'o', label: 'Own only', clear: () => this.setFilters({ ownOnly: false }) });
    if (!this.cycleId() && f.cycleDeleted) out.push({ key: 'c', label: '◷ Cycle deleted', clear: () => this.toggleCycleDeleted() });
    if (f.q) out.push({ key: 'q', label: '“' + f.q + '”', clear: () => this.setSearch('') });
    return out;
  });

  kindLabel(k: CardKind): string {
    return k.charAt(0) + k.slice(1).toLowerCase();
  }

  clearFilters(search: HTMLInputElement): void {
    search.value = '';
    this.setFilters({ kinds: [], flags: [], author: null, scopeNotDecided: false, q: '', waiting: null, cycleDeleted: false, teams: [],
      ownOnly: this.cycleId() ? false : this.state.filters().ownOnly });
  }
  /** How the open card is shown here - a card window is always 'window'; a board tab shows Side or Full. */
  readonly layout = computed<CardViewMode>(() => (this.windowMode() ? 'window' : this.cardMode.mode() === 'full' ? 'full' : 'side'));

  readonly kinds = KINDS;
  readonly flags = FLAGS;
  readonly flagLabels = FLAG_LABELS;
  readonly help = signal(false);
  readonly message = signal<string | null>(null);
  readonly triageQueue = signal<readonly CardSummary[] | null>(null);
  /** The card whose questions are being answered from the board (specs/015 FR-5). */
  readonly answering = signal<string | null>(null);
  /** The waiting bar open under a tile's pill: the card by id, so it follows the board's live copy. */
  readonly waitingBar = signal<{ id: string; anchor: WaitingAnchor } | null>(null);
  readonly waitingCard = computed(() => {
    const w = this.waitingBar();
    const card = w ? this.state.cards().find((c) => c.id === w.id) : undefined;
    return w && card ? { card, anchor: w.anchor } : null;
  });
  private readonly verifyGuard = inject(VerifyGuardService);
  /** Cards shown with Claude's questions open (specs/019), the oldest change first. */
  readonly questionCards = computed(() => this.state.cards().filter((c) => (c.openQuestions ?? 0) > 0)
    .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt)));
  readonly questionTotal = computed(() => this.questionCards().reduce((n, c) => n + (c.openQuestions ?? 0), 0));
  private readonly forms = inject(QuestionsFormService);
  /** The board this view shows: its own, or the project's default board (specs/027). */
  readonly boardIdNow = computed(() => this.cycleId() || defaultBoardId(this.project()));
  readonly selectedCards = computed(() => { const ids = this.state.selected(); return this.state.cards().filter((c) => ids.has(c.id)); });
  /** Open questions on the selected cards - the bulk bar's questions form counts them, not the cards. */
  readonly selectedQuestions = computed(() => this.selectedCards().reduce((n, c) => n + (c.openQuestions ?? 0), 0));

  /** One questions form per board the cards live on (specs/037 D2); cards without open questions are named by Alfred. */
  async questionsForm(cards: readonly { number: number; boardId?: string; openQuestions?: number }[]): Promise<void> {
    const byBoard = new Map<string, number[]>();
    for (const c of cards) {
      const b = c.boardId || this.boardIdNow();
      byBoard.set(b, [...(byBoard.get(b) ?? []), c.number]);
    }
    for (const [board, numbers] of byBoard) await this.forms.download(board, numbers);
  }
  readonly notify = inject(BoardNotifyService);
  private readonly seen = inject(BoardSeenService);
  /** Cards Claude changed since they were last opened here - counted in the tab title (specs/015 FR-9). */
  readonly unread = computed(() => this.state.cards().filter((c) => this.seen.isUnread(c)).length);
  /** "Now" for ages and the stale marker - refreshed whenever the cards are, so it needs no clock of its own. */
  readonly now = computed(() => (this.state.page(), Date.now()));
  private readonly quick = viewChild<QuickAddComponent>('quick');
  /** Board names by id, for the "home: <board>" of a card seen through a relation (specs/027 US2). */
  readonly boardNames = signal<ReadonlyMap<string, string>>(new Map());

  readonly progressLabel = computed(() => (this.cycleId() ? this.cycleName() ?? this.cycleId()! : this.project() || 'No project'));
  readonly sortedForList = computed(() => [...this.state.cards()].sort((a, b) =>
    ALL_STATUSES.indexOf(a.status) - ALL_STATUSES.indexOf(b.status) || b.updatedAt.localeCompare(a.updatedAt)));
  /** The open card's neighbours in its column, in the list's order (the drawer's ‹ › and [ ]). */
  readonly openSiblings = computed<CardSiblings | null>(() => {
    const id = this.state.openCardId();
    const me = id ? this.state.cards().find((c) => c.id === id) : undefined;
    if (!me) return null;
    const column = this.sortedForList().filter((c) => c.status === me.status);
    const at = column.findIndex((c) => c.id === me.id);
    return { prev: column[at - 1]?.id ?? null, next: column[at + 1]?.id ?? null, index: at, total: column.length, column: STATUS_LABELS[me.status] };
  });

  stepCard(id: string): void {
    this.state.focusedId.set(id);
    this.state.open(id);
  }

  /** Cards in the order J/K walks them: the board's columns left to right, or the list's rows. */
  private readonly walkOrder = computed(() => this.sortedForList());

  constructor() {
    const title = inject(Title);
    const base = title.getTitle().replace(/^\(\d+\)\s*/, '');
    effect(() => {
      const n = this.unread();
      untracked(() => title.setTitle(n ? `(${n}) ${base}` : base));
    });
    inject(DestroyRef).onDestroy(() => title.setTitle(base));
    window.addEventListener('scroll', this.peekScroll, true);
    window.addEventListener('resize', this.peekScroll);
    inject(DestroyRef).onDestroy(() => {
      window.removeEventListener('scroll', this.peekScroll, true);
      window.removeEventListener('resize', this.peekScroll);
      clearTimeout(this.peekTimer);
    });
    // a card opened (drawer, window) or the cards view left: no peek over it
    effect(() => {
      if (this.state.openCardId() || this.state.view() !== 'board' || !this.showBody()) untracked(() => this.closePeek());
    });
    effect(() => {
      const project = this.project();
      const cycleId = this.cycleId();
      untracked(() => {
        this.state.show(project, cycleId);
        this.retest.show(project);
        // a board names its cards' other boards; All cards names each card's own (its chip)
        this.api.boards(null).subscribe({
          next: (all) => this.boardNames.set(new Map(all.map((b) => [b.board.id, b.board.name]))),
          error: () => undefined,
        });
      });
    });
    effect(() => {
      if (this.onlyCycleDeleted()) untracked(() => this.setFilters({ cycleDeleted: true }));
    });
    this.teamsState.load();
    // ↗ Window is the remembered choice: a card opened in a board tab goes to the card window instead.
    effect(() => {
      const id = this.state.openCardId();
      if (!id || this.windowMode() || this.cardMode.mode() !== 'window') return;
      untracked(() => this.popOut(id));
    });
    // A card window handing its card back (Side / Full picked there).
    const stopListening = this.cardMode.listen((target) => {
      if (this.windowMode()) return false;
      this.mentions.cardToOpen.set({ project: target.project, number: target.number });
      return true;
    });
    inject(DestroyRef).onDestroy(stopListening);
    effect(() => {
      const target = this.mentions.cardToOpen();
      if (!target) return;
      untracked(() => {
        const here = this.state.cards().find((c) => c.number === target.number && c.project === target.project);
        if (here) {
          this.state.open(here.id);
          this.mentions.cardToOpen.set(null);
          return;
        }
        if (target.project !== this.project() && !this.cycleId()) return; // another board's card
        this.api.cardByNumber(target.project, target.number).subscribe({
          next: (c) => {
            this.state.open(c.id);
            this.mentions.cardToOpen.set(null);
          },
          error: () => this.message.set(`Card #${target.number} no longer exists`),
        });
      });
    });
  }

  /** The header switch: Side / Full here, or the card moves to (or back from) its own window. */
  changeMode(id: string, mode: CardViewMode): void {
    if (!this.windowMode()) {
      this.cardMode.set(mode); // 'window' pops the card out through the effect above
      return;
    }
    void this.windowTarget(id).then(async (target) => {
      if (!target) return;
      if (await this.cardMode.dock(target, mode)) {
        this.leaveWindow();
        return;
      }
      // No board tab answered: this window becomes the board.
      this.cardMode.set(mode);
      window.location.href = this.cardMode.windowUrl(target).replace('&window=1', '');
    });
  }

  closeCard(): void {
    this.state.open(null);
    if (this.windowMode()) this.leaveWindow();
  }

  /** Closes a card window. A browser only lets a script close a window a script opened - one typed or bookmarked
   * stays open, so it turns into the board instead of an empty page. */
  private leaveWindow(): void {
    window.close();
    setTimeout(() => {
      const url = new URL(window.location.href);
      url.searchParams.delete('window');
      url.searchParams.delete('card');
      window.location.href = url.toString();
    }, 300);
  }

  private popOut(id: string): void {
    void this.windowTarget(id).then((target) => {
      if (target) this.cardMode.popOut(target);
    });
    this.state.open(null);
  }

  /** What a card window needs to open the card: its project, cycle and number. */
  private windowTarget(id: string): Promise<CardWindowTarget | null> {
    const here = this.state.cards().find((c) => c.id === id);
    if (here) return Promise.resolve({ project: here.project, cycleId: here.cycleId ?? null, number: here.number });
    return new Promise((resolve) => this.api.card(id).subscribe({
      next: (c) => resolve({ project: c.project, cycleId: c.cycleId ?? null, number: c.number }),
      error: () => resolve(null),
    }));
  }

  openCard(card: CardSummary): void {
    this.state.focusedId.set(card.id);
    this.state.open(card.id);
  }

  onMoved(drop: CardDrop): void {
    if (drop.to === 'VERIFIED') void this.verifyGuard.verify(drop.card, () => this.state.move(drop.card.id, drop.to));
    else this.state.move(drop.card.id, drop.to);
  }

  onAction(card: CardSummary, action: CardAction): void {
    if (action.kind === 'close') this.state.close(card, action.resolution);
    else if (action.kind === 'move' && action.status === 'VERIFIED') void this.verifyGuard.verify(card, () => this.state.move(card.id, 'VERIFIED'));
    else if (action.kind === 'move') this.state.move(card.id, action.status);
    else if (action.kind === 'retest') this.retest.start([card.number]);
    else if (action.kind === 'merge') this.state.merge(card.id, action.into);
    else if (action.kind === 'mergeGroup') this.state.mergeGroup(action.group, card.number);
    else this.state.reopen(card.id);
  }

  /** "Accept all High": every High-confidence advice in the Inbox, after one confirm that lists them. */
  async acceptHigh(cards: readonly CardSummary[]): Promise<void> {
    const lines = cards.map((c) => `#${c.number} ${c.title} → ${actionText(adviceAction(c)!)}`);
    const shown = lines.slice(0, 12).join('\n') + (lines.length > 12 ? `\n+${lines.length - 12} more` : '');
    const ok = await this.confirm.confirm(`Take Claude's High-confidence advice on ${cards.length} ${cards.length === 1 ? 'card' : 'cards'}?\n\n${shown}`,
      `Accept ${cards.length}`);
    if (!ok) return;
    for (const c of cards) this.onTriage(decisionOf(c, adviceAction(c)!));
  }

  startTriage(): void {
    this.triageQueue.set(this.state.cards().filter((c) => c.status === 'INBOX'));
  }

  onTriage(d: TriageDecision): void {
    if (d.kind === 'todo') this.state.move(d.card.id, 'TO_DO');
    else if (d.kind === 'merge') this.state.merge(d.card.id, d.into, d.reason || undefined);
    else if (d.kind === 'mergeGroup') this.state.mergeGroup(d.group, d.card.number);
    else this.state.run(this.api.close(d.card.id, d.resolution, d.reason || undefined));
  }

  async bulk(action: BulkAction): Promise<void> {
    if (action === 'DELETE') {
      const picked = this.state.cards().filter((c) => this.state.selected().has(c.id));
      const n = picked.length;
      const names = picked.slice(0, 8).map((c) => `#${c.number}`).join(', ') + (n > 8 ? ` +${n - 8} more` : '');
      const ok = await this.confirm.confirm(`Delete ${n} ${n === 1 ? 'card' : 'cards'} (${names}) with their history? This cannot be undone.`,
        `Delete ${n}`);
      if (!ok) return;
    }
    this.state.bulk(action);
  }

  selectAll(): void {
    for (const c of this.state.cards()) {
      if (!this.state.selected().has(c.id)) this.state.toggleSelected(c.id);
    }
  }

  toggleCycleDeleted(): void {
    this.setFilters({ cycleDeleted: !this.state.filters().cycleDeleted });
  }

  setFilters(change: Partial<BoardFilters>): void {
    this.state.setFilters({ ...this.state.filters(), ...change });
  }

  toggleKind(k: CardKind): void {
    const kinds = this.state.filters().kinds;
    this.setFilters({ kinds: kinds.includes(k) ? kinds.filter((x) => x !== k) : [...kinds, k] });
  }

  toggleTeam(id: string): void {
    const teams = this.state.filters().teams ?? [];
    this.setFilters({ teams: teams.includes(id) ? teams.filter((x) => x !== id) : [...teams, id] });
  }

  toggleFlag(f: Flag): void {
    const flags = this.state.filters().flags;
    this.setFilters({ flags: flags.includes(f) ? flags.filter((x) => x !== f) : [...flags, f] });
  }

  toggleAuthor(a: Actor): void {
    this.setFilters({ author: this.state.filters().author === a ? null : a });
  }

  toggleWaiting(w: Waiting): void {
    this.setFilters({ waiting: this.state.filters().waiting === w ? null : w });
  }

  toggleNotify(): void {
    if (this.notify.enabled()) this.notify.disable();
    else void this.notify.enable().then((on) => this.message.set(on ? null : 'The browser did not allow notifications - allow them for this site, then try again.'));
  }

  /** A card number from the next-step bar. */
  openNumber(number: number): void {
    const here = this.state.cards().find((c) => c.number === number);
    if (here) {
      this.openCard(here);
      return;
    }
    this.api.cardByNumber(this.project(), number).subscribe({ next: (c) => this.state.open(c.id), error: () => this.message.set(`Card #${number} is not on this board`) });
  }

  toggleScope(): void {
    this.setFilters({ scopeNotDecided: !this.state.filters().scopeNotDecided });
  }

  setSearch(q: string): void {
    this.setFilters({ q });
  }

  export(format: BoardExportFormat, selectedOnly = false): void {
    const title = this.cycleId() ? `Board - ${this.cycleName() ?? this.cycleId()}` : `Board - ${this.project() || 'No project'}`;
    this.message.set('Gathering the board for export…');
    this.exports.download(format, this.project(), this.cycleId(), title, selectedOnly ? [...this.state.selected()] : null)
      .then(() => this.message.set(null), (e) => this.message.set(messageOf(e)));
  }

  importFile(input: HTMLInputElement): void {
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    this.api.importBoard(this.project(), file).subscribe({
      next: (r) => this.message.set(`Imported ${r.cards} cards${r.renumbered.length
        ? ` - renumbered ${r.renumbered.map((x) => `#${x.from} → #${x.to}`).join(', ')}` : ''}`),
      error: (e) => this.state.error.set(messageOf(e)),
    });
  }

  // ---------------------------------------------------------------------------------------------------------- keys

  @HostListener('document:keydown', ['$event'])
  onKey(event: KeyboardEvent): void {
    const target = event.target as HTMLElement | null;
    if (target && (/^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName) || target.isContentEditable)) return;
    if (this.triageQueue() || event.ctrlKey || event.metaKey || event.altKey) return;
    // the questions dialog has its own keys (1-4, ← →)
    if (event.key !== 'Escape' && document.querySelector('.board-quick-answer')) return;
    if (this.windowMode()) {
      if (event.key === 'Escape' && !document.querySelector('.dialog-backdrop')) this.closeCard();
      return;
    }
    if (event.key === 'F' && event.shiftKey && this.state.openCardId()) {
      this.cardMode.set(this.layout() === 'full' ? 'side' : 'full');
      return;
    }
    if (this.peek() && !['Shift', 'Control', 'Alt', 'Meta'].includes(event.key)) {
      // the peek closes on any key; Escape only closes it, the others still act on the card it showed (it has the focus)
      this.closePeek();
      if (event.key === 'Escape') return;
    }
    if (event.key === 'Escape') {
      // A dialog over the board (the call popup, a spec) closes itself first; the card stays open.
      if (document.querySelector('.dialog-backdrop')) return;
      if (this.help()) this.help.set(false);
      else if (this.state.openCardId()) this.state.open(null);
      else this.state.clearSelection();
      return;
    }
    if (document.querySelector('.dialog-backdrop')) return;
    // an open card has its own ? (its keys), / (its comment box) and [ ] (the next card) - specs/023
    if (this.state.openCardId() && ['?', '/', '[', ']'].includes(event.key)) return;
    const key = event.key.toLowerCase();
    if (key === '?') {
      this.help.set(true);
    } else if (key === '/') {
      event.preventDefault();
      this.quick()?.focus();
    } else if (key === 'l') {
      this.state.view.update((v) => (v === 'board' ? 'list' : 'board'));
    } else if (key === 'j' || key === 'k') {
      event.preventDefault();
      this.walk(key === 'j' ? 1 : -1);
    } else {
      this.onCardKey(key, event);
    }
  }

  private walk(step: number): void {
    const cards = this.walkOrder();
    if (!cards.length) return;
    const at = cards.findIndex((c) => c.id === this.state.focusedId());
    const next = cards[Math.max(0, Math.min(cards.length - 1, at < 0 ? 0 : at + step))];
    this.state.focusedId.set(next.id);
    document.querySelector(`[data-card="${next.id}"]`)?.scrollIntoView({ block: 'nearest' });
  }

  private onCardKey(key: string, event: KeyboardEvent): void {
    const card = this.state.cards().find((c) => c.id === this.state.focusedId());
    if (!card) return;
    if (key === 'enter') {
      this.state.open(card.id);
      return;
    }
    if (!this.state.editable()) return;
    const inbox = card.status === 'INBOX';
    const sorts: Record<string, Resolution> = { f: 'FINE', n: 'NOT_IN_FLOW' };
    if (inbox && sorts[key]) this.state.close(card, sorts[key]);
    else if (inbox && key === 't') this.state.move(card.id, 'TO_DO');
    else if (key === 'a' && (card.openQuestions ?? (card.waiting?.who === 'USER' && card.flags.includes('NEEDS_DECISION') ? 1 : 0)) > 0) this.answering.set(card.id);
    else if (key === 'x') this.state.toggleSelected(card.id);
    else if (key === 'u') {
      const flags = card.flags.includes('URGENT') ? card.flags.filter((f) => f !== 'URGENT') : [...card.flags, 'URGENT' as Flag];
      this.state.run(this.api.update(card.id, { flags }));
    } else if (/^[1-6]$/.test(key) && card.status !== 'CLOSED') {
      const to = OPEN_STATUSES[Number(key) - 1];
      if (to !== card.status) this.state.move(card.id, to);
    } else {
      return;
    }
    event.preventDefault();
  }
}
