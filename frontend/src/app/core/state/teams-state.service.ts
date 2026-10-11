import { Injectable, Injector, computed, inject, signal } from '@angular/core';
import { Observable, tap } from 'rxjs';
import { Team, TeamEdit } from '../models/board.models';
import { BoardApiService } from '../services/board-api.service';

/**
 * The teams cards are assigned to (Settings → Teams), loaded once and kept here for every board, card and the
 * Settings page. Reloaded after each edit made here; a card naming a team that was deleted simply shows no chip for it.
 */
@Injectable({ providedIn: 'root' })
export class TeamsStateService {
  // Resolved on first use: a component that only shows team names (the history) must not need HTTP to be created.
  private readonly injector = inject(Injector);
  private get api(): BoardApiService {
    return this.injector.get(BoardApiService);
  }
  readonly teams = signal<readonly Team[]>([]);
  readonly error = signal<string | null>(null);
  private loaded = false;

  readonly byId = computed(() => new Map(this.teams().map((t) => [t.id, t])));

  /** Loads the teams the first time anything asks; later calls do nothing unless forced. */
  load(force = false): void {
    if (this.loaded && !force) return;
    this.loaded = true;
    this.api.teams().subscribe({ next: (t) => this.teams.set(t), error: () => (this.loaded = false) });
  }

  /** The teams of a card, in the user's order, skipping ids that are not teams any more. */
  of(ids: readonly string[] | undefined): Team[] {
    const map = this.byId();
    return (ids ?? []).map((id) => map.get(id)).filter((t): t is Team => !!t).sort((a, b) => a.position - b.position);
  }

  save(id: string | null, edit: TeamEdit): Observable<Team> {
    return (id ? this.api.updateTeam(id, edit) : this.api.createTeam(edit)).pipe(tap(() => this.load(true)));
  }

  delete(id: string): Observable<void> {
    return this.api.deleteTeam(id).pipe(tap(() => this.load(true)));
  }

  reorder(ids: readonly string[]): Observable<Team[]> {
    return this.api.reorderTeams(ids).pipe(tap((t) => this.teams.set(t)));
  }
}
