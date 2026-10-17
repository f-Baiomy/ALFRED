import { Component, ElementRef, Injector, afterNextRender, effect, inject, input, output, signal, untracked } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { TeamApiService } from '../../../core/team/team-api.service';
import { TeamStateService } from '../../../core/team/team-state.service';
import { SavedSearch, TeamSearch } from '../../../core/team/team.models';

/**
 * Saved searches as pills (specs/029): one click runs one, ⋯ edits, renames, moves or deletes it, and the bar under the
 * pills saves the search on screen under a name, or saves the changes to the one being edited. Kept in Alfred, so every
 * browser shows the same pills; the list is read again on the "saved" signal (no polling).
 */
@Component({
  selector: 'app-team-saved-searches',
  standalone: true,
  imports: [FormsModule],
  template: `
    @if (list().length) {
      <div class="tss" role="toolbar" aria-label="Saved searches">
        <span class="tss-l">Saved</span>
        @for (s of list(); track s.id; let i = $index; let last = $last) {
          <span class="tss-pill" [class.on]="lit() === s.id && !changed()" [class.editing]="editing() === s.id" [class.open]="menu() === s.id">
            @if (renaming() === s.id) {
              <form class="tss-rename" (submit)="$event.preventDefault(); rename(s)">
                <input [(ngModel)]="newName" name="rename" maxlength="80" aria-label="New name" (keydown.escape)="renaming.set(null)" />
                <button type="submit" class="tss-x" aria-label="Save the name">✓</button>
              </form>
            } @else {
              <button type="button" class="tss-run" (click)="run.emit(s)" [title]="'Run ' + s.name">
                {{ s.name }}@if (lit() === s.id && changed()) { <span class="tss-dot" title="Changed since it was saved">●</span> }
                @if (s.lastCount !== null) { <span class="tss-n">{{ s.lastCount }}</span> }
              </button>
            }
            <button type="button" class="tss-more" (click)="menu.set(menu() === s.id ? null : s.id)" aria-haspopup="menu" [attr.aria-expanded]="menu() === s.id"
                    [attr.aria-label]="'More for ' + s.name">⋯</button>
            @if (menu() === s.id) {
              <span class="tss-menu" role="menu">
                <button type="button" role="menuitem" (click)="menu.set(null); edit.emit(s)">✎ Edit filters</button>
                <button type="button" role="menuitem" (click)="startRename(s)">Rename…</button>
                @if (i > 0) { <button type="button" role="menuitem" (click)="move(s, -1)">← Move left</button> }
                @if (!last) { <button type="button" role="menuitem" (click)="move(s, 1)">Move right →</button> }
                <hr />
                @if (deleting() === s.id) {
                  <span class="tss-ask">Delete "{{ s.name }}"?
                    <button type="button" class="tss-danger" (click)="remove(s)">Delete</button>
                    <button type="button" (click)="deleting.set(null)">Keep</button></span>
                } @else {
                  <button type="button" role="menuitem" class="tss-danger" (click)="deleting.set(s.id)">Delete…</button>
                }
              </span>
            }
          </span>
        }
      </div>
    }
    @if (saving()) {
      <form class="tss-bar" (submit)="$event.preventDefault(); create()">
        <b>Save this search</b>
        <input [(ngModel)]="name" name="name" maxlength="80" placeholder="Name, e.g. My open bugs" aria-label="Name" (keydown.escape)="saving.set(false)" #nm />
        <span class="tss-grow"></span>
        <button type="submit" class="action-btn primary" [disabled]="!name.trim() || busy()">Save</button>
        <button type="button" class="action-btn" (click)="saving.set(false)">Cancel</button>
        <span class="tss-hint">Keeps the text, every filter, Open only, sort and Show. Everyone using this Alfred sees it.</span>
      </form>
    } @else if (editingRow()) {
      @let e = editingRow()!;
      <div class="tss-bar edit">
        <b>Editing "{{ e.name }}"</b><span class="tss-dim">change the filters and search as often as you like</span>
        <span class="tss-grow"></span>
        <button type="button" class="action-btn primary" [disabled]="busy() || !current()" (click)="saveChanges(e)">Save changes</button>
        <button type="button" class="action-btn" (click)="openSave()">Save as new…</button>
        <button type="button" class="action-btn" (click)="cancelEdit.emit()">Cancel</button>
      </div>
    } @else if (changed() && litRow()) {
      @let l = litRow()!;
      <div class="tss-bar">
        <span class="tss-dim">You changed "{{ l.name }}"</span><span class="tss-grow"></span>
        <button type="button" class="action-btn primary" [disabled]="busy()" (click)="saveChanges(l)">Save changes</button>
        <button type="button" class="action-btn" (click)="openSave()">Save as new…</button>
      </div>
    }
    @if (error()) { <div class="tss-err" role="alert">{{ error() }}</div> }`,
  styles: [`
    :host { display: block; }
    .tss { display: flex; flex-wrap: wrap; gap: .35rem; align-items: center; margin: .5rem 0 .2rem; }
    .tss-l { color: var(--text-faint); font-size: .7rem; text-transform: uppercase; letter-spacing: .04em; margin-right: .1rem; }
    .tss-pill { position: relative; display: inline-flex; align-items: center; border: 1px solid var(--border-strong); border-radius: 999px;
      background: var(--card-inner); font-size: .78rem; }
    .tss-pill:hover { border-color: var(--purple-light); }
    .tss-pill.on { background: rgba(139,92,246,.22); border-color: var(--purple); }
    .tss-pill.editing { border-style: dashed; border-color: var(--amber); }
    .tss-run { display: inline-flex; gap: .35rem; align-items: center; border: 0; background: none; color: inherit; padding: .12rem .3rem .12rem .65rem; cursor: pointer;
      font: inherit; }
    .tss-n { font-size: .66rem; color: var(--text-faint); }
    .tss-pill.on .tss-n { color: var(--purple-light); }
    .tss-dot { color: var(--amber); font-size: .7rem; }
    .tss-more { border: 0; background: none; color: var(--text-faint); padding: .12rem .5rem .12rem .2rem; cursor: pointer; font: inherit; }
    .tss-more:hover { color: var(--text); }
    .tss-menu { position: absolute; z-index: 60; top: 115%; left: 0; display: grid; min-width: 190px; padding: .25rem; background: var(--popover-solid);
      border: 1px solid var(--border-strong); border-radius: 8px; box-shadow: 0 10px 28px rgba(0,0,0,.4); }
    .tss-menu button { border: 0; background: none; color: inherit; text-align: left; padding: .32rem .5rem; border-radius: 5px; font-size: .8rem; cursor: pointer; }
    .tss-menu button:hover { background: rgba(139,92,246,.15); }
    .tss-menu hr { border: 0; border-top: 1px solid var(--border); margin: .2rem 0; width: 100%; }
    .tss-danger { color: var(--red) !important; }
    .tss-ask { display: flex; flex-wrap: wrap; gap: .3rem; align-items: center; padding: .25rem .5rem; font-size: .78rem; }
    .tss-rename { display: inline-flex; align-items: center; padding-left: .3rem; }
    .tss-rename input { width: 150px; padding: .1rem .35rem; border: 1px solid var(--border-strong); border-radius: 5px; background: var(--card-inner); color: var(--text); font: inherit; }
    .tss-x { border: 0; background: none; color: var(--green); cursor: pointer; }
    .tss-bar { display: flex; flex-wrap: wrap; gap: .45rem; align-items: center; padding: .45rem .6rem; margin: .45rem 0; border: 1px solid rgba(139,92,246,.45);
      background: rgba(139,92,246,.07); border-radius: 8px; font-size: .8rem; }
    .tss-bar.edit { border-color: color-mix(in srgb, var(--amber) 55%, transparent); background: color-mix(in srgb, var(--amber) 6%, transparent); }
    .tss-bar input { width: min(240px, 100%); padding: .25rem .45rem; border: 1px solid var(--border-strong); border-radius: 6px; background: var(--card-inner);
      color: var(--text); font: inherit; }
    .tss-grow { flex: 1; }
    .tss-dim, .tss-hint { color: var(--text-dim); }
    .tss-hint { flex-basis: 100%; font-size: .72rem; color: var(--text-faint); }
    .tss-err { color: var(--red); font-size: .8rem; margin: .2rem 0; }
  `],
  host: { '(document:keydown.escape)': 'menu.set(null)', '(document:click)': 'outside($event)' },
})
export class TeamSavedSearchesComponent {
  private readonly api = inject(TeamApiService);
  private readonly state = inject(TeamStateService);

