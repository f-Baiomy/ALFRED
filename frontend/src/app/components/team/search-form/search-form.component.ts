import { Component, computed, inject, input, output, signal, effect, untracked } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { TeamStateService } from '../../../core/team/team-state.service';
import { MineSource, SortBy, TeamSearch } from '../../../core/team/team.models';

/** "me" as the assigned / created-by value: the backend resolves it to the token owner (or the "This is me" pick). */
export const ME = 'me';
/** The iteration value for each team's current sprint. */
export const CURRENT = '@current';

/**
 * The Team tab's search (specs/028 US1, FR-010..016): free text plus filter chips, every one read from the cached lists
 * (types, states, areas, teams, iterations, people). Open only is on by default. Nothing found is stored - each Search
 * reads the tracker live.
 */
@Component({
  selector: 'app-team-search-form',
  standalone: true,
  imports: [FormsModule],
  template: `
    <form class="tsf" (submit)="$event.preventDefault(); run()" role="search" aria-label="Search work items">
      <div class="tsf-main">
        <input class="tsf-text" type="search" [(ngModel)]="text" name="text" placeholder="Search title, description, comments… or an id / URL"
               aria-label="Search text" />
        <button type="submit" class="action-btn primary" [disabled]="busy()">{{ busy() ? 'Searching…' : 'Search' }}</button>
        <label class="tsf-check"><input type="checkbox" [(ngModel)]="openOnly" name="openOnly" (ngModelChange)="run()" /> Open only</label>
        <button type="button" class="action-btn" (click)="more.set(!more())" [attr.aria-expanded]="more()">Filters{{ count() ? ' (' + count() + ')' : '' }} ▾</button>
        @if (count()) { <button type="button" class="action-btn" (click)="clear()">Clear</button> }
      </div>
      @if (more()) {
        <div class="tsf-grid">
          <label>Type
            <select multiple [(ngModel)]="types" name="types" size="4">
              @for (t of lists()?.types ?? []; track t) { <option [value]="t">{{ t }}</option> }
            </select>
          </label>
          <label>State
            <select multiple [(ngModel)]="states" name="states" size="4">
              @for (s of stateNames(); track s) { <option [value]="s">{{ s }}</option> }
            </select>
          </label>
          <label>{{ state.ui().word('squad') }}
            <select [(ngModel)]="team" name="team">
              <option value="">Any</option>
              @for (t of lists()?.teams ?? []; track t.extId) { <option [value]="teamValue(t)">{{ t.name }}</option> }
            </select>
          </label>
          <label>{{ state.ui().word('sprint') }}
            <select [(ngModel)]="iteration" name="iteration">
              <option value="">Any</option>
              <option [value]="CURRENT">Current ({{ CURRENT }})</option>
              @for (i of lists()?.iterations ?? []; track i.extId) { <option [value]="i.name">{{ i.name }}</option> }
            </select>
          </label>
          <label>{{ state.ui().word('area') }}
            <select [(ngModel)]="area" name="area">
              <option value="">Any</option>
              @for (a of lists()?.areas ?? []; track a) { <option [value]="a">{{ a }}</option> }
            </select>
          </label>
          <label>Assigned to
            <select [(ngModel)]="assigned" name="assigned">
              <option value="">Anyone</option>
              <option [value]="ME">me</option>
              @for (p of lists()?.people ?? []; track $index) { <option [value]="p.email ?? p.extId">{{ p.name }}</option> }
            </select>
          </label>
          <label>Created by
            <select [(ngModel)]="createdBy" name="createdBy">
              <option value="">Anyone</option>
              <option [value]="ME">me</option>
              @for (p of lists()?.people ?? []; track $index) { <option [value]="p.email ?? p.extId">{{ p.name }}</option> }
            </select>
          </label>
          <label>Changed within
            <select [(ngModel)]="changedWithinDays" name="changed">
              <option [ngValue]="null">Any time</option>
              @for (d of [1, 3, 7, 14, 30, 90]; track d) { <option [ngValue]="d">{{ d }} day{{ d > 1 ? 's' : '' }}</option> }
            </select>
          </label>
          <label>Tags <input [(ngModel)]="tags" name="tags" placeholder="comma separated" /></label>
          <label>Under parent <input [(ngModel)]="parent" name="parent" placeholder="id" inputmode="numeric" /></label>
          <label>Sort
            <select [(ngModel)]="sort" name="sort">
              <option value="CHANGED">Last changed</option>
              <option value="ID">Id</option>
              <option value="PRIORITY">Priority</option>
            </select>
          </label>
        </div>
      }
    </form>`,
  styles: [`
    .tsf { margin: .3rem 0 .6rem; }
    .tsf-main { display: flex; flex-wrap: wrap; gap: .4rem; align-items: center; }
    .tsf-text { flex: 1 1 280px; padding: .35rem .55rem; border: 1px solid var(--border-strong); border-radius: 7px; background: var(--card-inner); color: inherit; }
    .tsf-check { font-size: .82rem; display: inline-flex; gap: .25rem; align-items: center; }
    .tsf-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(190px, 1fr)); gap: .5rem .8rem; align-items: start; margin-top: .5rem;
      padding: .6rem; border: 1px solid var(--border); border-radius: 8px; }
    /* a label never stretches its control to the row's height (the multi-selects make the row tall), and a long option
       (an iteration path, a person's name) never pushes the control past its column */
    .tsf-grid label { display: grid; gap: .2rem; align-content: start; min-width: 0; font-size: .76rem; color: var(--text-dim); }
    .tsf-grid select, .tsf-grid input { box-sizing: border-box; width: 100%; min-width: 0; height: auto; margin: 0; padding: .3rem .45rem;
      border: 1px solid var(--border-strong); border-radius: 6px; background: var(--card-inner); color: var(--text); font: inherit;
      font-size: .82rem; line-height: 1.3; text-overflow: ellipsis; }
    .tsf-grid select:not([multiple]) { height: 2rem; }
    .tsf-grid select[multiple] { padding: .2rem; }
    .tsf-grid select[multiple] option { padding: .1rem .3rem; border-radius: 4px; }
  `],
})
export class TeamSearchFormComponent {
  readonly state = inject(TeamStateService);
  readonly ME = ME;
  readonly CURRENT = CURRENT;

