import { Component, computed, effect, inject, signal, untracked } from '@angular/core';
import { ActivatedRoute } from '@angular/router';
import { TeamApiService } from '../../core/team/team-api.service';
import { TeamStateService } from '../../core/team/team-state.service';
import { MineView, SavedSearch, SearchResult, SearchRow, ShowMode, TeamSearch, searchKey } from '../../core/team/team.models';
import { ConnectionSwitcherComponent } from '../../components/team/connection-switcher/connection-switcher.component';
import { TeamSearchFormComponent } from '../../components/team/search-form/search-form.component';
import { RowAction, TeamResultsTableComponent } from '../../components/team/results-table/results-table.component';
import { TeamNewBoardDialogComponent } from '../../components/team/new-board/new-board-dialog.component';
import { TeamItemDrawerComponent } from '../../components/team/item-drawer/item-drawer.component';
import { TeamBoardsSprintsComponent } from '../../components/team/boards-sprints/boards-sprints.component';
import { TeamSquadsComponent } from '../../components/team/squads/squads.component';
import { TeamSavedSearchesComponent } from '../../components/team/saved-searches/saved-searches.component';
import { PickedTarget, TeamBoardPickerComponent } from '../../components/team/board-picker/board-picker.component';

type View = 'search' | 'mine' | 'teams' | 'iterations';

/** The Show choice and children depth, remembered per browser (a convenience; nothing breaks without storage). */
const SHOW_KEY = 'alfred.team.show';

function remembered(): { show: ShowMode; depth: number } {
  try {
    const v = JSON.parse(localStorage.getItem(SHOW_KEY) ?? 'null');
    if (v && ['ITEMS', 'PARENTS', 'TREE'].includes(v.show)) return { show: v.show, depth: v.depth === 0 ? 0 : 1 };
  } catch {
    // no storage here: the defaults
  }
  return { show: 'ITEMS', depth: 1 };
}

const PICKER: Record<Exclude<RowAction, 'START' | 'NEW_BOARD'>, { title: string; action: string; card: boolean }> = {
  NEW_CARD: { title: 'New card on which board?', action: 'Create card', card: false },
  LINK_CARD: { title: 'Link to which card?', action: 'Link', card: true },
  RELATED: { title: 'Add as a related item of which board?', action: 'Add', card: false },
  MAIN: { title: 'Main item of which board?', action: 'Make main', card: false },
};

/**
 * The Team tab (specs/028 US1, US6): search the tracker live - nothing found is stored - then put what matters on a
 * board. The token is entered once and kept 8 hours in Alfred's memory; everything here reads with it.
 */
