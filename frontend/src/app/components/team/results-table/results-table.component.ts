import { Component, inject, input, output, signal } from '@angular/core';
import { TeamStateService } from '../../../core/team/team-state.service';
import { SearchResult, SearchRow, closedCategory } from '../../../core/team/team.models';
import { PersonPillComponent } from '../person-pill/person-pill.component';

export type RowAction = 'NEW_CARD' | 'LINK_CARD' | 'RELATED' | 'MAIN' | 'START';

/**
 * Search results (specs/028 US1, FR-012..014, FR-060): 50 a page, read live; each row says where it already sits in
 * Alfred (main of board X, on card #n, related) and whether the tracker moved past Alfred's saved copy. Add ▾ puts it on
 * a board.
 */
@Component({
  selector: 'app-team-results-table',
  standalone: true,
  imports: [PersonPillComponent],
  template: `
    @if (result(); as r) {
      <div class="trt-head">
        <span>{{ r.total }} found{{ r.total > r.items.length ? ' · page ' + (r.page + 1) + ' of ' + pages(r) : '' }}</span>
        @if (!r.fullText) { <span class="trt-warn" title="This tracker has no full-text search (Search is off for the organisation)">titles only</span> }
        @if (r.page > 0) { <button type="button" class="action-btn" (click)="page.emit(r.page - 1)">‹ Prev</button> }
        @if (r.page + 1 < pages(r)) { <button type="button" class="action-btn" (click)="page.emit(r.page + 1)">Next ›</button> }
      </div>
      <table class="trt">
        <thead><tr><th>Id</th><th>Type</th><th>Title</th><th>State</th><th>Assigned</th><th>{{ state.ui().word('sprint') }}</th><th>Changed</th><th>In Alfred</th><th></th></tr></thead>
        <tbody>
          @for (row of r.items; track row.id) {
            <tr [class.closed]="closed(row)" (click)="opened.emit(row)">
              <td class="trt-id">{{ row.id }}</td>
              <td>{{ row.type }}</td>
              <td class="trt-title">{{ row.title }}</td>
              <td><span class="trt-state" [attr.data-cat]="row.stateCategory">{{ row.state || '-' }}</span></td>
              <td (click)="$event.stopPropagation()"><app-person-pill [person]="row.assigned" [conn]="state.picked()?.id ?? null" /></td>
              <td class="trt-dim">{{ last(row.iteration) }}</td>
              <td class="trt-dim" [title]="row.changedAt ?? ''">{{ ago(row.changedAt) }}</td>
              <td><div class="trt-badges">
                @for (b of row.boards; track b.boardId) {
                  <span class="trt-badge" [class.main]="b.role === 'MAIN'" [class.changed]="b.changed"
                        [title]="(b.role === 'MAIN' ? 'Main item of ' : b.role === 'CARD' ? 'On a card of ' : 'Related item of ') + (b.name ?? b.boardId) + (b.changed ? ' - changed since the saved copy' : '')">
                    {{ b.role === 'MAIN' ? '★' : b.role === 'CARD' ? '▣' : '∘' }} {{ b.name ?? b.boardId }}@if (b.changed) { ● }
                  </span>
                }
                @if (row.cards.length) { <span class="trt-badge">▣ {{ row.cards.length }} card{{ row.cards.length > 1 ? 's' : '' }}</span> }
              </div></td>
              <td class="trt-add" (click)="$event.stopPropagation()">
                <button type="button" class="action-btn" (click)="toggle(row.id)" aria-haspopup="menu" [attr.aria-expanded]="menu() === row.id">Add ▾</button>
                @if (menu() === row.id) {
                  <span class="trt-pop" role="menu">
                    <button type="button" role="menuitem" (click)="act('NEW_CARD', row)">New card on board…</button>
                    <button type="button" role="menuitem" (click)="act('LINK_CARD', row)">Link to card…</button>
                    <button type="button" role="menuitem" (click)="act('RELATED', row)">Related items only…</button>
                    <button type="button" role="menuitem" (click)="act('MAIN', row)">Main item of a board…</button>
                    <button type="button" role="menuitem" (click)="act('START', row)">▶ Start a board</button>
                  </span>
                }
              </td>
            </tr>
          } @empty {
            <tr><td colspan="9" class="trt-dim">Nothing found. Open only is {{ openOnlyNote() }}.</td></tr>
          }
        </tbody>
      </table>
    }`,
  styles: [`
    .trt-head { display: flex; flex-wrap: wrap; gap: .5rem; align-items: center; font-size: .82rem; color: var(--text-dim); margin: .3rem 0; }
        .trt-warn { padding: 0 .4rem; border-radius: 4px; border: 1px solid var(--amber); color: var(--amber); font-size: .72rem; }
    .trt { width: 100%; border-collapse: collapse; font-size: .82rem; }
    .trt th, .trt td { padding: .32rem .45rem; border-bottom: 1px solid var(--border); text-align: left; vertical-align: top; }
    .trt th { color: var(--text-dim); font-weight: 500; font-size: .74rem; }
    .trt tbody tr { cursor: pointer; }
    .trt tbody tr:hover { background: rgba(139,92,246,.07); }
    .trt tr.closed td { opacity: .6; }
    .trt-id { font-variant-numeric: tabular-nums; color: var(--text-dim); }
    .trt-title { max-width: 420px; }
    .trt-dim { color: var(--text-dim); white-space: nowrap; }
    .trt-state { padding: 0 .35rem; border-radius: 4px; background: var(--card-inner); white-space: nowrap; }
    .trt-state[data-cat='InProgress'] { color: var(--blue, #60a5fa); }
    .trt-state[data-cat='Resolved'] { color: var(--green); }
    .trt-state[data-cat='Completed'], .trt-state[data-cat='Removed'] { color: var(--text-faint); }
    .trt-badges { display: flex; flex-wrap: wrap; gap: .2rem; } /* a div inside the td: a flex td stops being a table cell */
    .trt td { vertical-align: middle; }
    .trt-add { white-space: nowrap; text-align: right; }
    .trt-add .action-btn { padding: .15rem .5rem; font-size: .76rem; }
    .trt-badge { padding: 0 .35rem; border-radius: 4px; border: 1px solid var(--border-strong); font-size: .72rem; white-space: nowrap; }
    .trt-badge.main { border-color: var(--purple-light); }
    .trt-badge.changed { color: var(--amber); }
    .trt-add { position: relative; }
    .trt-pop { position: absolute; z-index: 60; right: 0; top: 100%; display: grid; min-width: 210px; padding: .25rem;
      background: var(--popover-solid); border: 1px solid var(--border-strong); border-radius: 8px; }
    .trt-pop button { border: 0; background: none; color: inherit; text-align: left; padding: .35rem .5rem; cursor: pointer; border-radius: 5px; }
    .trt-pop button:hover { background: rgba(139,92,246,.15); }
  `],
  host: { '(document:keydown.escape)': 'menu.set(null)' },
})
export class TeamResultsTableComponent {
  readonly state = inject(TeamStateService);