  /** A search set from outside (a browser click, ?q= on the URL): fills the form and runs. */
  readonly preset = input<TeamSearch | null>(null);
  readonly busy = input(false);
  readonly search = output<TeamSearch>();

  readonly more = signal(false);
  readonly lists = this.state.lists;
  readonly stateNames = computed(() => [...new Set((this.lists()?.states ?? []).map((s) => s.name))].sort());

  text = '';
  openOnly = true;
  types: string[] = [];
  states: string[] = [];
  team = '';
  iteration = '';
  area = '';
  assigned = '';
  createdBy = '';
  changedWithinDays: number | null = null;
  tags = '';
  parent = '';
  sort: SortBy = 'CHANGED';
  mine: MineSource[] = [];

  readonly count = signal(0);

  constructor() {
    effect(() => {
      const p = this.preset();
      if (p) untracked(() => { this.fill(p); this.run(); });
    });
  }

  /** Teams are matched as "Project\Team". */
  teamValue(t: { name: string; project: string | null }): string {
    return t.project && !t.name.includes(String.fromCharCode(92)) ? t.project + String.fromCharCode(92) + t.name : t.name;
  }

  fill(p: TeamSearch): void {
    this.text = p.text ?? '';
    this.openOnly = p.openOnly ?? true;
    this.types = [...(p.types ?? [])];
    this.states = [...(p.states ?? [])];
    this.team = p.teams?.[0] ?? '';
    this.iteration = p.iterations?.[0] ?? '';
    this.area = p.areas?.[0] ?? '';
    this.assigned = p.assigned ?? '';
    this.createdBy = p.createdBy ?? '';
    this.changedWithinDays = p.changedWithinDays ?? null;
    this.tags = (p.tags ?? []).join(', ');
    this.parent = p.parent ?? '';
    this.sort = p.sort ?? 'CHANGED';
    this.mine = [...(p.mine ?? [])];
    if (this.filterCount() > 0) this.more.set(true);
  }

  value(): TeamSearch {
    const tags = this.tags.split(',').map((t) => t.trim()).filter(Boolean);
    return {
      text: this.text.trim() || null,
      openOnly: this.openOnly,
      types: this.types,
      states: this.states,
      teams: this.team ? [this.team] : [],
      iterations: this.iteration ? [this.iteration] : [],
      areas: this.area ? [this.area] : [],
      assigned: this.assigned || null,
      createdBy: this.createdBy || null,
      changedWithinDays: this.changedWithinDays,
      tags,
      parent: this.parent.trim() || null,
      mine: this.mine,
      sort: this.sort,
      page: 0,
    };
  }

  private filterCount(): number {
    return this.types.length + this.states.length + (this.team ? 1 : 0) + (this.iteration ? 1 : 0) + (this.area ? 1 : 0) +
      (this.assigned ? 1 : 0) + (this.createdBy ? 1 : 0) + (this.changedWithinDays ? 1 : 0) + (this.tags.trim() ? 1 : 0) +
      (this.parent.trim() ? 1 : 0) + this.mine.length;
  }

  run(): void {
    this.count.set(this.filterCount());
    this.search.emit(this.value());
  }

  clear(): void {
    this.fill({ text: this.text });
    this.run();
  }
}
