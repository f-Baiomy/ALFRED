import { Component, computed, effect, inject, signal, untracked } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { FormsModule } from '@angular/forms';
import { catchError, map, of } from 'rxjs';
import { BoardApiService } from '../../../core/services/board-api.service';
import { DbCaptureApiService } from '../../../core/services/db-capture-api.service';
import { TeamApiService } from '../../../core/team/team-api.service';
import { TeamStateService } from '../../../core/team/team-state.service';
import { TeamSquad } from '../../../core/team/team.models';
import { Team } from '../../../core/models/board.models';

/**
 * The tracker's squads and their members (specs/027 US7), each mapped to an Alfred project and board team: a work item
 * of that squad opens its board in that project, and its cards go to that team. Shared by everyone.
 */
@Component({
  selector: 'app-team-squads',
  standalone: true,
  imports: [FormsModule],
  template: `
    @if (message()) { <div class="tsq-msg">{{ message() }}</div> }
    <table class="tsq">
      <thead><tr><th>{{ state.ui().word('squad') }}</th><th>Members</th><th>Alfred project</th><th>Board team</th></tr></thead>
      <tbody>
        @for (s of squads(); track s.extId) {
          <tr>
            <td><b>{{ s.name }}</b> @if (s.project) { <span class="tsq-dim">{{ s.project }}</span> }</td>
            <td class="tsq-members">{{ s.members.join(', ') || '-' }}</td>
            <td>
              <select [ngModel]="s.alfredProject ?? ''" (ngModelChange)="map(s, $event || null, s.alfredTeam)" aria-label="Alfred project">
                <option value="">Not mapped</option>
                @for (p of projects(); track p) { <option [value]="p">{{ p }}</option> }
              </select>
            </td>
            <td>
              <select [ngModel]="s.alfredTeam ?? ''" (ngModelChange)="map(s, s.alfredProject, $event || null)" aria-label="Board team">
                <option value="">None</option>
                @for (t of teams(); track t.id) { <option [value]="t.id">{{ t.icon }} {{ t.name }}</option> }
              </select>
            </td>
          </tr>
        } @empty {
          <tr><td colspan="4" class="tsq-dim">No {{ state.ui().word('squad').toLowerCase() }}s in the cache - Refresh fetches them.</td></tr>
        }
      </tbody>
    </table>`,
  styles: [`
    .tsq { width: 100%; border-collapse: collapse; font-size: .84rem; }
    .tsq th, .tsq td { padding: .35rem .5rem; border-bottom: 1px solid var(--border); text-align: left; vertical-align: top; }
    .tsq select { padding: .2rem .4rem; border: 1px solid var(--border-strong); border-radius: 6px; background: var(--card-inner); color: inherit; }
    .tsq-dim { color: var(--text-dim); margin-left: .3rem; }
    .tsq-members { color: var(--text-dim); max-width: 360px; }
    .tsq-msg { color: var(--red); font-size: .82rem; margin-bottom: .4rem; }
  `],
})
export class TeamSquadsComponent {
  readonly state = inject(TeamStateService);
  private readonly api = inject(TeamApiService);
  private readonly board = inject(BoardApiService);
  private readonly db = inject(DbCaptureApiService);

  readonly squads = signal<TeamSquad[]>([]);
  readonly message = signal<string | null>(null);
  readonly projects = toSignal(this.db.projects().pipe(map((ps) => ps.map((p) => p.project)), catchError(() => of([] as string[]))),
    { initialValue: [] as string[] });
  readonly teams = toSignal(this.board.teams().pipe(catchError(() => of([] as Team[]))), { initialValue: [] as Team[] });
  readonly conn = computed(() => this.state.picked()?.id ?? null);

  constructor() {
    effect(() => {
      const conn = this.conn();
      this.state.squadsVersion();
      untracked(() => {
        if (conn) this.api.squads(conn).subscribe({ next: (s) => this.squads.set(s), error: () => undefined });
      });
    });
  }

  map(s: TeamSquad, project: string | null, team: string | null): void {
    this.message.set(null);
    this.api.mapSquad(s.conn, s.extId, project, team).subscribe({
      next: (saved) => this.squads.update((all) => all.map((x) => (x.extId === saved.extId ? saved : x))),
      error: (e) => this.message.set(e?.error?.message || 'Could not save the mapping'),
    });
  }
}
