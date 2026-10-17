import { Component, computed, inject, input, output, signal } from '@angular/core';
import { TeamStateService } from '../../../core/team/team-state.service';
import { SearchResult, SearchRow, ShowMode, closedCategory } from '../../../core/team/team.models';
import { PersonPillComponent } from '../person-pill/person-pill.component';

export type RowAction = 'NEW_CARD' | 'LINK_CARD' | 'RELATED' | 'MAIN' | 'START' | 'NEW_BOARD';

/** One table line: a match or a parent / child shown for context, at its depth in the tree. */
export interface TreeLine {
  readonly row: SearchRow;
  readonly depth: number;
  readonly match: boolean;
  /** Context only: an ancestor of a match, or below one. */
  readonly role: 'parent' | 'child' | null;
  readonly kids: number;
}

/**
 * The page's matches and their context as a tree (specs/029): a row goes under its parent when the parent is on the page,
 * else it is a root; roots and siblings keep the search's order (matches first). Folded ids hide their subtree.
 */
export function treeLines(r: SearchResult, folded: ReadonlySet<string>): TreeLine[] {
  const show = r.show ?? 'ITEMS';
  if (show === 'ITEMS') return r.items.map((row) => ({ row, depth: 0, match: true, role: null, kids: 0 }));
  const all = new Map<string, SearchRow>();
  const order = new Map<string, number>();
  const matches = new Set(r.items.map((i) => i.id));
  for (const row of [...r.items, ...(r.context ?? [])]) {
    if (all.has(row.id)) continue;
    all.set(row.id, row);
    order.set(row.id, order.size);
  }
  const kids = new Map<string, string[]>();
  const roots: string[] = [];
  for (const [id, row] of all) {
    const p = row.parent;
    if (p && p !== id && all.has(p)) kids.set(p, [...(kids.get(p) ?? []), id]);
    else roots.push(id);
  }
  const ancestors = new Set<string>();
  for (const id of matches) {
    let p = all.get(id)?.parent;
    for (let hop = 0; p && all.has(p) && !ancestors.has(p) && hop < 50; hop++) {
      ancestors.add(p);
      p = all.get(p)?.parent;
    }
  }
  // a branch is placed where its first match was in the search's order
  const first = new Map<string, number>();
  const firstMatch = (id: string, seen: Set<string>): number => {
    if (first.has(id)) return first.get(id)!;
    if (seen.has(id)) return Number.MAX_SAFE_INTEGER;
    seen.add(id);
    let best = matches.has(id) ? order.get(id)! : Number.MAX_SAFE_INTEGER;
    for (const k of kids.get(id) ?? []) best = Math.min(best, firstMatch(k, seen));
    first.set(id, best);
    return best;
  };
  const rank = (id: string) => [firstMatch(id, new Set()), order.get(id)!] as const;
  const byRank = (a: string, b: string) => {
    const [fa, oa] = rank(a);
    const [fb, ob] = rank(b);
    return fa - fb || oa - ob;
  };
  const out: TreeLine[] = [];
  const placed = new Set<string>();
  const walk = (id: string, depth: number) => {
    if (placed.has(id)) return;
    placed.add(id);
    const row = all.get(id)!;
    const children = (kids.get(id) ?? []).slice().sort(byRank);
    const match = matches.has(id);
    out.push({ row, depth, match, role: match ? null : ancestors.has(id) ? 'parent' : 'child', kids: children.length });
    if (folded.has(id)) return;
    children.forEach((k) => walk(k, depth + 1));
  };
  roots.sort(byRank).forEach((id) => walk(id, 0));
  return out;
}

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
    @if (loading()) {
      <div class="trt-head" role="status"><span class="trt-searching">Searching</span></div>
      <table class="trt" aria-busy="true">
        <thead><tr><th>Id</th><th>Type</th><th>Title</th><th>State</th><th>Assigned</th><th>{{ state.ui().word('sprint') }}</th><th>Changed</th><th>In Alfred</th><th></th></tr></thead>
        <tbody>
          @for (w of skeleton; track $index) {
            <tr class="trt-sk" aria-hidden="true">
              <td><span class="sk" [style.width.px]="w[0]"></span></td>
              <td><span class="sk" [style.width.px]="w[1]"></span></td>
              <td><span class="sk-in" [style.width.rem]="show() === 'ITEMS' ? 0 : w[7] * 1.15"></span><span class="sk sk-t" [style.width.px]="w[2] * 3.4"></span></td>
              <td><span class="sk sk-box" [style.width.px]="w[3]"></span></td>
              <td><span class="sk sk-round" [style.width.px]="w[4]"></span></td>
              <td><span class="sk" [style.width.%]="w[5]"></span></td>
              <td><span class="sk" [style.width.px]="w[6]"></span></td>
              <td></td>
              <td><span class="sk sk-box" style="width: 44px"></span></td>
            </tr>
          }
        </tbody>
      </table>
    } @else if (result()) {
      @let r = result()!;
      <div class="trt-head">
        <span>{{ r.total }} found{{ r.total > r.items.length ? ' · page ' + (r.page + 1) + ' of ' + pages(r) : '' }}</span>
        @if (!r.fullText) { <span class="trt-warn" title="This tracker has no full-text search (Search is off for the organisation)">titles only</span> }
        @if (r.page > 0) { <button type="button" class="action-btn" (click)="page.emit(r.page - 1)">‹ Prev</button> }
        @if (r.page + 1 < pages(r)) { <button type="button" class="action-btn" (click)="page.emit(r.page + 1)">Next ›</button> }
        @if (mode() !== 'ITEMS' && r.context) {
          <span>+{{ r.context.length }} {{ mode() === 'TREE' ? 'parents and children' : 'parents' }} for context</span>
          @if (r.contextLeftOut) { <span class="trt-warn" title="Only the first 500 parents and children of a page are read">{{ r.contextLeftOut }} more not read</span> }
        }
        <span class="trt-grow"></span>
        <span class="trt-show-l">Show</span>
        <span class="trt-seg" role="radiogroup" aria-label="Show">
          @for (m of modes; track m.id) {
            <button type="button" role="radio" [class.on]="mode() === m.id" [attr.aria-checked]="mode() === m.id" (click)="showChange.emit(m.id)">{{ m.label }}</button>
          }
        </span>
        @if (mode() === 'TREE') {
          <span class="trt-seg" role="radiogroup" aria-label="Children">
            <button type="button" role="radio" [class.on]="childDepth() !== 0" [attr.aria-checked]="childDepth() !== 0" (click)="depthChange.emit(1)">Children: 1 level</button>
            <button type="button" role="radio" [class.on]="childDepth() === 0" [attr.aria-checked]="childDepth() === 0" (click)="depthChange.emit(0)">all levels</button>
          </span>
        }
        @if (mode() !== 'ITEMS') {
          <button type="button" class="action-btn" (click)="foldAll()">{{ folded().size ? 'Expand all' : 'Collapse all' }}</button>
        }
      </div>
      <table class="trt">
        <thead><tr><th>Id</th><th>Type</th><th>Title</th><th>State</th><th>Assigned</th><th>{{ state.ui().word('sprint') }}</th><th>Changed</th><th>In Alfred</th><th></th></tr></thead>
        <tbody>
          @for (l of lines(); track l.row.id) {
            @let row = l.row;
            <tr [class.closed]="closed(row)" [class.ctx]="!l.match" (click)="opened.emit(row)">
              <td class="trt-id">{{ row.id }}</td>
              <td>{{ row.type }}</td>
              <td class="trt-title">
                @if (mode() === 'ITEMS') { {{ row.title }} }
                @else {
                  <span class="trt-tree" [style.padding-left.rem]="l.depth * 1.15">
                    @if (l.kids) {
                      <button type="button" class="trt-fold" (click)="$event.stopPropagation(); fold(row.id)" [attr.aria-expanded]="!folded().has(row.id)"
                              [attr.aria-label]="(folded().has(row.id) ? 'Expand ' : 'Collapse ') + row.id">{{ folded().has(row.id) ? '▸' : '▾' }}</button>
                    } @else { <span class="trt-fold-pad"></span> }
                    <span [class.trt-match]="l.match">{{ row.title }}</span>
                    @if (l.role) { <span class="trt-ctx" [title]="l.role === 'parent' ? 'A parent of a match - it did not match the search itself' : 'Below a match - it did not match the search itself'">{{ l.role }}</span> }
                  </span>
                }
              </td>
              <td><span class="trt-state" [attr.data-cat]="row.stateCategory">{{ row.state || '-' }}</span></td>
              <td (click)="$event.stopPropagation()"><app-person-pill [person]="row.assigned" [conn]="state.picked()?.id ?? null" /></td>
              <td class="trt-dim">{{ last(row.iteration) }}</td>
              <td class="trt-dim" [title]="row.changedAt ?? ''">{{ ago(row.changedAt) }}</td>
              <td class="trt-badges-td"><div class="trt-badges">
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
                    <button type="button" role="menuitem" (click)="act('NEW_BOARD', row)">＋ New board from this item…</button>
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
    .trt-title { max-width: 520px; }
    /* the loading skeleton: grey bars in the table's own shape, a soft sheen passing over each row a little later */
    .trt-searching::after { content: '…'; }
    .trt-sk td { height: 2.2rem; border-bottom-color: color-mix(in srgb, var(--border) 50%, transparent); }
    .trt-sk td:nth-child(3) { min-width: 240px; white-space: nowrap; }
    .trt-sk td:nth-child(3) .sk-t { max-width: calc(100% - 2.5rem); }
    .sk { display: inline-block; height: .7rem; border-radius: 4px; background: rgba(255,255,255,.06); position: relative; overflow: hidden; vertical-align: middle; }
    .sk::after { content: ''; position: absolute; inset: 0; transform: translateX(-100%);
      background: linear-gradient(90deg, transparent, rgba(255,255,255,.11), transparent); animation: trt-sheen 1.3s ease-in-out infinite; }
    .sk-t { height: .75rem; }
    .sk-box { height: 1rem; }
    .sk-round { height: 1.15rem; border-radius: 999px; }
    .sk-in { display: inline-block; }
    .trt-sk:nth-child(2) .sk::after { animation-delay: .08s; } .trt-sk:nth-child(3) .sk::after { animation-delay: .16s; }
    .trt-sk:nth-child(4) .sk::after { animation-delay: .24s; } .trt-sk:nth-child(5) .sk::after { animation-delay: .32s; }
    .trt-sk:nth-child(6) .sk::after { animation-delay: .4s; } .trt-sk:nth-child(7) .sk::after { animation-delay: .48s; }
    .trt-sk:nth-child(8) .sk::after { animation-delay: .56s; }
    @keyframes trt-sheen { to { transform: translateX(100%); } }
    @media (prefers-reduced-motion: reduce) { .sk::after { animation: none; } }
    .trt-show-l { color: var(--text-faint); font-size: .74rem; }
    .trt-seg { display: inline-flex; border: 1px solid var(--border-strong); border-radius: 7px; overflow: hidden; }
    .trt-seg button { border: 0; border-right: 1px solid var(--border); background: none; color: var(--text-dim); font-size: .74rem; padding: .18rem .55rem; cursor: pointer; }
    .trt-seg button:last-child { border-right: 0; }
    .trt-seg button.on { background: rgba(139,92,246,.22); color: var(--text); }
    .trt-tree { display: flex; align-items: center; gap: .25rem; }
    .trt-fold { flex: none; align-self: flex-start; width: 1.1rem; border: 0; background: none; color: var(--text-faint); cursor: pointer; padding: 0; line-height: 1.4; }
    .trt-fold:hover { color: var(--text); }
    .trt-fold-pad { flex: none; width: 1.1rem; }
    .trt-match { font-weight: 500; }
    .trt-ctx { flex: none; margin-left: .3rem; padding: 0 .3rem; border: 1px dashed var(--border-strong); border-radius: 4px; color: var(--text-faint); font-size: .62rem; }
    .trt tr.ctx td:not(.trt-badges-td):not(.trt-add) { opacity: .62; }
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
  /** The Show switch and the children depth, owned by the page (a change searches again). */
  readonly show = input<ShowMode>('ITEMS');
  readonly childDepth = input<number>(1);
  readonly showChange = output<ShowMode>();
  /** Azure is being read: skeleton rows instead of the (older) result. */
  readonly loading = input(false);
  /** Bar widths per skeleton row: id, type, title %, state, person, iteration %, age, tree depth. */
  readonly skeleton: readonly (readonly number[])[] = [[46, 40, 78, 44, 92, 70, 26, 0], [46, 34, 62, 52, 80, 74, 26, 1], [46, 40, 88, 40, 96, 62, 22, 2],
    [46, 30, 55, 48, 76, 70, 26, 2], [46, 40, 72, 44, 88, 66, 22, 0], [46, 34, 66, 52, 84, 70, 26, 1], [46, 40, 80, 40, 92, 58, 22, 2],
    [46, 30, 58, 48, 80, 70, 26, 1]];
  readonly depthChange = output<number>();
  readonly opened = output<SearchRow>();
  readonly page = output<number>();
  readonly action = output<{ action: RowAction; row: SearchRow }>();

  readonly menu = signal<string | null>(null);
  readonly folded = signal<ReadonlySet<string>>(new Set());
  readonly modes: { id: ShowMode; label: string }[] = [
    { id: 'ITEMS', label: 'Items only' }, { id: 'PARENTS', label: 'With parents' }, { id: 'TREE', label: 'Full tree' },
  ];
  /** What the shown result was read as (a click on Show re-reads; until then the old shape stays). */
  readonly mode = computed<ShowMode>(() => this.result()?.show ?? 'ITEMS');
  readonly lines = computed(() => {
    const r = this.result();
    return r ? treeLines(r, this.folded()) : [];
  });

  fold(id: string): void {
    this.folded.update((f) => {
      const next = new Set(f);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  }

  foldAll(): void {
    if (this.folded().size) {
      this.folded.set(new Set());
      return;
    }
    const r = this.result();
    const all = treeLines(r!, new Set()).filter((l) => l.kids > 0).map((l) => l.row.id);
    this.folded.set(new Set(all));
  }

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