  readonly conn = input.required<string>();
  /** The search on screen (what Save keeps), Show included. */
  readonly current = input<TeamSearch | null>(null);
  /** The pill whose search is on screen, the one being edited, and whether the screen moved away from it. */
  readonly lit = input<number | null>(null);
  readonly editing = input<number | null>(null);
  readonly changed = input(false);

  readonly run = output<SavedSearch>();
  readonly edit = output<SavedSearch>();
  readonly created = output<SavedSearch>();
  readonly updated = output<SavedSearch>();
  readonly cancelEdit = output<void>();

  readonly list = signal<SavedSearch[]>([]);
  readonly menu = signal<number | null>(null);
  readonly renaming = signal<number | null>(null);
  readonly deleting = signal<number | null>(null);
  readonly saving = signal(false);
  readonly busy = signal(false);
  readonly error = signal<string | null>(null);

  name = '';
  newName = '';
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly injector = inject(Injector);

  constructor() {
    effect(() => {
      const conn = this.conn();
      this.state.savedVersion();
      untracked(() => this.load(conn));
    });
  }

  editingRow(): SavedSearch | null {
    return this.list().find((s) => s.id === this.editing()) ?? null;
  }

  litRow(): SavedSearch | null {
    return this.list().find((s) => s.id === this.lit()) ?? null;
  }

