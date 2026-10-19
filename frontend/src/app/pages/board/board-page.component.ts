import { OutboxBarComponent } from '../../components/team/outbox/outbox-bar.component';
import { SelectOption, SelectPickerComponent } from '../../components/select-picker/select-picker.component';
import { Component, DestroyRef, ViewChild, computed, effect, inject, signal, untracked } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { toSignal } from '@angular/core/rxjs-interop';
import { catchError, map, of } from 'rxjs';
import { SessionCycle } from '../../core/models/call.model';
import { BoardMentionsService } from '../../core/services/board-mentions.service';
import { DbCaptureApiService } from '../../core/services/db-capture-api.service';
import { SessionCyclesApiService } from '../../core/services/session-cycles-api.service';
import { BoardViewComponent } from '../../components/board/board-view/board-view.component';
import { TaskViewComponent } from '../../components/board/task-view/task-view.component';
import { BoardApiService } from '../../core/services/board-api.service';
import { ConfirmDialogComponent } from '../../components/confirm-dialog/confirm-dialog.component';
import { BoardPickerComponent } from '../../components/board/board-picker/board-picker.component';
import { RelatedStripComponent } from '../../components/board/related-strip/related-strip.component';
import { BoardFactsComponent } from '../../components/board/board-facts/board-facts.component';
import { BoardStateMenuComponent } from '../../components/board/board-state-menu/board-state-menu.component';
import { NextStepCardComponent } from '../../components/board/next-step-card/next-step-card.component';
import { RecordLineComponent } from '../../components/board/record-line/record-line.component';
import { BannerComponent } from '../../shared/components/banner/banner.component';
import { BoardBannerService } from '../../core/state/board-banner.service';
import { boardRefChip, plainBoardTitle } from '../../shared/utils/board-title';
import { BoardActivityComponent } from '../../components/board/board-activity/board-activity.component';
import { BoardStage, BoardSummary } from '../../core/models/board.models';
import { BoardSocketService } from '../../core/services/board-socket.service';
import { debounceTime, filter } from 'rxjs';
import { BoardCallsComponent } from '../../components/board/board-calls/board-calls.component';
import { BoardCyclesComponent } from '../../components/board/board-cycles/board-cycles.component';
import { TeamRelatedItemsComponent } from '../../components/team/related-items/related-items.component';
import { SessionCyclesStateService } from '../../core/state/session-cycles-state.service';
import { ChatStateService } from '../../core/state/chat-state.service';
import { StageStripComponent } from '../../components/board/stage-strip/stage-strip.component';
import { BoardSessionButtonComponent } from '../../components/board-session/board-session-button.component';
import { SessionsStateService } from '../../core/state/sessions-state.service';
import { LinksStateService } from '../../core/links/links-state.service';
import { splitRef } from '../../core/links/remote-ref';
import { RemoteContextService } from '../../core/links/remote-context.service';
import { LinksSocketService } from '../../core/links/links-socket.service';
import { OriginPillComponent } from '../../components/links/origin-pill/origin-pill.component';
import { OutPillComponent } from '../../components/links/out-pill/out-pill.component';
import { StreamDialogService } from '../../components/links/stream-dialog/stream-dialog.service';

/** The board page's tabs when a board is picked (specs/029); Cards is the default. */
export type BoardTab = 'cards' | 'calls' | 'task' | 'cycles' | 'items' | 'activity';
const BOARD_TABS: readonly BoardTab[] = ['cards', 'calls', 'task', 'cycles', 'items', 'activity'];

/**
 * The Board tab (specs/014-task-board US1, specs/027): every card of a project ("All cards"), or one board - a task. Its
 * header (specs/032) is one row (Boards ▾, the work item, the plain title, project, state, Chat, Claude), the facts line,
 * the stage line, the Next card and the recording line; then the tabs. The project's default board shows only the header
 * and its cards. The board id travels as the
 * task key (?cycle=<board id>; a migrated board's id is its old cycle's), so old links still land on the right task.
 */
