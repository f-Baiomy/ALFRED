import { Component, inject, output } from '@angular/core';
import { TeamStateService } from '../../../core/team/team-state.service';
import { TeamSearch, TeamSprint } from '../../../core/team/team.models';

/**
 * The tracker's own boards (with their columns) and iterations, from the cached lists (specs/028 FR-016): an iteration
 * clicked runs a search for its open items.
 */
@Component({
  selector: 'app-team-boards-sprints',
  standalone: true,
  template: `
    <div class="tbs">
      <section>
        <h4>{{ state.ui().word('sprint') }}s</h4>
        @for (s of state.lists()?.iterations ?? []; track s.extId) {
          <button type="button" class="tbs-row" (click)="pick(s)" title="Search this iteration's open items">
            <b>{{ s.name }}</b> <span class="tbs-dim">{{ s.team }}</span>
            <span class="tbs-dim">{{ s.starts?.slice(0, 10) }} → {{ s.ends?.slice(0, 10) }}</span>
            @if (current(s)) { <span class="tbs-now">current</span> }
          </button>
        } @empty { <div class="tbs-dim">No {{ state.ui().word('sprint').toLowerCase() }}s read yet</div> }
      </section>
      <section>
        <h4>Boards</h4>
        @for (b of state.lists()?.boards ?? []; track b.extId) {
          <div class="tbs-row"><b>{{ b.name }}</b> <span class="tbs-dim">{{ b.team || b.project }}</span>
            <div class="tbs-cols">@for (c of b.columns; track c) { <span>{{ c }}</span> }</div></div>
        } @empty { <div class="tbs-dim">No boards read yet</div> }
      </section>
    </div>`,
  styles: [`
    .tbs { display: grid; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); gap: 1rem; }
    h4 { margin: 0 0 .4rem; }
    .tbs-row { display: block; width: 100%; text-align: left; border: 0; border-bottom: 1px solid var(--border); background: none; color: inherit;
      padding: .35rem 0; font-size: .84rem; }
    button.tbs-row { cursor: pointer; }
    button.tbs-row:hover { background: rgba(139,92,246,.07); }
    .tbs-dim { color: var(--text-dim); margin-left: .4rem; }
    .tbs-cols { display: flex; flex-wrap: wrap; gap: .25rem; margin-top: .25rem; }
    .tbs-cols span { padding: 0 .4rem; border-radius: 4px; background: var(--card-inner); font-size: .74rem; }
    .tbs-now { margin-left: .4rem; color: var(--green); font-size: .74rem; }
  `],
})
export class TeamBoardsSprintsComponent {
  readonly state = inject(TeamStateService);
  readonly search = output<TeamSearch>();

  pick(s: TeamSprint): void {
    this.search.emit({ iterations: [s.name], openOnly: true });
  }

  current(s: TeamSprint): boolean {
    const now = Date.now();
    return !!s.starts && !!s.ends && Date.parse(s.starts) <= now && now <= Date.parse(s.ends);
  }
}
