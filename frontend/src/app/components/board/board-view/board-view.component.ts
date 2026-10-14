import { Component, DestroyRef, HostListener, computed, effect, inject, input, signal, untracked, viewChild } from '@angular/core';
import { Title } from '@angular/platform-browser';
import {
  ALL_STATUSES, Actor, BoardFilters, NO_TEAM, BulkAction, CardKind, CardSummary, FLAGS, FLAG_LABELS, Flag, KINDS, OPEN_STATUSES, Resolution, Waiting,
} from '../../../core/models/board.models';
import { BoardNotifyService } from '../../../core/services/board-notify.service';
import { ConfirmDialogService } from '../../../core/services/confirm-dialog.service';
import { BoardSeenService } from '../../../core/services/board-seen.service';
import { NextStepsBarComponent } from '../next-steps-bar/next-steps-bar.component';
import { QuickAnswerComponent } from '../quick-answer/quick-answer.component';
import { BoardApiService } from '../../../core/services/board-api.service';
import { BoardExportFormat, BoardExportService } from '../../../core/services/board-export.service';
import { BoardMentionsService } from '../../../core/services/board-mentions.service';
import { BoardStateService, messageOf } from '../../../core/state/board-state.service';
import { CardViewMode, CardViewModeService, CardWindowTarget } from '../../../core/services/card-view-mode.service';
import { TeamsStateService } from '../../../core/state/teams-state.service';
import { RetestStateService } from '../../../core/state/retest-state.service';
import { RetestStripComponent } from '../retest-strip/retest-strip.component';
import { ActionMenuComponent } from '../../action-menu/action-menu.component';
import { CardAction } from '../board-card/board-card.component';
import { BoardColumnsComponent, CardDrop } from '../board-columns/board-columns.component';
import { BoardHelpComponent } from '../board-help/board-help.component';
import { BoardListViewComponent } from '../board-list-view/board-list-view.component';
import { BoardProgressComponent } from '../board-progress/board-progress.component';
import { BulkBarComponent } from '../bulk-bar/bulk-bar.component';
import { CardDrawerComponent } from '../card-drawer/card-drawer.component';
import { LiveStripComponent } from '../live-strip/live-strip.component';
import { QuickAddComponent } from '../quick-add/quick-add.component';
import { TriageDecision, TriageDialogComponent } from '../triage-dialog/triage-dialog.component';
import { UndoToastComponent } from '../undo-toast/undo-toast.component';

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
  imports: [ActionMenuComponent, BoardPagesComponent, BoardColumnsComponent, BoardHelpComponent, BoardListViewComponent, BoardProgressComponent,
    BulkBarComponent, CardDrawerComponent, LiveStripComponent, NextStepsBarComponent, QuickAddComponent, QuickAnswerComponent, RetestStripComponent, TriageDialogComponent,
    UndoToastComponent],
  template: `
    @if (!windowMode()) {
    <app-live-strip [status]="state.agent()" [project]="project()" [cycleId]="cycleId()" [editable]="state.editable()" (action)="state.agentAction($event)" />
    <app-retest-strip [project]="project()" [editable]="state.editable()" />
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
      @for (k of kinds; track k) {
        <button type="button" class="board-pill" [class.on]="state.filters().kinds.includes(k)" (click)="toggleKind(k)">{{ k }}</button>
      }
      @for (f of flags; track f) {
        <button type="button" class="board-pill" [class.on]="state.filters().flags.includes(f)" (click)="toggleFlag(f)">{{ flagLabels[f] }}</button>
      }
      <button type="button" class="board-pill board-pill-wait" [class.on]="state.filters().waiting === 'USER'" (click)="toggleWaiting('USER')">Waiting on me</button>
      <button type="button" class="board-pill" [class.on]="state.filters().waiting === 'CLAUDE'" (click)="toggleWaiting('CLAUDE')">Waiting on Claude</button>
      <button type="button" class="board-pill" [class.on]="state.filters().waiting === 'RETEST'" (click)="toggleWaiting('RETEST')">Needs re-test</button>
      <button type="button" class="board-pill" [class.on]="state.filters().author === 'CLAUDE'" (click)="toggleAuthor('CLAUDE')">✦ by Claude</button>
      <button type="button" class="board-pill" [class.on]="state.filters().scopeNotDecided" (click)="toggleScope()">Scope not decided</button>
      @if (!cycleId()) {
        <button type="button" class="board-pill" [class.on]="!!state.filters().cycleDeleted" title="Cards whose session cycle was deleted - clean them up"
                (click)="toggleCycleDeleted()">◷ Cycle deleted</button>
      }
      @if (teamsState.teams().length) {
        <span class="board-filter-sep" aria-hidden="true"></span>
        @for (t of teamsState.teams(); track t.id) {
          <button type="button" class="board-pill board-pill-team" [style.--team]="t.color" [class.on]="(state.filters().teams ?? []).includes(t.id)"
                  [title]="'Cards assigned to ' + t.name" (click)="toggleTeam(t.id)">{{ t.icon ? t.icon + ' ' : '' }}{{ t.name }}</button>
        }
        <button type="button" class="board-pill" [class.on]="(state.filters().teams ?? []).includes(noTeam)" title="Cards with no team yet"
                (click)="toggleTeam(noTeam)">No team</button>
      }
      <input #search class="board-search" type="search" placeholder="Search cards…" [value]="state.filters().q"
             (keydown.enter)="setSearch(search.value)" (search)="setSearch(search.value)" />
    </div>
    @if (state.page(); as page) {
      <app-board-progress [label]="progressLabel()" [open]="page.counts.open" [fixed]="page.counts.fixed" [done]="page.counts.done" />
    }
    <app-next-steps-bar [project]="project()" [cycleId]="cycleId()" [cycleName]="cycleName()" [version]="state.page()" (opened)="openNumber($event)" />
    @if (showPages() && project() && !cycleId()) {
      <app-board-pages class="board-project-pages" [owner]="'project:' + project()" [canEdit]="state.editable()" [context]="{ project: project() }" />
    }
    @if (state.error()) { <div class="board-error" role="alert">{{ state.error() }} <button type="button" class="board-link" (click)="state.error.set(null)">✕</button></div> }
    @if (message()) { <div class="board-note">{{ message() }} <button type="button" class="board-link" (click)="message.set(null)">✕</button></div> }

    @if (state.view() === 'board') {
      <app-board-columns [cards]="state.cards()" [editable]="state.editable()" [selected]="state.selected()" [focusedId]="state.focusedId()"
                         [showCycle]="!cycleId()" [now]="now()" [retests]="retest.byNumber()" (retest)="retest.start($event)"
                         (moved)="onMoved($event)" (opened)="openCard($event)" (toggled)="state.toggleSelected($event.id)"
                         (action)="onAction($event.card, $event.action)" (triage)="startTriage()"
                         (answer)="answering.set($event.id)" />
    } @else {
      <app-board-list-view [cards]="sortedForList()" [editable]="state.editable()" [selected]="state.selected()" [focusedId]="state.focusedId()"
                           [now]="now()" (opened)="openCard($event)" (toggled)="state.toggleSelected($event.id)" />
    }

    <app-bulk-bar [count]="state.selected().size" [total]="state.cards().length" (action)="bulk($event)" (cleared)="state.clearSelection()"
                  (selectAll)="selectAll()" />
    <app-undo-toast [pending]="state.pendingUndo()" (undo)="state.undo()" (reason)="state.addReason($event)" (dismissed)="state.pendingUndo.set(null)" />
    @if (triageQueue(); as queue) {
      <app-triage-dialog [queue]="queue" (decided)="onTriage($event)" (closed)="triageQueue.set(null)" />
    }
    @if (help()) { <app-board-help (closed)="help.set(false)" /> }
    @if (answering(); as id) { <app-quick-answer [cardId]="id" (closed)="answering.set(null)" /> }
    }
    @if (state.openCardId(); as id) {
      <app-card-drawer [cardId]="id" [version]="state.openCardVersion()" [editable]="state.editable()" [inCycle]="!!cycleId()" [layout]="layout()"
                       (modeChange)="changeMode(id, $event)" (closed)="closeCard()" (retestRequested)="retest.start([$event])" (closeRequested)="state.close($event, $event.resolution)" />
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
  private readonly cardMode = inject(CardViewModeService);
  readonly teamsState = inject(TeamsStateService);
  readonly noTeam = NO_TEAM;
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
  readonly notify = inject(BoardNotifyService);
  private readonly seen = inject(BoardSeenService);
  /** Cards Claude changed since they were last opened here - counted in the tab title (specs/015 FR-9). */
  readonly unread = computed(() => this.state.cards().filter((c) => this.seen.isUnread(c)).length);
  /** "Now" for ages and the stale marker - refreshed whenever the cards are, so it needs no clock of its own. */
  readonly now = computed(() => (this.state.page(), Date.now()));
  private readonly quick = viewChild<QuickAddComponent>('quick');

  readonly progressLabel = computed(() => (this.cycleId() ? this.cycleName() ?? this.cycleId()! : this.project() || 'No project'));
  readonly sortedForList = computed(() => [...this.state.cards()].sort((a, b) =>
    ALL_STATUSES.indexOf(a.status) - ALL_STATUSES.indexOf(b.status) || b.updatedAt.localeCompare(a.updatedAt)));
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
    effect(() => {
      const project = this.project();
      const cycleId = this.cycleId();
      untracked(() => {
        this.state.show(project, cycleId);
        this.retest.show(project);
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
    this.state.move(drop.card.id, drop.to);
  }

  onAction(card: CardSummary, action: CardAction): void {
    if (action.kind === 'close') this.state.close(card, action.resolution);
    else if (action.kind === 'move') this.state.move(card.id, action.status);
    else if (action.kind === 'retest') this.retest.start([card.number]);
    else this.state.reopen(card.id);
  }

  startTriage(): void {
    this.triageQueue.set(this.state.cards().filter((c) => c.status === 'INBOX'));
  }

  onTriage(d: TriageDecision): void {
    if (d.kind === 'todo') this.state.move(d.card.id, 'TO_DO');
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

  private setFilters(change: Partial<BoardFilters>): void {
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
    if (this.windowMode()) {
      if (event.key === 'Escape' && !document.querySelector('.dialog-backdrop')) this.closeCard();
      return;
    }
    if (event.key === 'F' && event.shiftKey && this.state.openCardId()) {
      this.cardMode.set(this.layout() === 'full' ? 'side' : 'full');
      return;
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
    else if (key === 'a' && card.waiting?.who === 'USER' && card.flags.includes('NEEDS_DECISION')) this.answering.set(card.id);
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
