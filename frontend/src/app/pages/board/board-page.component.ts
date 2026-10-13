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

/**
 * The Board tab (specs/014-task-board US1): a project's board, or one session cycle's board with its brief, spec files
 * and checklist above it. The choice is in the URL (?project=&cycle=&card=), so "Add to board" and links land here.
 */
@Component({
  selector: 'app-board-page',
  standalone: true,
  imports: [SelectPickerComponent, BoardViewComponent, TaskViewComponent, ConfirmDialogComponent],
  template: `
    @if (windowMode()) {
      <app-board-view [project]="project()" [cycleId]="cycleId()" [windowMode]="true" />
    } @else {
    <div class="board-page">
      <div class="board-head">
        <h1>Board</h1>
        <div class="board-seg" role="group" aria-label="Which board">
          <button type="button" [class.on]="!cycleId()" (click)="go(project(), null)">Project board</button>
          <button type="button" [class.on]="!!cycleId()" (click)="go(project(), cycleId() ?? firstCycleId())">Cycle board</button>
        </div>
        @if (!cycleId()) {
          <app-select-picker [options]="projectOptions()" [value]="project()" ariaLabel="Project" (valueChange)="go($event, null)" />
        } @else {
          <app-select-picker [options]="cycleOptions()" [value]="cycleId() ?? ''" ariaLabel="Session cycle" (valueChange)="go(project(), $event)" />
        }
      </div>
      @if (cycleId(); as id) {
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
  readonly cycleId = computed(() => this.query().get('cycle'));
  /** ?window=1: a card window (↗ Window) - only the card, no nav, no board. */
  readonly windowMode = computed(() => this.query().get('window') === '1');
  readonly projects = toSignal(this.db.projects().pipe(map((ps) => [...ps.map((p) => p.project), '']), catchError(() => of(['']))),
    { initialValue: [''] as string[] });
  readonly cycles = toSignal(this.cyclesApi.list().pipe(catchError(() => of([] as SessionCycle[]))), { initialValue: [] as SessionCycle[] });
  readonly projectOptions = computed<SelectOption[]>(() => this.projects().map((p) => ({ value: p, label: p || 'No project' })));
  readonly cycleOptions = computed<SelectOption[]>(() => this.cycles().map((c) => ({ value: c.id, label: c.name })));
  readonly firstCycleId = computed(() => this.cycles()[0]?.id ?? null);
  readonly cycleName = computed(() => this.cycles().find((c) => c.id === this.cycleId())?.name ?? null);
  readonly editable = signal(true);

  constructor() {
    effect(() => document.body.classList.toggle('card-window', this.windowMode()));
    inject(DestroyRef).onDestroy(() => document.body.classList.remove('card-window'));
    this.board.access().subscribe({ next: (a) => this.editable.set(a.editable), error: () => undefined });
    effect(() => {
      const card = this.query().get('card');
      if (!card) return;
      untracked(() => this.mentions.cardToOpen.set({ project: this.project(), number: Number(card) }));
    });
  }

  go(project: string, cycleId: string | null): void {
    void this.router.navigate([], { relativeTo: this.route, queryParams: { project: project || null, cycle: cycleId, card: null } });
  }
}
