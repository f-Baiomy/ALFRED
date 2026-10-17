import { Component, computed, inject, signal } from '@angular/core';
import { ActivatedRoute } from '@angular/router';
import { TeamApiService } from '../../core/team/team-api.service';
import { ConnectionSwitcherComponent } from '../../components/team/connection-switcher/connection-switcher.component';
import { TeamItemsTableComponent } from '../../components/team/items-table/items-table.component';
import { TeamItemDrawerComponent } from '../../components/team/item-drawer/item-drawer.component';
import { TeamBoardsSprintsComponent } from '../../components/team/boards-sprints/boards-sprints.component';
import { TeamSquadsComponent } from '../../components/team/squads/squads.component';
import { TeamChangesFeedComponent } from '../../components/team/changes-feed/changes-feed.component';
import { TeamStateService } from '../../core/team/team-state.service';
import { TeamChange, TeamItem } from '../../core/team/team.models';

type View = 'items' | 'boards' | 'squads' | 'changes';

/**
 * The Team tab (specs/027 US7): what the team's tracker holds, read from Alfred's shared cache. Each view shows only when
 * the connection's connector can give it (its capabilities), and a refresh needs the viewer's own token.
 */
@Component({
  selector: 'app-team-page',
  standalone: true,
  imports: [ConnectionSwitcherComponent, TeamItemsTableComponent, TeamItemDrawerComponent, TeamBoardsSprintsComponent, TeamSquadsComponent,
    TeamChangesFeedComponent],
  template: `
    <div class="team-page">
      <app-connection-switcher />
      @if (state.error()) { <div class="team-err" role="alert">{{ state.error() }}</div> }
      @if (state.picked(); as c) {
        <div class="team-views" role="tablist">
          @for (v of views(); track v.id) {
            <button type="button" role="tab" [class.on]="view() === v.id" (click)="view.set(v.id)">{{ v.label }}
              @if (v.id === 'changes' && c.newChanges) { <span class="tab-badge">{{ c.newChanges }}</span> }</button>
          }
        </div>
        @switch (current()) {
          @case ('items') { <app-team-items-table (opened)="open($event)" /> }
          @case ('boards') { <app-team-boards-sprints /> }
          @case ('squads') { <app-team-squads /> }
          @case ('changes') { <app-team-changes-feed (opened)="openChange($event)" /> }
        }
      }
      @if (opened(); as i) { <app-team-item-drawer [item]="i" (closed)="opened.set(null)" /> }
    </div>`,
  styles: [`
    .team-page { padding: 1rem 1.2rem; }
    .team-err { color: var(--red); margin: .4rem 0; }
    .team-views { display: flex; gap: .3rem; margin: .4rem 0 .8rem; border-bottom: 1px solid var(--border); }
    .team-views button { border: 0; background: none; color: var(--text-dim); padding: .35rem .7rem; cursor: pointer; }
    .team-views button.on { color: var(--text); border-bottom: 2px solid var(--purple-light); }
  `],
})
export class TeamPageComponent {
  readonly state = inject(TeamStateService);
  readonly view = signal<View>('items');
  readonly opened = signal<TeamItem | null>(null);

  readonly views = computed(() => {
    const caps = this.state.picked()?.capabilities ?? [];
    const ui = this.state.ui();
    const out: { id: View; label: string }[] = [{ id: 'items', label: ui.word('item') + 's' }];
    if (caps.includes('BOARDS') || caps.includes('SPRINTS')) out.push({ id: 'boards', label: 'Boards & ' + ui.word('sprint') + 's' });
    if (caps.includes('SQUADS')) out.push({ id: 'squads', label: ui.word('squad') + 's' });
    out.push({ id: 'changes', label: 'Changes' });
    return out;
  });
  /** A view the picked connection cannot give falls back to the items. */
  readonly current = computed<View>(() => (this.views().some((v) => v.id === this.view()) ? this.view() : 'items'));

  private readonly route = inject(ActivatedRoute, { optional: true });
  private readonly api = inject(TeamApiService);

  constructor() {
    this.state.load();
    // ?conn=&item= (a work item mention on the board): that connection, with the item's drawer open
    const q = this.route?.snapshot.queryParamMap;
    const conn = q?.get('conn');
    const item = q?.get('item');
    if (conn) this.state.pick(conn);
    if (conn && item) this.api.item(conn, item).subscribe({ next: (d) => this.opened.set(d.item), error: () => undefined });
  }

  open(i: TeamItem): void {
    this.opened.set(i);
  }

  openChange(c: TeamChange): void {
    // the drawer reads the full item itself; the change line has what the head needs
    this.opened.set({ conn: c.conn, extId: c.extId, type: '', customType: false, title: c.title ?? c.extId, state: null, assignee: null,
      squad: c.squad, sprint: null, area: null, url: '', rev: c.rev, changedAt: c.at });
  }
}
