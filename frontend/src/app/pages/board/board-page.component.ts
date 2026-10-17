import { SelectOption, SelectPickerComponent } from '../../components/select-picker/select-picker.component';
import { Component, DestroyRef, computed, effect, inject, signal, untracked } from '@angular/core';
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
import { BoardActivityComponent } from '../../components/board/board-activity/board-activity.component';
import { BoardSummary } from '../../core/models/board.models';
import { BoardSocketService } from '../../core/services/board-socket.service';
import { filter } from 'rxjs';
import { BoardCallsComponent } from '../../components/board/board-calls/board-calls.component';
import { BoardCyclesComponent } from '../../components/board/board-cycles/board-cycles.component';
import { TeamRelatedItemsComponent } from '../../components/team/related-items/related-items.component';
import { SessionCyclesStateService } from '../../core/state/session-cycles-state.service';
import { ChatStateService } from '../../core/state/chat-state.service';

/** The board page's tabs when a board is picked (specs/029); Cards is the default. */
export type BoardTab = 'cards' | 'calls' | 'task' | 'cycles' | 'items' | 'activity';
const BOARD_TABS: readonly BoardTab[] = ['cards', 'calls', 'task', 'cycles', 'items', 'activity'];

/**
 * The Board tab (specs/014-task-board US1, specs/027): every card of a project ("All cards"), or one board - a task - with
 * its related cycles and boards, its brief, spec files, requirements and chat above its cards. The board id travels as the
 * task key (?cycle=<board id>; a migrated board's id is its old cycle's), so old links still land on the right task.
 */
@Component({
  selector: 'app-board-page',
  standalone: true,
  imports: [SelectPickerComponent, BoardViewComponent, TaskViewComponent, ConfirmDialogComponent, BoardPickerComponent, RelatedStripComponent,
    BoardActivityComponent, BoardCallsComponent, BoardCyclesComponent, TeamRelatedItemsComponent],
  styles: [`
    .bp-tabs { display: flex; gap: 2px; margin: .4rem -1rem 0; padding: 0 .6rem; border-top: 1px solid var(--border);
      border-bottom: 1px solid var(--border); overflow-x: auto; }
    .bp-tab { padding: .6rem .85rem; border: 0; border-bottom: 2px solid transparent; background: none; color: var(--text-dim);
      font: inherit; font-size: .9rem; cursor: pointer; white-space: nowrap; }
    .bp-tab:hover { color: var(--text); }
    .bp-tab.on { color: var(--text); border-bottom-color: var(--accent-blue, #5b8def); }
    .bp-n { margin-left: .35rem; padding: 0 .4rem; border-radius: 999px; background: var(--card-inner); color: var(--text-dim); font-size: .72rem; }
    .bp-pane { padding-top: .7rem; }
  `],
  template: `
    @if (windowMode()) {
      <app-board-view [project]="project()" [cycleId]="cycleId()" [windowMode]="true" />
    } @else {
    <div class="board-page">
      <div class="board-head">
        <h1>Board</h1>
        <app-board-picker [project]="project()" [selected]="cycleId()" [editable]="editable()" (picked)="go(project(), $event)" />
        <app-select-picker [options]="projectOptions()" [value]="project()" ariaLabel="Project" (valueChange)="go($event, null)" />
        @if (cycleId(); as id) {
          <button type="button" class="action-btn" title="This board's chat, in the chat panel" (click)="chat.openChat(id)">💬 Chat</button>
        }
      </div>
      @if (cycleId(); as id) {
        <app-related-strip [summary]="summary()" [cycles]="cycles()" [allBoards]="allBoards()" [editable]="editable()"
                           (changed)="reloadSummary()" (deleted)="go(project(), null)" />
        <app-task-view [cycleId]="id" [project]="project()" [editable]="editable()" [cycleName]="cycleName()" [nested]="true"
                       [showTask]="tab() === 'task'" (taskAsked)="setTab('task')" (cardOpened)="setTab('cards')">
          <div tvTabs class="bp-tabs" role="tablist" aria-label="Board">
            @for (t of tabs(); track t.key) {
              <button type="button" role="tab" class="bp-tab" [class.on]="tab() === t.key" [attr.aria-selected]="tab() === t.key" (click)="setTab(t.key)">
                {{ t.label }}@if (t.n) { <span class="bp-n">{{ t.n }}</span> }</button>
            }
          </div>
          <div class="bp-pane">
            <app-board-view [project]="project()" [cycleId]="id" [cycleName]="cycleName()" [onlyCycleDeleted]="onlyCycleDeleted()"
                            [showBody]="tab() === 'cards'" />
            @switch (tab()) {
              @case ('calls') { <app-board-calls [cycles]="boardCycles()" /> }
              @case ('cycles') { <app-board-cycles [boardId]="id" [editable]="editable()" /> }
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
  readonly editable = signal(true);
  readonly chat = inject(ChatStateService);
  private readonly cycleState = inject(SessionCyclesStateService);
  /** The open tab (?tab=), Cards when none or unknown. */
  readonly tab = computed<BoardTab>(() => {
    const t = this.query().get('tab') as BoardTab | null;
    return t && BOARD_TABS.includes(t) ? t : 'cards';
  });
  readonly activityCount = signal(0);
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
      { key: 'calls' as const, label: 'Calls', n: cycles ? `${cycles} cycle${cycles === 1 ? '' : 's'}` : '' },
      { key: 'task' as const, label: 'Task', n: '' },
      { key: 'cycles' as const, label: 'Cycles', n: cycles ? String(cycles) : '' },
      { key: 'items' as const, label: 'Related items', n: '' },
      { key: 'activity' as const, label: 'Activity', n: this.activityCount() ? String(this.activityCount()) : '' },
    ];
  });

  constructor() {
    effect(() => document.body.classList.toggle('card-window', this.windowMode()));
    inject(DestroyRef).onDestroy(() => document.body.classList.remove('card-window'));
    this.board.access().subscribe({ next: (a) => this.editable.set(a.editable), error: () => undefined });
    effect(() => {
      const id = this.cycleId();
      untracked(() => this.reloadSummary(id));
    });
    const socket = inject(BoardSocketService);
    const sub = socket.events$.pipe(filter((e) => e.type === 'board-changed' && (e.what === 'boards' || e.what === 'deleted')))
      .subscribe(() => this.reloadSummary());
    inject(DestroyRef).onDestroy(() => sub.unsubscribe());
    effect(() => {
      const card = this.query().get('card');
      if (!card) return;
      untracked(() => this.mentions.cardToOpen.set({ project: this.project(), number: Number(card) }));
    });
  }

  go(project: string, boardId: string | null): void {
    void this.router.navigate([], { relativeTo: this.route, queryParams: { project: project || null, board: boardId, cycle: null, card: null, tab: null } });
  }

  /** A tab, kept in the address (replacing the history entry) so a reload or a link opens the same one. */
  setTab(t: BoardTab): void {
    if (t === this.tab()) return;
    void this.router.navigate([], { relativeTo: this.route, queryParams: { tab: t === 'cards' ? null : t }, queryParamsHandling: 'merge', replaceUrl: true });
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