@Component({
  selector: 'app-board-page',
  standalone: true,
  imports: [OriginPillComponent, OutPillComponent, OutboxBarComponent, SelectPickerComponent, BoardViewComponent, TaskViewComponent, ConfirmDialogComponent, BoardPickerComponent, RelatedStripComponent,
    BoardActivityComponent, BoardCallsComponent, BoardCyclesComponent, TeamRelatedItemsComponent, StageStripComponent, BoardSessionButtonComponent,
    BoardFactsComponent, BoardStateMenuComponent, NextStepCardComponent, RecordLineComponent, BannerComponent],
  styles: [`
    .bp-head { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
    .bp-id { padding: 2px 7px; border: 1px solid color-mix(in srgb, var(--purple) 35%, transparent); border-radius: 6px;
      background: color-mix(in srgb, var(--purple) 14%, transparent); color: var(--purple-light); font: 600 12px ui-monospace, Consolas, monospace; white-space: nowrap; }
    .bp-title { flex: 1 1 0; min-width: 0; margin: 0; overflow: hidden; font-size: 18px; font-weight: 600; text-overflow: ellipsis; white-space: nowrap; }
    @media (max-width: 1150px) { .bp-title { order: 10; flex-basis: 100%; white-space: normal; } }
    /* inside the task panel (.tv, bordered, no padding): no bleed past its border (it showed 16px outside, 2026-10-18) */
    .bp-tabs { display: flex; gap: 2px; margin: .4rem 0 0; padding: 0 .6rem; border-top: 1px solid var(--border);
      border-bottom: 1px solid var(--border); overflow-x: auto; }
    .bp-tab { padding: .6rem .85rem; border: 0; border-bottom: 2px solid transparent; background: none; color: var(--text-dim);
      font: inherit; font-size: .9rem; cursor: pointer; white-space: nowrap; }
    .bp-tab:hover { color: var(--text); }
    .bp-tab.on { color: var(--text); border-bottom-color: var(--accent-blue, #5b8def); }
    .bp-n { margin-left: .35rem; padding: 0 .4rem; border-radius: 999px; background: var(--card-inner); color: var(--text-dim); font-size: .72rem; }
    .bp-pane { padding-top: .7rem; }
    .bp-held { margin: .4rem 0; padding: .5rem .75rem; border: 1px solid var(--border); border-radius: 8px; background: var(--card-inner);
      font-size: .88rem; }
  `],
  template: `
    @if (windowMode()) {
      <app-board-view [project]="project()" [cycleId]="cycleId()" [windowMode]="true" />
    } @else {
    <div class="board-page">
      <!-- one header row (specs/032 T040): Boards ▾, the work item, the plain title, project, state, Chat, Claude -->
      <div class="bp-head">
        <app-board-picker [project]="project()" [selected]="cycleId()" [editable]="editable()" (picked)="goBoard($event)" />
        @if (remote()) { <app-origin-pill [ref]="cycleId()" kind="BOARD" /> }
        @else if (taskBoard()) { <app-out-pill kind="BOARD" [target]="taskBoard()!" [name]="cycleName() ?? taskBoard()!" [project]="project()" /> }
        @if (refChip(); as r) { <span class="bp-id" [title]="cycleName() ?? r">{{ r }}</span> }
        <h2 class="bp-title" [title]="fullTitle()">{{ plainTitle() }}</h2>
        @if (!remote()) {
          <app-select-picker [options]="projectOptions()" [value]="project()" ariaLabel="Project" (valueChange)="go($event, null)" />
        }
        @if (taskBoard() && !remote()) {
          <app-board-state-menu [summary]="summary()" [editable]="editable()" (changed)="reloadSummary()" (deleted)="go(project(), null)" />
        }
        @if (cycleId(); as id) {
          <button type="button" class="action-btn bp-chat" [title]="chatTitle()"
                  (click)="chat.openChat(id)">💬 Chat</button>
        }
        @if (taskBoard() && !remote() && editable()) {
          <button type="button" class="action-btn" title="Let a linked Alfred read this board live" (click)="streamBoard()">⇉ Stream…</button>
        }
        @if (project() && !remote()) {
          <app-board-session-button #claude [project]="project()" [boardId]="sessionBoard()" [title]="cycleName()" [ref]="stage()?.ref ?? null"
                                    [cycles]="boardCycles()" [terminalOn]="terminalOn()" [unread]="chatSummary()?.waiting ?? 0"
                                    [chatSeq]="chatSummary()?.lastId ?? null" />
        }
      </div>
      @if (taskBoard(); as id) {
        <app-board-facts [project]="project()" [boardId]="id" [stage]="stage()" [cards]="summary()?.cards ?? 0" [editable]="editable()" />
      } @else if (project()) {
        <app-team-outbox-bar [boardId]="sessionBoard()" [project]="project()" [editable]="editable()" />
      }
      @if (bannerHere(); as b) {
        <app-banner [tone]="b.tone" [text]="b.text" [detail]="b.detail ?? null" [action]="b.action ?? null" [dismissable]="b.dismissable !== false"
                    (act)="b.onAction?.()" (dismiss)="banner.clear()" />
      }
      @if (remote()) {
        <div class="bp-held" role="status">
          @if (!originOnline()) {
            ⇇ <b>{{ links.nameOf(remoteSlug()) }}</b> is offline - its board is read live from it, so nothing of it is shown until it is
            back. Comments you write are kept in this browser and sent then.
          } @else if (remoteStream()?.endedAt) {
            ⇇ <b>{{ links.nameOf(remoteSlug()) }}</b> stopped streaming this board.
          } @else {
            ⇇ Streamed from <b>{{ links.nameOf(remoteSlug()) }}</b> - {{ remoteStream()?.mode === 'COMMENT'
              ? 'you may comment and ask on its cards and brief; each one is a request its owner accepts.'
              : 'view only.' }} Cards, states, the brief and the chat stay its owner's.
          }
        </div>
      }
      @if (heldByOther(); as h) {
        <div class="bp-held" role="status">🔒 <b>{{ h.user }}</b> holds this board@if (h.machine) { (on {{ h.machine }}) }. You can read it;
          writing waits until they hand it over - ask from the 🔒 button.</div>
      }
      @if (cycleId(); as id) {
        @if (taskBoard()) {
          <app-stage-strip [stage]="stage()" [phase]="phase()" />
          <!-- the next step and recording are the owner's on another Alfred's board -->
          @if (!remote()) {
            <app-next-step-card [project]="project()" [boardId]="id" [boardName]="cycleName()" [stage]="stage()" [terminalOn]="terminalOn()"
                                [cycles]="boardCycles()" [editable]="editable()" (askClaude)="claude?.runAfterStart($event)" />
            <app-record-line [boardId]="id" [cycles]="boardCycles()" [editable]="editable()" (changed)="reloadSummary()" />
          }
        }
        <app-task-view [cycleId]="id" [project]="project()" [editable]="editable()" [cycleName]="cycleName()" [nested]="true"
                       [showTask]="tab() === 'task'" (taskAsked)="setTab('task')" (cardOpened)="setTab('cards')" (phaseChange)="phase.set($event)">
          <div tvTabs class="bp-tabs" role="tablist" aria-label="Board">
            @for (t of tabs(); track t.key) {
              <button type="button" role="tab" class="bp-tab" [class.on]="tab() === t.key" [attr.aria-selected]="tab() === t.key" (click)="setTab(t.key)">
                {{ t.label }}@if (t.n) { <span class="bp-n">{{ t.n }}</span> }</button>
            }
          </div>
          <div class="bp-pane">
            <app-board-view [project]="project()" [cycleId]="id" [cycleName]="cycleName()" [onlyCycleDeleted]="onlyCycleDeleted()"
                            [showBody]="tab() === 'cards'" [showNextSteps]="!taskBoard()" />
            @switch (tab()) {
              @case ('calls') { <app-board-calls [cycles]="boardCycles()" /> }
              @case ('cycles') {
                <!-- the board's recordings (specs/033), then its related boards -->
                <app-board-cycles [boardId]="id" [editable]="editable()" />
                <app-related-strip [summary]="summary()" [cycles]="cycles()" [allBoards]="allBoards()" [editable]="editable()" [showCycles]="false" (changed)="reloadSummary()" />
              }
              @case ('items') { <app-team-related-items [boardId]="id" [editable]="editable()" /> }
            }
            <div [hidden]="tab() !== 'activity'">
              <app-board-activity [boardId]="id" [editable]="editable()" [flat]="true" (count)="activityCount.set($event)" />
            </div>
          </div>
        </app-task-view>
      } @else {
        <app-board-view [project]="project()" [cycleId]="null" [cycleName]="null" [onlyCycleDeleted]="onlyCycleDeleted()" />
      }
    </div>
    }
    <!-- The card drawer's "Delete card…" (and a call card's confirms in the call popup) ask through this - each page
         hosts its own, like every other page that confirms. Without it the question never showed and Delete did nothing. -->
    <app-confirm-dialog />`,
})
export class BoardPageComponent {
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly mentions = inject(BoardMentionsService);
  private readonly db = inject(DbCaptureApiService);
  private readonly cyclesApi = inject(SessionCyclesApiService);
  private readonly board = inject(BoardApiService);

