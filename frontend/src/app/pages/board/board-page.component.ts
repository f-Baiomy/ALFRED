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

/**
 * The Board tab (specs/014-task-board US1, specs/027): every card of a project ("All cards"), or one board - a task - with
 * its related cycles and boards, its brief, spec files, requirements and chat above its cards. The board id travels as the
 * task key (?cycle=<board id>; a migrated board's id is its old cycle's), so old links still land on the right task.
 */
@Component({
  selector: 'app-board-page',
  standalone: true,
  imports: [SelectPickerComponent, BoardViewComponent, TaskViewComponent, ConfirmDialogComponent, BoardPickerComponent, RelatedStripComponent,
    BoardActivityComponent],
  template: `
    @if (windowMode()) {
      <app-board-view [project]="project()" [cycleId]="cycleId()" [windowMode]="true" />
    } @else {
    <div class="board-page">
      <div class="board-head">
        <h1>Board</h1>
        <app-board-picker [project]="project()" [selected]="cycleId()" [editable]="editable()" (picked)="go(project(), $event)" />
        <app-select-picker [options]="projectOptions()" [value]="project()" ariaLabel="Project" (valueChange)="go($event, null)" />
      </div>
      @if (cycleId(); as id) {
        <app-related-strip [summary]="summary()" [cycles]="cycles()" [allBoards]="allBoards()" [editable]="editable()"
                           (changed)="reloadSummary()" (deleted)="go(project(), null)" />
        <app-board-activity [boardId]="id" [editable]="editable()" />
        <app-task-view [cycleId]="id" [project]="project()" [editable]="editable()" [cycleName]="cycleName()" />
      }
      <app-board-view [project]="project()" [cycleId]="cycleId()" [cycleName]="cycleName()" [onlyCycleDeleted]="onlyCycleDeleted()" />
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
    void this.router.navigate([], { relativeTo: this.route, queryParams: { project: project || null, board: boardId, cycle: null, card: null } });
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