@Component({
  selector: 'app-team-page',
  standalone: true,
  imports: [ConnectionSwitcherComponent, TeamNewBoardDialogComponent, TeamSearchFormComponent, TeamResultsTableComponent, TeamItemDrawerComponent, TeamBoardsSprintsComponent,
    TeamSquadsComponent, TeamBoardPickerComponent, TeamSavedSearchesComponent],
  template: `
    <div class="team-page">
      <app-connection-switcher />
      @if (state.error()) { <div class="team-err" role="alert">{{ state.error() }}</div> }
      @if (state.picked(); as c) {
        <div class="team-views" role="tablist">
          @for (v of views(); track v.id) {
            <button type="button" role="tab" [class.on]="view() === v.id" [attr.aria-selected]="view() === v.id" (click)="show(v.id)">{{ v.label }}</button>
          }
          <span class="team-grow"></span>
          <span class="team-dim">{{ state.lists()?.at ? 'Lists read ' + state.lists()!.at!.slice(0, 16).replace('T', ' ') : 'Lists not read yet' }}</span>
          <button type="button" class="action-btn" [disabled]="!state.hasToken() || refreshing()" (click)="refreshLists(c.id)">↻ Refresh lists</button>
        </div>
        @if (note()) { <div class="team-note" [class.err]="noteErr()" role="status">{{ note() }} <button type="button" class="team-x" (click)="note.set(null)">✕</button></div> }
        @switch (view()) {
          @case ('search') {
            <app-team-search-form [preset]="preset()" [busy]="searching()" (search)="run($event)" (saveAsked)="pills.openSave()" />
            <app-team-saved-searches #pills [conn]="c.id" [current]="current()" [lit]="lit()" [editing]="editing()" [changed]="litChanged()"
                                     (run)="runSaved($event)" (edit)="editSaved($event)" (created)="savedNow($event)" (updated)="savedNow($event)"
                                     (cancelEdit)="editing.set(null)" />
            @if (searchError()) { <div class="team-err" role="alert">{{ searchError() }}</div> }
            <app-team-results-table [result]="result()" [loading]="skeleton()" [openOnly]="last()?.openOnly ?? true" [show]="showMode()" [childDepth]="childDepth()"
                                    (showChange)="setShow($event)" (depthChange)="setDepth($event)" (opened)="open($event.id)" (page)="page($event)"
                                    (action)="act($event.action, $event.row.id, $event.row.title)" />
          }
          @case ('mine') {
            @if (mine(); as m) {
              <p class="team-dim">"Me" is {{ m.me.person.name }}{{ m.me.source === 'OVERRIDE' ? ' (picked as "This is me")' : ' (the token owner)' }}.</p>
              @for (s of m.sources; track s.source) {
                <section class="team-mine">
                  <h4>{{ sourceWord(s.source) }} <span class="team-dim">{{ s.count }}</span></h4>
                  @for (i of s.items; track i.id) {
                    <button type="button" class="team-mine-row" (click)="open(i.id)"><span class="team-dim">{{ i.id }}</span> {{ i.type }} · {{ i.title }}
                      <span class="team-dim">{{ i.state }}</span></button>
                  }
                  @for (card of s.cards; track card.id) { <div class="team-mine-row">▣ #{{ card.number }} {{ card.title }} <span class="team-dim">{{ card.status }}</span></div> }
                  @for (b of s.boards; track b) { <div class="team-mine-row">▦ {{ b }}</div> }
                </section>
              }
              @for (f of failedOf(m); track f[0]) { <div class="team-err">{{ sourceWord(f[0]) }}: {{ f[1] }}</div> }
            } @else { <div class="team-dim">{{ mineError() || 'Reading…' }}</div> }
          }
          @case ('teams') { <app-team-squads (search)="searchFor($event)" /> }
          @case ('iterations') { <app-team-boards-sprints (search)="searchFor($event)" /> }
        }
        @if (opened(); as id) {
          <app-team-item-drawer [conn]="c.id" [itemId]="id" (closed)="opened.set(null)" (openOther)="open($event)" (action)="act($event, id)" />
        }
        @if (newBoardFor(); as nb) {
          <app-team-new-board-dialog [conn]="c.id" [extId]="nb.id" [title]="nb.title" (changed)="reloadResult()" (closed)="newBoardFor.set(null)" />
        }
        @if (picking(); as p) {
          <app-team-board-picker [title]="p.title" [action]="p.action" [card]="p.card" (picked)="placed($event)" (closed)="picking.set(null)" />
        }
      }
    </div>`,
  styles: [`
    .team-page { padding: 1rem 1.2rem; }
    .team-err { color: var(--red); margin: .4rem 0; font-size: .84rem; }
    .team-grow { flex: 1; }
    .team-dim { color: var(--text-dim); font-size: .8rem; }
    .team-views { display: flex; flex-wrap: wrap; gap: .3rem; align-items: center; margin: .4rem 0 .6rem; border-bottom: 1px solid var(--border); }
    .team-views [role=tab] { border: 0; background: none; color: var(--text-dim); padding: .35rem .7rem; cursor: pointer; }
    .team-views [role=tab].on { color: var(--text); border-bottom: 2px solid var(--purple-light); }
    .team-note { margin: .3rem 0; padding: .35rem .6rem; border: 1px solid var(--green); border-radius: 7px; font-size: .82rem; }
    .team-note.err { border-color: var(--red); }
    .team-x { border: 0; background: none; color: var(--text-dim); cursor: pointer; }
    .team-mine { margin: .6rem 0; }
    .team-mine h4 { margin: 0 0 .3rem; }
    .team-mine-row { display: block; width: 100%; text-align: left; border: 0; border-bottom: 1px solid var(--border); background: none; color: inherit;
      padding: .3rem 0; font-size: .82rem; }
    button.team-mine-row { cursor: pointer; }
  `],
})
export class TeamPageComponent {
  readonly state = inject(TeamStateService);
  private readonly api = inject(TeamApiService);
  private readonly route = inject(ActivatedRoute, { optional: true });