  readonly result = input<SearchResult | null>(null);
  readonly openOnly = input(true);
  readonly opened = output<SearchRow>();
  readonly page = output<number>();
  readonly action = output<{ action: RowAction; row: SearchRow }>();

  readonly menu = signal<string | null>(null);

  pages(r: SearchResult): number {
    return Math.max(1, Math.ceil(r.total / Math.max(1, r.pageSize)));
  }

  openOnlyNote(): string {
    return this.openOnly() ? 'on - closed and removed items are hidden' : 'off';
  }

  closed(row: SearchRow): boolean {
    return closedCategory(row.stateCategory);
  }

  toggle(id: string): void {
    this.menu.set(this.menu() === id ? null : id);
  }

  act(action: RowAction, row: SearchRow): void {
    this.menu.set(null);
    this.action.emit({ action, row });
  }

  /** The last segment of an iteration path ("Proj\Sprint 12" → "Sprint 12"). */
  last(path: string | null): string {
    if (!path) return '-';
    const parts = path.split(String.fromCharCode(92));
    return parts[parts.length - 1];
  }

  ago(at: string | null): string {
    if (!at) return '-';
    const min = Math.round((Date.now() - Date.parse(at)) / 60000);
    if (!Number.isFinite(min)) return '-';
    if (min < 60) return `${Math.max(0, min)} min`;
    if (min < 1440) return `${Math.round(min / 60)} h`;
    return `${Math.round(min / 1440)} d`;
  }
}
