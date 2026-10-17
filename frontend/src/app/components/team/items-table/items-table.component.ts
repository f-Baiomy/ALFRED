import { Component, computed, effect, inject, output, signal, untracked } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { TeamApiService } from '../../../core/team/team-api.service';
import { TeamStateService } from '../../../core/team/team-state.service';
import { TeamItem, TeamItemFilters } from '../../../core/team/team.models';

/**
 * The cached work items (specs/027 US7): search and filters run in Alfred's cache, 50 a page; refetched on the
 * /ws/teamboards "items" signal, never on a timer.
 */
@Component({
  selector: 'app-team-items-table',
  standalone: true,
  imports: [FormsModule],
  template: `
    <div class="ti-filters">
      <input type="search" class="ti-search" [ngModel]="filters().q ?? ''" (ngModelChange)="set({ q: $event })" placeholder="Search titles or ids…"
             aria-label="Search work items" />
      <input [ngModel]="filters().type ?? ''" (ngModelChange)="set({ type: $event })" placeholder="Type" aria-label="Type" />
      <input [ngModel]="filters().state ?? ''" (ngModelChange)="set({ state: $event })" placeholder="State" aria-label="State" />
      <input [ngModel]="filters().squad ?? ''" (ngModelChange)="set({ squad: $event })" [placeholder]="state.ui().word('squad')"
             [attr.aria-label]="state.ui().word('squad')" />
      <input [ngModel]="filters().assignee ?? ''" (ngModelChange)="set({ assignee: $event })" placeholder="Assigned to" aria-label="Assigned to" />
      <span class="ti-count">{{ total() }} {{ state.ui().word('item').toLowerCase() }}{{ total() === 1 ? '' : 's' }}</span>
    </div>
    <div class="ti-wrap">
      <table class="ti-table">
        <thead><tr><th>Id</th><th>Type</th><th>Title</th><th>State</th><th>Assigned</th><th>{{ state.ui().word('squad') }}</th>
          <th>{{ state.ui().word('sprint') }}</th><th>Changed</th></tr></thead>
        <tbody>
          @for (i of items(); track i.extId) {
            <tr (click)="opened.emit(i)" tabindex="0" (keydown.enter)="opened.emit(i)">
              <td class="ti-id">{{ i.extId }}</td>
              <td><span class="ti-type" [class.custom]="i.customType">{{ i.type }}</span></td>
              <td class="ti-title">{{ i.title }}</td>
              <td>{{ i.state }}</td>
              <td>{{ i.assignee }}</td>
              <td>{{ i.squad }}</td>
              <td class="ti-sprint">{{ leaf(i.sprint) }}</td>
              <td class="ti-when">{{ i.changedAt ? i.changedAt.slice(0, 10) : '' }}</td>
            </tr>
          } @empty {
            <tr><td colspan="8" class="ti-empty">{{ loading() ? 'Loading…' : 'Nothing in the cache matches - Refresh fetches what changed.' }}</td></tr>
          }
        </tbody>
      </table>
    </div>
    @if (total() > pageSize) {
      <div class="ti-pages">
        <button type="button" class="action-btn" [disabled]="offset() === 0" (click)="page(-1)">‹ Previous</button>
        <span>{{ offset() + 1 }}-{{ min(offset() + pageSize, total()) }} of {{ total() }}</span>
        <button type="button" class="action-btn" [disabled]="offset() + pageSize >= total()" (click)="page(1)">Next ›</button>
      </div>
    }`,
  styles: [`
    .ti-filters { display: flex; flex-wrap: wrap; gap: .4rem; align-items: center; margin-bottom: .5rem; }
    .ti-filters input { padding: .25rem .5rem; border: 1px solid var(--border-strong); border-radius: 6px; background: var(--card-inner); color: inherit; width: 120px; }
    .ti-filters .ti-search { width: 240px; }
    .ti-count { color: var(--text-dim); font-size: .8rem; margin-left: auto; }
    .ti-wrap { overflow-x: auto; }
    .ti-table { width: 100%; border-collapse: collapse; font-size: .82rem; }
    .ti-table th, .ti-table td { padding: .3rem .5rem; border-bottom: 1px solid var(--border); text-align: left; white-space: nowrap; }
    .ti-table tbody tr { cursor: pointer; }
    .ti-table tbody tr:hover { background: rgba(139,92,246,.1); }
    .ti-title { white-space: normal !important; min-width: 260px; }
    .ti-id, .ti-when { color: var(--text-dim); }
    .ti-type { padding: 0 .4rem; border-radius: 4px; background: var(--card-inner); }
    .ti-type.custom { color: var(--purple-light); }
    .ti-empty { color: var(--text-faint); text-align: center; }
    .ti-pages { display: flex; gap: .6rem; align-items: center; justify-content: flex-end; margin-top: .5rem; font-size: .8rem; }
  `],
})
export class TeamItemsTableComponent {
  readonly state = inject(TeamStateService);
  private readonly api = inject(TeamApiService);
  readonly opened = output<TeamItem>();

  readonly pageSize = 50;
  readonly filters = signal<TeamItemFilters>({});
  readonly offset = signal(0);
  readonly items = signal<readonly TeamItem[]>([]);
  readonly total = signal(0);
  readonly loading = signal(true);
  private asked = 0;
  private typing: ReturnType<typeof setTimeout> | null = null;

  readonly conn = computed(() => this.state.picked()?.id ?? null);

  constructor() {
    effect(() => {
      const conn = this.conn();
      this.state.itemsVersion();
      const f = this.filters();
      const off = this.offset();
      untracked(() => this.load(conn, f, off));
    });
  }

  set(change: Partial<TeamItemFilters>): void {
    // a short pause while typing (one fetch per word, not per key) - not polling: it fires once per change
    if (this.typing) clearTimeout(this.typing);
    this.typing = setTimeout(() => {
      this.offset.set(0);
      this.filters.update((f) => ({ ...f, ...change }));
    }, 250);
  }

  page(dir: number): void {
    this.offset.update((o) => Math.max(0, o + dir * this.pageSize));
  }

  min(a: number, b: number): number {
    return Math.min(a, b);
  }

  leaf(path: string | null): string {
    return path ? path.split('\\').pop() ?? path : '';
  }

  private load(conn: string | null, f: TeamItemFilters, offset: number): void {
    if (!conn) {
      this.items.set([]);
      this.total.set(0);
      return;
    }
    const mine = ++this.asked;
    this.loading.set(true);
    this.api.items(conn, f, offset, this.pageSize).subscribe({
      next: (p) => {
        if (mine !== this.asked) return;
        this.items.set(p.items);
        this.total.set(p.total);
        this.loading.set(false);
      },
      error: () => this.loading.set(false),
    });
  }
}