  private readonly query = toSignal(this.route.queryParamMap, { initialValue: this.route.snapshot.queryParamMap });
  readonly project = computed(() => this.query().get('project') ?? this.projects()[0] ?? '');
  /** ?cycleDeleted=1 (from Settings -> Storage): open with the "cycle deleted" filter on. */
  readonly onlyCycleDeleted = computed(() => this.query().get('cycleDeleted') === '1');
  /** The selected board (?board=, or ?cycle= from before boards: a migrated board has its cycle's id). Null = All cards. */
  readonly cycleId = computed(() => this.query().get('board') ?? this.query().get('cycle'));
  /** ?window=1: a card window (↗ Window) - only the card, no nav, no board. */
  readonly windowMode = computed(() => this.query().get('window') === '1');
  readonly projects = toSignal(this.db.projects().pipe(map((ps) => [...ps.map((p) => p.project), '']), catchError(() => of(['']))),
    { initialValue: [''] as string[] });
  readonly cycles = toSignal(this.cyclesApi.list().pipe(catchError(() => of([] as SessionCycle[]))), { initialValue: [] as SessionCycle[] });
  readonly projectOptions = computed<SelectOption[]>(() => this.projects().map((p) => ({ value: p, label: p || 'No project' })));
  readonly summary = signal<BoardSummary | null>(null);
  readonly allBoards = signal<BoardSummary[]>([]);
  readonly cycleName = computed(() => this.summary()?.board.name ?? this.cycles().find((c) => c.id === this.cycleId())?.name ?? null);
  /** The edit rule (IP, tunnel) - and, since specs/031, the board lock: a board another user holds is read-only here. */
  readonly accessEditable = signal(true);
  private readonly sessions = inject(SessionsStateService);
  readonly heldByOther = computed(() => this.sessions.heldByOther(this.cycleId() ?? (this.project() ? `default:${this.project()}` : null)));
  readonly editable = computed(() => this.accessEditable() && !this.heldByOther() && !this.remote());
  // ------------------------------------------------------------------------- another Alfred's board (specs/035)
  readonly links = inject(LinksStateService);
  private readonly streamDialog = inject(StreamDialogService);
  readonly remoteSlug = computed(() => splitRef(this.cycleId())?.slug ?? null);
  /** Another Alfred's board, read through the link: shown, never changed here (D20) - requests go to its owner. */
  readonly remote = computed(() => this.remoteSlug() !== null);
  readonly chatTitle = computed(() => (this.remote() ? "Its owner's board chat - read only here" : "This board's chat, in the chat panel"));
  readonly originOnline = computed(() => !this.remote() || !!this.links.linkOf(this.remoteSlug())?.online);
  readonly remoteStream = computed(() => {
    const s = splitRef(this.cycleId());
    const link = s ? this.links.linkOf(s.slug) : undefined;
    return s && link ? this.links.givenStream(link.id, 'BOARD', s.inner) : undefined;
  });
  readonly chat = inject(ChatStateService);
  private readonly cycleState = inject(SessionCyclesStateService);
  /** The open tab (?tab=), Cards when none or unknown. */
  readonly tab = computed<BoardTab>(() => {
    const t = this.query().get('tab') as BoardTab | null;
    return t && BOARD_TABS.includes(t) ? t : 'cards';
  });
  readonly activityCount = signal(0);
  readonly banner = inject(BoardBannerService);
  @ViewChild('claude') claude?: BoardSessionButtonComponent;
  /** A task board (not All cards, not the project's default board): it has a stage, facts and a Next card. */
  readonly taskBoard = computed(() => {
    const id = this.cycleId();
    return id && !id.startsWith('default:') && !this.summary()?.board?.isDefault ? id : null;
  });
  /** The board the Claude control is for: the one in view, else the project's default board. */
  readonly sessionBoard = computed(() => this.cycleId() ?? `default:${this.project()}`);
  /** Where the task stands (`BoardStage.of`, the one rule): the stage line, the facts and the Next card all read it. */
  readonly stage = signal<BoardStage | null>(null);
  /** 0 Coded … 4 Done, from the task view (where the requirements and cards are read). */
  readonly phase = signal<number | null>(null);
  readonly refChip = computed(() => (this.taskBoard() ? boardRefChip(this.stage()?.ref, this.summary()?.linkedItem) : null));
  readonly fullTitle = computed(() => (this.cycleId() ? this.cycleName() ?? '' : 'All cards'));
  readonly plainTitle = computed(() => {
    if (!this.cycleId()) return 'All cards';
    if (!this.taskBoard()) return this.project() || this.cycleName() || '';
    return plainBoardTitle(this.cycleName(), this.refChip());
  });
  /** The board chat's summary: who answers it (a terminal /alfred-live) and what waits for Claude. */
  readonly chatSummary = computed(() => {
    const scope = this.cycleId();
    return this.chat.summaries().find((s) => s.scope === scope) ?? null;
  });
  readonly terminalOn = computed(() => {
    const s = this.chatSummary();
    return !!(s?.terminal?.open || s?.claudeOn);
  });
  /** The banner, only on the board it is about. */
  readonly bannerHere = computed(() => {
    const b = this.banner.current();
    return b && (!b.boardId || b.boardId === this.cycleId() || b.boardId === this.sessionBoard()) ? b : null;
  });
  /** The board's cycles with their names and state (the live list, so a new cycle or a recording shows). */
  readonly boardCycles = computed(() => {
    const ids = this.summary()?.cycleIds ?? [];
    const all = this.cycleState.cycles().length ? this.cycleState.cycles() : this.cycles();
    return ids.map((id) => all.find((c) => c.id === id) ?? { id, name: id, status: 'PAUSED' as SessionCycle['status'] });
  });
  readonly tabs = computed(() => {
    const cycles = this.boardCycles().length;
    return [
      { key: 'cards' as const, label: 'Cards', n: '' },
      { key: 'calls' as const, label: 'Calls', n: cycles ? String(cycles) : '' },
      { key: 'task' as const, label: 'Task', n: '' },
      { key: 'cycles' as const, label: 'Cycles', n: cycles ? String(cycles) : '' },
      { key: 'items' as const, label: 'Related items', n: '' },
      { key: 'activity' as const, label: 'Activity', n: this.activityCount() ? String(this.activityCount()) : '' },
    ];
  });

