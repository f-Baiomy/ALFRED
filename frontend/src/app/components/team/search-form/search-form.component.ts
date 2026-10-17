import { Component, computed, inject, input, output, signal, effect, untracked } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { TeamStateService } from '../../../core/team/team-state.service';
import { MineSource, SortBy, TeamSearch, normalizeSearch } from '../../../core/team/team.models';
import { MultiSelectPickerComponent } from '../../multi-select-picker/multi-select-picker.component';
import { SelectOption } from '../../select-picker/select-picker.component';

/** "me" as the assigned / created-by value: the backend resolves it to the token owner (or the "This is me" pick). */
export const ME = 'me';
/** Assigned to nobody. */
export const NONE = 'none';
/** The iteration value for each picked team's current sprint. */
export const CURRENT = '@current';

type ListKey = 'types' | 'states' | 'teams' | 'iterations' | 'areas' | 'assigned' | 'createdBy' | 'tags' | 'parents';

/**
 * The Team tab's search (specs/028 US1, specs/029): free text plus filters, every one picking several values from the
 * cached lists (types, states, teams, iterations, areas, people, tags) with the shared multi-select picker. Inside a
 * filter the values are ORed, between filters ANDed - the chip row under the bar reads that way. Open only is on by
 * default. Nothing found is stored - each Search reads the tracker live.
 */
