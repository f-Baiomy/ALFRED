import { Component, effect, inject, signal, untracked } from '@angular/core';
import { TeamApiService } from '../../../core/team/team-api.service';
import { TeamStateService } from '../../../core/team/team-state.service';
import { TeamBoard, TeamSprint } from '../../../core/team/team.models';

/** The tracker's own boards (with their columns) and sprints, read from the cache (specs/027 US7). */
@Component({
  selector: 'app-team-boards-sprints',
  standalone: true,
  template: `
    <div class="tbs">
      @if (state.picked()?.capabilities?.includes('BOARDS')) {
        <section>
          <h4>Boards</h4>
          @for (b of boards(); track b.extId) {
            <div class="tbs-row"><b>{{ b.name }}</b> <span class="tbs-dim">{{ b.team || b.project }}</span>
              <div class="tbs-cols">@for (c of b.columns; track c) { <span>{{ c }}</span> }</div></div>
          } @empty { <div class="tbs-dim">No boards in the cache</div> }
        </section>
      }
      @if (state.picked()?.capabilities?.includes('SPRINTS')) {
        <section>
          <h4>{{ state.ui().word('sprint') }}s</h4>
          @for (s of sprints(); track s.extId) {
            <div class="tbs-row" [class.now]="current(s)"><b>{{ s.name }}</b> <span class="tbs-dim">{{ s.team }}</span>
              <span class="tbs-dim">{{ s.starts?.slice(0, 10) }} → {{ s.ends?.slice(0, 10) }}</span>
              @if (current(s)) { <span class="tbs-now">current</span> }</div>
          } @empty { <div class="tbs-dim">No {{ state.ui().word('sprint').toLowerCase() }}s in the cache</div> }
        </section>
      }
    </div>`,
  styles: [`
    .tbs { display: grid; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); gap: 1rem; }
    h4 { margin: 0 0 .4rem; }
    .tbs-row { padding: .35rem 0; border-bottom: 1px solid var(--border); font-size: .84rem; }
    .tbs-dim { color: var(--text-dim); margin-left: .4rem; }
    .tbs-cols { display: flex; flex-wrap: wrap; gap: .25rem; margin-top: .25rem; }
    .tbs-cols span { padding: 0 .4rem; border-radius: 4px; background: var(--card-inner); font-size: .74rem; }
    .tbs-now { margin-left: .4rem; color: var(--green); font-size: .74rem; }
  `],
})
export class TeamBoardsSprintsComponent {
  readonly state = inject(TeamStateService);
  private readonly api = inject(TeamApiService);
  readonly boards = signal<TeamBoard[]>([]);
  readonly sprints = signal<TeamSprint[]>([]);

  constructor() {
    effect(() => {
      const c = this.state.picked();
      this.state.itemsVersion();
      untracked(() => {
        if (!c) return;
        if (c.capabilities.includes('BOARDS')) this.api.boards(c.id).subscribe({ next: (b) => this.boards.set(b), error: () => undefined });
        if (c.capabilities.includes('SPRINTS')) this.api.sprints(c.id).subscribe({ next: (s) => this.sprints.set(s), error: () => undefined });
      });
    });
  }

  current(s: TeamSprint): boolean {
    const now = Date.now();
    return !!s.starts && !!s.ends && Date.parse(s.starts) <= now && now <= Date.parse(s.ends);
  }
}