  constructor() {
    effect(() => document.body.classList.toggle('card-window', this.windowMode()));
    // another Alfred's board: presence for its owner (D29), and notes on its calls go over its stream
    const context = inject(RemoteContextService);
    const linksSocket = inject(LinksSocketService);
    let viewing: { slug: string; target: string } | null = null;
    effect(() => {
      const s = splitRef(this.cycleId());
      untracked(() => {
        context.boardRef.set(s ? this.cycleId() : null);
        if (viewing) linksSocket.viewing(viewing.slug, viewing.target, false);
        viewing = s ? { slug: s.slug, target: s.inner } : null;
        if (viewing) linksSocket.viewing(viewing.slug, viewing.target, true);
      });
    });
    inject(DestroyRef).onDestroy(() => {
      context.boardRef.set(null);
      if (viewing) linksSocket.viewing(viewing.slug, viewing.target, false);
    });
    inject(DestroyRef).onDestroy(() => document.body.classList.remove('card-window'));
    this.board.access().subscribe({ next: (a) => this.accessEditable.set(a.editable), error: () => undefined });
    effect(() => {
      const id = this.cycleId();
      untracked(() => {
        this.reloadSummary(id);
        this.phase.set(null);
        this.loadStage(id);
        const b = this.banner.current();
        if (b?.boardId && b.boardId !== id) this.banner.clear();
      });
    });
    const socket = inject(BoardSocketService);
    const sub = socket.events$.pipe(filter((e) => e.type === 'board-changed' && (e.what === 'boards' || e.what === 'deleted')))
      .subscribe(() => this.reloadSummary());
    // the stage follows the board's cards, brief and requirements - re-read on its signals, never on a timer
    const stageSub = socket.events$.pipe(filter((e) => e.type === 'board-changed' && (!e.project || e.project === this.project())), debounceTime(400))
      .subscribe(() => this.loadStage(this.cycleId()));
    inject(DestroyRef).onDestroy(() => { sub.unsubscribe(); stageSub.unsubscribe(); });
    effect(() => {
      const card = this.query().get('card');
      if (!card) return;
      untracked(() => this.mentions.cardToOpen.set({ project: this.project(), number: Number(card) }));
    });
  }