@Component({
  selector: 'app-team-search-form',
  standalone: true,
  imports: [FormsModule, MultiSelectPickerComponent],
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
          <div class="tsf-f"><span class="tsf-l">Type</span>
            <app-multi-select-picker [compact]="true" [searchable]="true" [options]="typeOptions()" [values]="v().types" emptyLabel="Any"
                                     unknownNote="not in the lists" (valuesChange)="set('types', $event)" /></div>
          <div class="tsf-f"><span class="tsf-l">State</span>
            <app-multi-select-picker [compact]="true" [searchable]="true" [options]="stateOptions()" [values]="v().states" emptyLabel="Any"
                                     unknownNote="not in the lists" (valuesChange)="set('states', $event)" /></div>
          <div class="tsf-f"><span class="tsf-l">{{ state.ui().word('squad') }}</span>
            <app-multi-select-picker [compact]="true" [searchable]="true" [options]="teamOptions()" [values]="v().teams" emptyLabel="Any"
                                     unknownNote="not in the lists" (valuesChange)="set('teams', $event)" /></div>
          <div class="tsf-f"><span class="tsf-l">{{ state.ui().word('sprint') }}</span>
            <app-multi-select-picker [compact]="true" [searchable]="true" [options]="iterationOptions()" [values]="v().iterations" emptyLabel="Any"
                                     unknownNote="not in the lists" (valuesChange)="set('iterations', $event)" /></div>
          <div class="tsf-f"><span class="tsf-l">{{ state.ui().word('area') }}
              <button type="button" class="tsf-mode" [class.on]="!areaExact()" (click)="areaExact.set(!areaExact())"
                      [title]="areaExact() ? 'Only the picked area itself (click to include its sub-areas)' : 'The picked area and its sub-areas (click for the area only)'">
                {{ areaExact() ? '= area only' : '⊂ sub-areas' }}</button></span>
            <app-multi-select-picker [compact]="true" [searchable]="true" [options]="areaOptions()" [values]="v().areas" emptyLabel="Any"
                                     unknownNote="not in the lists" (valuesChange)="set('areas', $event)" /></div>
          <div class="tsf-f"><span class="tsf-l">Assigned to</span>
            <app-multi-select-picker [compact]="true" [searchable]="true" [options]="assignedOptions()" [values]="v().assigned" emptyLabel="Anyone"
                                     [allowCustom]="true" [custom]="isPerson" unknownNote="not in the people list" (valuesChange)="set('assigned', $event)" /></div>
          <div class="tsf-f"><span class="tsf-l">Created by</span>
            <app-multi-select-picker [compact]="true" [searchable]="true" [options]="createdOptions()" [values]="v().createdBy" emptyLabel="Anyone"
                                     [allowCustom]="true" [custom]="isPerson" unknownNote="not in the people list" (valuesChange)="set('createdBy', $event)" /></div>
          <div class="tsf-f"><span class="tsf-l">Tags
              <button type="button" class="tsf-mode" [class.on]="tagsAll()" (click)="tagsAll.set(!tagsAll())"
                      [title]="tagsAll() ? 'Every picked tag must be there (click for any one)' : 'Any one of the picked tags (click for all of them)'">
                {{ tagsAll() ? 'all' : 'any' }}</button></span>
            <app-multi-select-picker [compact]="true" [searchable]="true" [options]="tagOptions()" [values]="v().tags" emptyLabel="Any"
                                     [allowCustom]="true" unknownNote="typed" (valuesChange)="set('tags', $event)" /></div>
          <div class="tsf-f"><span class="tsf-l">Under parent</span>
            <app-multi-select-picker [compact]="true" [searchable]="true" [options]="parentOptions()" [values]="v().parents" emptyLabel="Any"
                                     [allowCustom]="true" [custom]="isId" unknownNote="typed" (valuesChange)="set('parents', $event)" /></div>
          <label class="tsf-f"><span class="tsf-l">Changed within</span>
            <select [(ngModel)]="changedWithinDays" name="changed" (ngModelChange)="recount()" [class.tsf-any]="!changedWithinDays">
              <option [ngValue]="null">Any time</option>
              @for (d of [1, 3, 7, 14, 30, 90]; track d) { <option [ngValue]="d">{{ d }} day{{ d > 1 ? 's' : '' }}</option> }
            </select>
          </label>
          <label class="tsf-f"><span class="tsf-l">Sort</span>
            <select [(ngModel)]="sort" name="sort">
              <option value="CHANGED">Last changed</option>
              <option value="ID">Id</option>
              <option value="PRIORITY">Priority</option>
            </select>
          </label>
        </div>
      }
      @if (chips().length) {
        <div class="tsf-chips" aria-label="Filters in use">
          @for (c of chips(); track c.key) {
            <span class="tsf-chip"><b>{{ c.label }}:</b>
              @for (x of c.values; track $index; let last = $last) { {{ x }}@if (!last) { <span class="tsf-or">{{ c.join }}</span> } }
              <button type="button" class="tsf-x" (click)="drop(c.key)" [attr.aria-label]="'Remove the ' + c.label + ' filter'">×</button></span>
          }
          <span class="tsf-hint">values inside a filter are OR, filters are AND</span>
        </div>
      }
    </form>`,
  styles: [`
    .tsf { margin: .3rem 0 .6rem; }
    .tsf-main { display: flex; flex-wrap: wrap; gap: .4rem; align-items: center; }
    .tsf-text { flex: 1 1 260px; min-width: 0; padding: .35rem .55rem; border: 1px solid var(--border-strong); border-radius: 7px; background: var(--card-inner); color: inherit; }
    .tsf-check { font-size: .82rem; display: inline-flex; gap: .25rem; align-items: center; }
    .tsf-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); gap: .55rem .8rem; align-items: start; margin-top: .5rem;
      padding: .6rem; border: 1px solid var(--border); border-radius: 8px; }
    .tsf-f { display: grid; gap: .2rem; align-content: start; min-width: 0; font-size: .76rem; color: var(--text-dim); }
    .tsf-l { display: flex; align-items: center; gap: .35rem; min-height: 1.2rem; }
    .tsf-mode { margin-left: auto; border: 1px solid var(--border); border-radius: 4px; background: none; color: var(--text-faint); font-size: .66rem;
      padding: 0 .3rem; cursor: pointer; }
    .tsf-mode.on { color: var(--blue, #8fb2f7); border-color: color-mix(in srgb, var(--blue, #8fb2f7) 45%, transparent); }
    .tsf-f app-multi-select-picker { display: block; min-width: 0; }
    /* the picker fills its column like the selects beside it; its own caret only (the select-picker's ::after is a second one) */
    .tsf-f ::ng-deep .multi-picker { display: flex; width: 100%; }
    .tsf-f ::ng-deep .multi-picker-btn { box-sizing: border-box; width: 100%; min-height: 2rem; padding: .25rem .5rem; border: 1px solid var(--border-strong);
      border-radius: 6px; background: var(--card-inner); color: var(--text); font-size: .82rem; font-weight: 400; }
    .tsf-f ::ng-deep .multi-picker-btn::after { display: none; }
    .tsf-f ::ng-deep .multi-picker-empty { font-style: normal; color: var(--text-dim); }
    .tsf-f ::ng-deep .multi-picker-caret { font-size: .7rem; }
    .tsf-f select.tsf-any { color: var(--text-dim); }
    .tsf-f select { box-sizing: border-box; width: 100%; min-width: 0; height: 2rem; margin: 0; padding: .25rem .45rem; border: 1px solid var(--border-strong);
      border-radius: 6px; background: var(--card-inner); color: var(--text); font: inherit; font-size: .82rem; }
    .tsf-chips { display: flex; flex-wrap: wrap; gap: .35rem; align-items: center; margin-top: .5rem; }
    .tsf-chip { display: inline-flex; flex-wrap: wrap; gap: .25rem; align-items: center; max-width: 100%; padding: .05rem .2rem .05rem .55rem;
      border: 1px solid var(--border-strong); border-radius: 14px; background: var(--card-inner); font-size: .74rem; }
    .tsf-chip b { font-weight: 500; color: var(--text-dim); }
    .tsf-or { color: var(--text-faint); font-size: .66rem; }
    .tsf-x { border: 0; background: none; color: var(--text-faint); cursor: pointer; padding: 0 .3rem; font-size: .9rem; line-height: 1; }
    .tsf-x:hover { color: var(--text); }
    .tsf-hint { color: var(--text-faint); font-size: .7rem; }
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

  /** Every multi-value filter, as one signal so the pickers and chips stay in step. */
  readonly v = signal<Record<ListKey, string[]>>(empty());
  readonly areaExact = signal(false);
  readonly tagsAll = signal(false);

  text = '';
  openOnly = true;
  changedWithinDays: number | null = null;
  sort: SortBy = 'CHANGED';
  mine: MineSource[] = [];

  readonly count = signal(0);

  readonly isPerson = (s: string): boolean => s.length <= 200;
  readonly isId = (s: string): boolean => /^#?\d{1,9}$/.test(s);

  private readonly plain = (xs: readonly string[] | undefined): SelectOption[] => (xs ?? []).map((x) => ({ value: x, label: x }));
  readonly typeOptions = computed(() => this.plain(this.lists()?.types));
  readonly stateOptions = computed(() => this.plain([...new Set((this.lists()?.states ?? []).map((s) => s.name))].sort()));
  readonly teamOptions = computed<SelectOption[]>(() => (this.lists()?.teams ?? []).map((t) => ({ value: this.teamValue(t), label: t.name })));
  readonly iterationOptions = computed<SelectOption[]>(() => [
    { value: CURRENT, label: 'Current (each picked ' + this.state.ui().word('squad').toLowerCase() + ')' },
    ...this.plain([...new Set((this.lists()?.iterations ?? []).map((i) => i.name))]),
  ]);
  readonly areaOptions = computed(() => this.plain(this.lists()?.areas));
  private readonly people = computed<SelectOption[]>(() => {
    const seen = new Set<string>();
    const out: SelectOption[] = [];
    for (const p of this.lists()?.people ?? []) {
      const value = p.email ?? p.extId ?? p.name;
      if (!value || seen.has(value)) continue;
      seen.add(value);
      out.push({ value, label: p.name });
    }
    return out.sort((a, b) => a.label.localeCompare(b.label));
  });
  readonly assignedOptions = computed<SelectOption[]>(() => [{ value: ME, label: 'me' }, { value: NONE, label: 'Unassigned' }, ...this.people()]);
  readonly createdOptions = computed<SelectOption[]>(() => [{ value: ME, label: 'me' }, ...this.people()]);
  readonly tagOptions = computed(() => this.plain(this.lists()?.tags));
  /** Ids already picked stay listed; others are typed. */
  readonly parentOptions = computed(() => this.plain(this.v().parents));

  /** One chip per filter in use, in the words of its picker. */
  readonly chips = computed(() => {
    const v = this.v();
    this.count(); // the single-value filters are plain fields: re-read when the count says something changed
    const label = (opts: SelectOption[], x: string) => opts.find((o) => o.value === x)?.label ?? x;
    const ui = this.state.ui();
    const rows: { key: ListKey | 'changed'; label: string; values: string[]; join: string }[] = [];
    const add = (key: ListKey, name: string, opts: SelectOption[], join = 'or') => {
      if (v[key].length) rows.push({ key, label: name, values: v[key].map((x) => label(opts, x)), join });
    };
    add('types', 'Type', this.typeOptions());
    add('states', 'State', this.stateOptions());
    add('teams', ui.word('squad'), this.teamOptions());
    add('iterations', ui.word('sprint'), this.iterationOptions());
    add('areas', ui.word('area') + (this.areaExact() ? ' (only)' : ''), this.areaOptions());
    add('assigned', 'Assigned', this.assignedOptions());
    add('createdBy', 'Created by', this.createdOptions());
    add('tags', 'Tags', this.tagOptions(), this.tagsAll() ? 'and' : 'or');
    add('parents', 'Under', this.parentOptions());
    if (this.changedWithinDays) {
      rows.push({ key: 'changed', label: 'Changed', values: ['last ' + this.changedWithinDays + ' day' + (this.changedWithinDays > 1 ? 's' : '')], join: '' });
    }
    return rows;
  });

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

  set(key: ListKey, values: readonly string[]): void {
    const clean = key === 'parents' ? values.map((x) => x.replace('#', '')) : [...values];
    this.v.update((v) => ({ ...v, [key]: clean }));
    this.recount();
  }

  drop(key: ListKey | 'changed'): void {
    if (key === 'changed') this.changedWithinDays = null;
    else this.set(key, []);
    this.run();
  }

  recount(): void {
    this.count.set(this.filterCount());
  }

  fill(raw: TeamSearch): void {
    const p = normalizeSearch(raw);
    this.text = p.text ?? '';
    this.openOnly = p.openOnly ?? true;
    this.v.set({
      types: [...(p.types ?? [])], states: [...(p.states ?? [])], teams: [...(p.teams ?? [])], iterations: [...(p.iterations ?? [])],
      areas: [...(p.areas ?? [])], assigned: [...(p.assigned ?? [])], createdBy: [...(p.createdBy ?? [])], tags: [...(p.tags ?? [])],
      parents: [...(p.parents ?? [])],
    });
    this.areaExact.set(!!p.areaExact);
    this.tagsAll.set(!!p.tagsAll);
    this.changedWithinDays = p.changedWithinDays ?? null;
    this.sort = p.sort ?? 'CHANGED';
    this.mine = [...(p.mine ?? [])];
    if (this.filterCount() > 0) this.more.set(true);
  }

  value(): TeamSearch {
    const v = this.v();
    return {
      text: this.text.trim() || null,
      openOnly: this.openOnly,
      types: v.types,
      states: v.states,
      teams: v.teams,
      iterations: v.iterations,
      areas: v.areas,
      areaExact: this.areaExact(),
      assigned: v.assigned,
      createdBy: v.createdBy,
      changedWithinDays: this.changedWithinDays,
      tags: v.tags,
      tagsAll: this.tagsAll(),
      parents: v.parents,
      mine: this.mine,
      sort: this.sort,
      page: 0,
    };
  }

  private filterCount(): number {
    const v = this.v();
    return (Object.keys(v) as ListKey[]).filter((k) => v[k].length).length + (this.changedWithinDays ? 1 : 0) + this.mine.length;
  }

  run(): void {
    this.recount();
    this.search.emit(this.value());
  }

  clear(): void {
    this.fill({ text: this.text });
    this.run();
  }
}

function empty(): Record<ListKey, string[]> {
  return { types: [], states: [], teams: [], iterations: [], areas: [], assigned: [], createdBy: [], tags: [], parents: [] };
}
