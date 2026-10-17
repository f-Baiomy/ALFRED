import { Component, computed, inject, output, signal } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { FormsModule } from '@angular/forms';
import { catchError, map, of } from 'rxjs';
import { BoardApiService } from '../../../core/services/board-api.service';
import { DbCaptureApiService } from '../../../core/services/db-capture-api.service';
import { TeamApiService } from '../../../core/team/team-api.service';
import { TeamStateService } from '../../../core/team/team-state.service';
import { TeamPerson, TeamSearch, TeamSquad } from '../../../core/team/team.models';
import { Team } from '../../../core/models/board.models';
import { PersonPillComponent } from '../person-pill/person-pill.component';

/**
 * The tracker's teams and their members, from the cached lists (specs/028 FR-016, FR-085): a team or a member clicked
 * runs a search for their open items. Each team maps to an Alfred project and board team: a work item of that team opens
 * its board in that project, and its cards go to that team. Shared by everyone.
 */
@Component({
  selector: 'app-team-squads',
  standalone: true,
  imports: [FormsModule, PersonPillComponent],
  template: `
    @if (message()) { <div class="tsq-msg">{{ message() }}</div> }
    <table class="tsq">
      <thead><tr><th>{{ state.ui().word('squad') }}</th><th>Members</th><th>Alfred project</th><th>Board team</th></tr></thead>
      <tbody>
        @for (s of squads(); track s.extId) {
          <tr>
            <td><button type="button" class="tsq-link" (click)="searchTeam(s)" title="Search this team's open items"><b>{{ s.name }}</b></button>
              @if (s.project) { <span class="tsq-dim">{{ s.project }}</span> }</td>
            <td class="tsq-members">
              @for (m of s.members; track $index) {
                <button type="button" class="tsq-pill" (click)="searchPerson(m)" title="Search items assigned to them"><app-person-pill [person]="m" [conn]="s.conn" /></button>
              } @empty { <span class="tsq-dim">-</span> }
            </td>
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
          <tr><td colspan="4" class="tsq-dim">No {{ state.ui().word('squad').toLowerCase() }}s read yet - Refresh lists reads them.</td></tr>
        }
      </tbody>
    </table>`,
  styles: [`
    .tsq { width: 100%; border-collapse: collapse; font-size: .84rem; }
    .tsq th, .tsq td { padding: .35rem .5rem; border-bottom: 1px solid var(--border); text-align: left; vertical-align: top; }
    .tsq select { padding: .2rem .4rem; border: 1px solid var(--border-strong); border-radius: 6px; background: var(--card-inner); color: inherit; }
    .tsq-dim { color: var(--text-dim); margin-left: .3rem; }
    .tsq-members { max-width: 460px; }
    .tsq-link, .tsq-pill { border: 0; background: none; color: inherit; padding: 0; cursor: pointer; margin: 0 .15rem .15rem 0; }
    .tsq-msg { color: var(--red); font-size: .82rem; margin-bottom: .4rem; }
  `],
})
export class TeamSquadsComponent {
  readonly state = inject(TeamStateService);
  private readonly api = inject(TeamApiService);
  private readonly board = inject(BoardApiService);
  private readonly db = inject(DbCaptureApiService);

  readonly search = output<TeamSearch>();
  readonly message = signal<string | null>(null);
  /** Mappings saved here before the lists are read again. */
  private readonly saved = signal<Record<string, TeamSquad>>({});
  readonly squads = computed(() => (this.state.lists()?.teams ?? []).map((s) => this.saved()[s.extId] ?? s));
  readonly projects = toSignal(this.db.projects().pipe(map((ps) => ps.map((p) => p.project)), catchError(() => of([] as string[]))),
    { initialValue: [] as string[] });
  readonly teams = toSignal(this.board.teams().pipe(catchError(() => of([] as Team[]))), { initialValue: [] as Team[] });

  searchTeam(s: TeamSquad): void {
    const bs = String.fromCharCode(92);
    this.search.emit({ teams: [s.project && !s.name.includes(bs) ? s.project + bs + s.name : s.name], openOnly: true });
  }

  searchPerson(p: TeamPerson): void {
    const who = p.email ?? p.extId;
    if (who) this.search.emit({ assigned: who, openOnly: true });
  }

  map(s: TeamSquad, project: string | null, team: string | null): void {
    this.message.set(null);
    this.api.mapSquad(s.conn, s.extId, project, team).subscribe({
      next: (got) => this.saved.update((all) => ({ ...all, [got.extId]: got })),
      error: (e) => this.message.set(e?.error?.message || 'Could not save the mapping'),
    });
  }
}