  readonly view = signal<View>('search');
  readonly opened = signal<string | null>(null);
  readonly preset = signal<TeamSearch | null>(null);
  readonly last = signal<TeamSearch | null>(null);
  readonly result = signal<SearchResult | null>(null);
  /** Skeleton rows: only once a search has taken longer than 150 ms, so a fast one never flashes. */
  readonly skeleton = signal(false);
  private skeletonTimer: ReturnType<typeof setTimeout> | null = null;
  /** The saved search on screen (its pill lit), the one being edited, and its query as saved. */
  readonly lit = signal<number | null>(null);
  readonly editing = signal<number | null>(null);
  private readonly litQuery = signal<TeamSearch | null>(null);
  readonly litChanged = computed(() => this.lit() !== null && !!this.last() && searchKey(this.last()) !== searchKey(this.litQuery()));
  /** What ☆ Save / Save changes keeps: the search on screen with its Show. */
  readonly current = computed<TeamSearch | null>(() => {
    const s = this.last();
    if (!s) return null;
    const { page: _p, saved: _s, ...rest } = s;
    return { ...rest, show: this.showMode(), childDepth: this.childDepth() };
  });
  readonly showMode = signal<ShowMode>(remembered().show);
  readonly childDepth = signal<number>(remembered().depth);
  readonly searching = signal(false);
  readonly searchError = signal<string | null>(null);
  readonly refreshing = signal(false);
  readonly mine = signal<MineView | null>(null);
  readonly mineError = signal<string | null>(null);
  readonly note = signal<string | null>(null);
  readonly noteErr = signal(false);
  private asked = 0;
  /** The item a new board is being made from (Add ▾ → New board from this item…). */
  readonly newBoardFor = signal<{ id: string; title: string } | null>(null);
  readonly picking = signal<{ title: string; action: string; card: boolean; what: RowAction; item: string } | null>(null);

  readonly views = computed(() => {
    const ui = this.state.ui();
    return [
      { id: 'search' as View, label: 'Search' },
      { id: 'mine' as View, label: 'Mine' },
      { id: 'teams' as View, label: ui.word('squad') + 's' },
      { id: 'iterations' as View, label: ui.word('sprint') + 's & boards' },
    ];
  });

  constructor() {
    this.state.load();
    // ?conn=&item= (a work item mention), ?person= (a person mention), ?q= (a search)
    const q = this.route?.snapshot.queryParamMap;
    const conn = q?.get('conn');
    if (conn) this.state.pick(conn);
    const item = q?.get('item');
    if (item) this.opened.set(item);
    const person = q?.get('person');
    const text = q?.get('q');
    if (person) this.preset.set({ assigned: [person], openOnly: true });
    else if (text) this.preset.set({ text, openOnly: true });
    // a new token, or another connection: search again
    effect(() => {
      this.state.picked();
      const live = this.state.hasToken();
      untracked(() => {
        if (live && this.last()) this.run({ ...this.last()!, page: 0 });
        if (this.view() === 'mine') this.readMine();
      });
    });
  }

  show(v: View): void {
    this.view.set(v);
    if (v === 'mine') this.readMine();
  }

  run(s: TeamSearch): void {
    const c = this.state.picked();
    if (!c) return;
    this.last.set(s);
    if (!this.state.hasToken()) {
      this.searchError.set('Enter a token first - searches read the tracker live.');
      return;
    }
    // an id or a link searched: open it
    const id = this.idIn(s.text ?? '');
    if (id) {
      this.open(id);
      return;
    }
    this.searching.set(true);
    this.searchError.set(null);
    const mine = ++this.asked;
    if (this.skeletonTimer) clearTimeout(this.skeletonTimer);
    this.skeletonTimer = setTimeout(() => this.skeleton.set(this.searching()), 150);
    const done = () => {
      this.searching.set(false);
      this.skeleton.set(false);
      if (this.skeletonTimer) clearTimeout(this.skeletonTimer);
    };
    // the lit pill's own search keeps its count
    const saved = this.lit() !== null && searchKey(s) === searchKey(this.litQuery()) ? this.lit() : null;
    this.api.search(c.id, { ...s, show: this.showMode(), childDepth: this.childDepth(), saved }).subscribe({
      next: (r) => {
        if (mine !== this.asked) return; // a newer search (or another connection) went out since
        done();
        this.result.set(r);
      },
      error: (e) => {
        if (mine !== this.asked) return;
        done();
        this.searchError.set(e?.error?.message || 'The search failed');
      },
    });
  }

