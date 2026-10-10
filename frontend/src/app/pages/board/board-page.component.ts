import { Component, computed, effect, inject, signal, untracked } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { toSignal } from '@angular/core/rxjs-interop';
import { catchError, map, of } from 'rxjs';
import { SessionCycle } from '../../core/models/call.model';
import { BoardMentionsService } from '../../core/services/board-mentions.service';
import { DbCaptureApiService } from '../../core/services/db-capture-api.service';
import { SessionCyclesApiService } from '../../core/services/session-cycles-api.service';
import { AcceptanceChecklistComponent } from '../../components/board/acceptance-checklist/acceptance-checklist.component';
import { BoardViewComponent } from '../../components/board/board-view/board-view.component';
import { CycleBriefComponent } from '../../components/board/cycle-brief/cycle-brief.component';
import { SpecFilesComponent } from '../../components/board/spec-files/spec-files.component';
import { BoardApiService } from '../../core/services/board-api.service';

/**
 * The Board tab (specs/014-task-board US1): a project's board, or one session cycle's board with its brief, spec files
 * and checklist above it. The choice is in the URL (?project=&cycle=&card=), so "Add to board" and links land here.
 */
@Component({
  selector: 'app-board-page',
  standalone: true,
  imports: [AcceptanceChecklistComponent, BoardViewComponent, CycleBriefComponent, SpecFilesComponent],
  template: `
    <div class="board-page">
      <div class="board-head">
        <h1>Board</h1>
        <div class="board-seg" role="group" aria-label="Which board">
          <button type="button" [class.on]="!cycleId()" (click)="go(project(), null)">Project board</button>
          <button type="button" [class.on]="!!cycleId()" (click)="go(project(), cycleId() ?? firstCycleId())">Cycle board</button>
        </div>
        @if (!cycleId()) {
          <select [value]="project()" (change)="go($any($event.target).value, null)" aria-label="Project">
            @for (p of projects(); track p) { <option [value]="p">{{ p || 'No project' }}</option> }
          </select>
        } @else {
          <select [value]="cycleId()" (change)="go(project(), $any($event.target).value)" aria-label="Session cycle">
            @for (c of cycles(); track c.id) { <option [value]="c.id">{{ c.name }}</option> }
          </select>
        }
      </div>
      @if (cycleId(); as id) {
        <div class="board-brief">
          <app-cycle-brief [cycleId]="id" [project]="project()" [editable]="editable()" />
          <div class="board-brief-side">
            <app-spec-files [cycleId]="id" [editable]="editable()" />
            <app-acceptance-checklist [cycleId]="id" [project]="project()" [editable]="editable()" />
          </div>
        </div>
      }
      <app-board-view [project]="project()" [cycleId]="cycleId()" [cycleName]="cycleName()" />
    </div>`,
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
  readonly cycleId = computed(() => this.query().get('cycle'));
  readonly projects = toSignal(this.db.projects().pipe(map((ps) => [...ps.map((p) => p.project), '']), catchError(() => of(['']))),
    { initialValue: [''] as string[] });
  readonly cycles = toSignal(this.cyclesApi.list().pipe(catchError(() => of([] as SessionCycle[]))), { initialValue: [] as SessionCycle[] });
  readonly firstCycleId = computed(() => this.cycles()[0]?.id ?? null);
  readonly cycleName = computed(() => this.cycles().find((c) => c.id === this.cycleId())?.name ?? null);
  readonly editable = signal(true);

  constructor() {
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