  load(conn: string): void {
    this.api.savedSearches(conn).subscribe({
      next: (l) => this.conn() === conn && this.list.set(l),
      error: () => this.list.set([]),
    });
  }

  /** ☆ Save search: the bar opens with an empty name. */
  openSave(): void {
    this.name = '';
    this.error.set(null);
    this.saving.set(true);
    // once the bar is drawn
    afterNextRender(() => (this.host.nativeElement.querySelector('.tss-bar input') as HTMLInputElement | null)?.focus(), { injector: this.injector });
  }

  create(): void {
    const name = this.name.trim();
    if (!name) return;
    this.busy.set(true);
    this.api.createSaved(this.conn(), name, this.current() ?? {}).subscribe({
      next: (s) => {
        this.busy.set(false);
        this.saving.set(false);
        this.list.update((l) => (l.some((x) => x.id === s.id) ? l : [...l, s])); // the "saved" signal may have read it first
        this.created.emit(s);
      },
      error: (e) => this.fail(e, 'Could not save the search'),
    });
  }

  saveChanges(s: SavedSearch): void {
    const q = this.current();
    if (!q) return;
    this.busy.set(true);
    this.api.updateSaved(s.id, { query: q }).subscribe({
      next: (n) => {
        this.busy.set(false);
        this.list.update((l) => l.map((x) => (x.id === n.id ? n : x)));
        this.updated.emit(n);
      },
      error: (e) => this.fail(e, 'Could not save the changes'),
    });
  }

  startRename(s: SavedSearch): void {
    this.menu.set(null);
    this.newName = s.name;
    this.renaming.set(s.id);
  }

  rename(s: SavedSearch): void {
    const name = this.newName.trim();
    if (!name || name === s.name) return this.renaming.set(null);
    this.api.updateSaved(s.id, { name }).subscribe({
      next: (n) => {
        this.renaming.set(null);
        this.list.update((l) => l.map((x) => (x.id === n.id ? n : x)));
      },
      error: (e) => this.fail(e, 'Could not rename it'),
    });
  }

  move(s: SavedSearch, by: -1 | 1): void {
    this.menu.set(null);
    this.api.moveSaved(s.id, by).subscribe({ next: (l) => this.list.set(l), error: (e) => this.fail(e, 'Could not move it') });
  }

  remove(s: SavedSearch): void {
    this.menu.set(null);
    this.deleting.set(null);
    this.api.deleteSaved(s.id).subscribe({
      next: () => this.list.update((l) => l.filter((x) => x.id !== s.id)),
      error: (e) => this.fail(e, 'Could not delete it'),
    });
  }

  outside(e: MouseEvent): void {
    if (this.menu() !== null && !(e.target as HTMLElement)?.closest?.('.tss-pill')) {
      this.menu.set(null);
      this.deleting.set(null);
    }
  }

  private fail(e: { error?: { message?: string } }, fallback: string): void {
    this.busy.set(false);
    this.error.set(e?.error?.message || fallback);
  }
}