  /** "123", "AB#123" or an item URL. */
  private idIn(text: string): string | null {
    const t = text.trim();
    if (/^(AB#)?\d+$/i.test(t)) return t.replace(/^AB#/i, '');
    const m = /\/_workitems\/edit\/(\d+)/.exec(t) ?? /[?&]workitem=(\d+)/i.exec(t);
    return m ? m[1] : null;
  }

  /** A pill clicked: its search fills the form and runs, with its Show. */
  runSaved(s: SavedSearch): void {
    this.lit.set(s.id);
    this.litQuery.set(s.query);
    this.editing.set(null);
    if (s.query.show) this.showMode.set(s.query.show);
    if (s.query.childDepth !== undefined && s.query.childDepth !== null) this.childDepth.set(s.query.childDepth);
    this.remember();
    this.preset.set({ ...s.query });
  }

  editSaved(s: SavedSearch): void {
    this.runSaved(s);
    this.editing.set(s.id);
  }

  /** Saved (new, or changes): its pill is lit and matches the screen. */
  savedNow(s: SavedSearch): void {
    this.lit.set(s.id);
    this.litQuery.set(s.query);
    this.editing.set(null);
  }

  setShow(m: ShowMode): void {
    this.showMode.set(m);
    this.remember();
    this.again();
  }

  setDepth(d: number): void {
    this.childDepth.set(d);
    this.remember();
    this.again();
  }

  private remember(): void {
    try {
      localStorage.setItem(SHOW_KEY, JSON.stringify({ show: this.showMode(), depth: this.childDepth() }));
    } catch {
      // private window: not remembered
    }
  }

  /** The same page, read again in the new shape. */
  private again(): void {
    const s = this.last();
    if (s) this.run({ ...s, page: this.result()?.page ?? 0 });
  }

  page(n: number): void {
    const s = this.last();
    if (s) this.run({ ...s, page: n });
  }

  /** A browser click: show the search with that filter. */
  searchFor(s: TeamSearch): void {
    this.view.set('search');
    this.preset.set({ ...s });
  }

  open(id: string): void {
    this.opened.set(id);
  }

  refreshLists(conn: string): void {
    this.refreshing.set(true);
    this.api.refreshLists(conn).subscribe({
      next: (l) => {
        this.refreshing.set(false);
        if (this.state.picked()?.id === conn) this.state.lists.set(l);
      },
      error: (e) => {
        this.refreshing.set(false);
        this.say(e?.error?.message || 'Could not read the lists', true);
      },
    });
  }

  readMine(): void {
    const c = this.state.picked();
    if (!c) return;
    this.mineError.set(null);
    this.api.mine(c.id).subscribe({ next: (m) => this.mine.set(m), error: (e) => this.mineError.set(e?.error?.message || 'Could not read Mine') });
  }

  failedOf(m: MineView): [string, string][] {
    return Object.entries(m.failed);
  }

  sourceWord(s: string): string {
    return ({ ASSIGNED: 'Assigned to me', CREATED: 'Created by me', CHANGED: 'Changed by me', MENTIONED: 'Mentioning me', FOLLOWED: 'Followed',
      CARDS_OWNED: 'Cards I own', CARDS_MENTIONING: 'Cards mentioning me', BOARDS: 'Boards of my items' } as Record<string, string>)[s] ?? s;
  }

  act(what: RowAction, item: string, title = ''): void {
    if (what === 'NEW_BOARD') {
      this.newBoardFor.set({ id: item, title });
      return;
    }
    if (what === 'START') {
      this.open(item);
      return;
    }
    this.picking.set({ ...PICKER[what], what, item });
  }

  placed(t: PickedTarget): void {
    const p = this.picking();
    const c = this.state.picked();
    this.picking.set(null);
    if (!p || !c) return;
    const board = t.board.board.id;
    const name = t.board.board.name;
    const fail = (e: { error?: { message?: string } }) => this.say(e?.error?.message || 'Could not add it', true);
    switch (p.what) {
      case 'NEW_CARD':
        this.api.addIncoming(board, c.id, p.item).subscribe({
          next: () => this.api.incomingCard(board, c.id, p.item).subscribe({ next: (r) => this.say(`Card ${r.cardId} created on ${name}`), error: fail }),
          error: fail,
        });
        break;
      case 'LINK_CARD':
        if (!t.card) return;
        this.api.linkCard(t.card.id, c.id, p.item, t.markers ? { hyperlink: true, comment: true, tag: true } : {}).subscribe({
          next: (r) => this.say(`${p.item} linked to #${t.card!.number}` + (r.bundle ? ' - telling the tracker waits for your approval on the card' : '')),
          error: fail,
        });
        break;
      case 'RELATED':
        this.api.addBoardItem(board, { conn: c.id, item: p.item }).subscribe({ next: () => this.say(`${p.item} added to ${name}`), error: fail });
        break;
      case 'MAIN':
        this.api.addBoardItem(board, { conn: c.id, item: p.item, asMain: true }).subscribe({ next: () => this.say(`${p.item} is the main item of ${name}`), error: fail });
        break;
    }
  }

  private say(m: string, err = false): void {
    this.note.set(m);
    this.noteErr.set(err);
    if (!err) this.reloadResult();
  }

  /** Badges changed: the page again. */
  reloadResult(): void {
    const s = this.last();
    if (s && this.result()) this.run({ ...s, page: this.result()!.page });
  }
}