  /** A board picked in Boards ▾: another Alfred's opens with its own project. */
  goBoard(boardId: string | null): void {
    const s = splitRef(boardId);
    if (s) {
      const link = this.links.linkOf(s.slug);
      const stream = link ? this.links.givenStream(link.id, 'BOARD', s.inner) : undefined;
      this.go(stream?.project ?? this.project(), boardId);
      return;
    }
    this.go(this.remote() ? '' : this.project(), boardId);
  }

  streamBoard(): void {
    const id = this.taskBoard();
    if (id) this.streamDialog.open({ kind: 'BOARD', target: id, name: this.cycleName() ?? id, project: this.project() || null });
  }

  go(project: string, boardId: string | null): void {
    void this.router.navigate([], { relativeTo: this.route, queryParams: { project: project || null, board: boardId, cycle: null, card: null, tab: null } });
  }

  /** A tab, kept in the address (replacing the history entry) so a reload or a link opens the same one. */
  setTab(t: BoardTab): void {
    if (t === this.tab()) return;
    void this.router.navigate([], { relativeTo: this.route, queryParams: { tab: t === 'cards' ? null : t }, queryParamsHandling: 'merge', replaceUrl: true });
  }

  loadStage(id: string | null): void {
    if (!id || id.startsWith('default:')) { this.stage.set(null); return; }
    this.board.stage(id).subscribe({ next: (st) => this.cycleId() === id && this.stage.set(st), error: () => this.stage.set(null) });
  }

  reloadSummary(id: string | null = this.cycleId()): void {
    this.board.boards(null).subscribe({ next: (b) => this.allBoards.set(b), error: () => undefined });
    if (!id) {
      this.summary.set(null);
      return;
    }
    this.board.board(id).subscribe({ next: (b) => this.summary.set(b), error: () => this.summary.set(null) });
  }
}
