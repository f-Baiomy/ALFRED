import { NgTemplateOutlet } from '@angular/common';
import { Component, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { ConfirmDialogService } from '../../../core/services/confirm-dialog.service';
import { TeamApiService } from '../../../core/team/team-api.service';
import { TeamStateService } from '../../../core/team/team-state.service';
import { BoardItem, BoardItemsView, SyncRow, closedCategory } from '../../../core/team/team.models';
import { byType, layoutTree } from '../../../shared/utils/tree-layout';
import { DiffLine, diffLines } from '../../../shared/utils/item-diff';
import { RowAction } from '../results-table/results-table.component';
import { TeamItemDrawerComponent } from '../item-drawer/item-drawer.component';
import { PickedTarget, TeamBoardPickerComponent } from '../board-picker/board-picker.component';
import { TeamIncomingLaneComponent } from '../incoming-lane/incoming-lane.component';
import { TeamWatchRulesComponent } from '../watch-rules/watch-rules.component';

/**
 * A board's Related items (specs/028 US2, FR-030..041): its main work item and that item's tree - ancestors, descendants,
 * one hop of links - plus items added by hand. The main and card items are kept in full (a copy, diffed on each sync);
 * the rest are references read live. Opening the tab syncs at most once a minute; Refresh all syncs now.
 */
@Component({
  selector: 'app-team-related-items',
  standalone: true,
  imports: [NgTemplateOutlet, FormsModule, RouterLink, TeamItemDrawerComponent, TeamBoardPickerComponent, TeamIncomingLaneComponent, TeamWatchRulesComponent],
  template: `
    <div class="tri">
      <div class="tri-main">
        @if (view()?.main; as m) {
          <span class="tri-star">★ Main</span>
          <button type="button" class="tri-open" (click)="open(m)"><span class="tri-dim">{{ m.row.type }} {{ m.row.item }}</span> {{ m.row.title }}</button>
          <span class="tri-state" [attr.data-cat]="m.row.stateCategory">{{ m.row.state }}</span>
          @if (m.changed) { <button type="button" class="tri-changed" (click)="showDiff(m)" [title]="'Changed since the saved copy'">● changed · Review</button> }
        } @else {
          <span class="tri-dim">No main item - the work item this board is for.</span>
        }
        <span class="tri-grow"></span>
        <span class="tri-dim">{{ view()?.syncedAt ? 'Synced ' + view()!.syncedAt!.slice(0, 16).replace('T', ' ') : 'Not synced yet' }}</span>
        <button type="button" class="action-btn" [disabled]="!state.hasToken() || syncing()" (click)="sync(true)">{{ syncing() ? 'Syncing…' : '↻ Refresh all' }}</button>
      </div>
      @if (!state.hasToken()) { <div class="tri-warn">Enter a token on the <a routerLink="/team">Team tab</a> to read these items live; saved copies still show.</div> }
      @if (message()) { <div class="tri-msg" [class.err]="isError()" role="status">{{ message() }}</div> }

      <form class="tri-add" (submit)="$event.preventDefault(); add(false)">
        <input [(ngModel)]="ref" name="ref" placeholder="Add by id, AB#id or URL" aria-label="Work item id or URL" />
        <button type="submit" class="action-btn" [disabled]="!ref.trim() || !editable()">+ Add related</button>
        <button type="button" class="action-btn" [disabled]="!ref.trim() || !editable()" (click)="add(true)">★ Make main</button>
        <a class="action-btn" routerLink="/team">Find in Team ↗</a>
        <span class="tri-grow"></span>
        <span class="tri-toggle" role="group" aria-label="Layout">
          <button type="button" [class.on]="layout() === 'tree'" (click)="layout.set('tree')">Tree</button>
          <button type="button" [class.on]="layout() === 'type'" (click)="layout.set('type')">By type</button>
        </span>
      </form>

      @if (changedCount()) {
        <div class="tri-warn">{{ changedCount() }} item(s) changed in {{ state.ui().label }} since the last look.</div>
      }

      <table class="tri-table">
        <thead><tr><th>Item</th><th>State</th><th>Kept</th><th>Cards</th><th></th></tr></thead>
        <tbody>
          @if (layout() === 'tree') {
            @for (l of lines(); track l.item.row.conn + l.item.row.item) {
              @if (l.group !== 'tree' && ($index === 0 || l.group !== lines()[$index - 1].group)) {
                <tr class="tri-sep"><td colspan="5">{{ l.group === 'link' ? 'Linked' : 'Added by hand, or left the tree' }}</td></tr>
              }
              <ng-container *ngTemplateOutlet="row; context: { $implicit: l.item, indent: l.indent }" />
            }
          } @else {
            @for (g of groups(); track g.type) {
              <tr class="tri-sep"><td colspan="5">{{ g.type }} · {{ g.items.length }}</td></tr>
              @for (i of g.items; track i.row.conn + i.row.item) { <ng-container *ngTemplateOutlet="row; context: { $implicit: i, indent: 0 }" /> }
            }
          }
          @if (!view()?.items?.length && !view()?.main) {
            <tr><td colspan="5" class="tri-dim">Nothing related yet. Add the work item this board is for as its main item, or Start it from the Team tab.</td></tr>
          }
        </tbody>
      </table>

      <ng-template #row let-i let-indent="indent">
        <tr [class.closed]="closed(i)" [class.left]="!!i.row.leftTreeAt">
          <td [style.padding-left.rem]="0.45 + indent * 1.1">
            <button type="button" class="tri-open" (click)="open(i)">
              @if (i.row.role === 'MAIN') { ★ } <span class="tri-dim">{{ i.row.type }} {{ i.row.item }}</span> {{ i.row.title }}</button>
            @if (i.row.linkKind) { <span class="tri-dim"> · {{ i.row.linkKind }}</span> }
            @if (i.row.leftTreeAt) { <span class="tri-dim" title="No longer under the main in the tracker"> · left the tree</span> }
          </td>
          <td><span class="tri-state" [attr.data-cat]="i.row.stateCategory">{{ i.row.state || '-' }}</span></td>
          <td class="tri-dim">
            @if (i.hasCopy) { full copy{{ i.copyRev ? ' (rev ' + i.copyRev + ')' : '' }} } @else { reference }
            @if (i.changed) { <button type="button" class="tri-changed" (click)="showDiff(i)" title="Changed since the saved copy - review">● changed</button> }
          </td>
          <td>@for (c of i.cards; track c) { <span class="tri-card">▣ {{ c }}</span> }</td>
          <td class="tri-acts">
            @if (editable()) {
              @if (i.row.role !== 'MAIN') { <button type="button" class="tri-act" title="Make it the main item" (click)="makeMain(i)">★</button> }
              <button type="button" class="tri-act" title="Remove from this board" (click)="unlink(i)">✕</button>
            }
          </td>
        </tr>
        @if (diffOf() === key(i)) {
          <tr class="tri-diff"><td colspan="5">
            @for (d of diff(); track d.field) {
              <div><b>{{ d.field }}</b> <span class="tri-before">{{ d.from || '-' }}</span> → <span class="tri-after">{{ d.to || '-' }}</span></div>
            } @empty { <span class="tri-dim">{{ syncsLoading() ? 'Reading…' : 'No saved difference' }}</span> }
            @if (editable()) { <button type="button" class="action-btn" (click)="keep(i)">Keep the new copy</button> }
            <button type="button" class="action-btn" (click)="diffOf.set(null)">Close</button>
          </td></tr>
        }
      </ng-template>

      <app-team-incoming-lane [boardId]="boardId()" [editable]="editable()" />
      <app-team-watch-rules [boardId]="boardId()" [editable]="editable()" />
    </div>

    @if (opened(); as o) {
      <app-team-item-drawer [conn]="o.conn" [itemId]="o.item" (closed)="opened.set(null)" (openOther)="opened.set({ conn: o.conn, item: $event })"
                            (action)="drawerAction($event, o.conn, o.item)" />
    }
    @if (linking(); as l) {
      <app-team-board-picker title="Link to which card?" action="Link" [card]="true" (picked)="linked($event, l.conn, l.item)" (closed)="linking.set(null)" />
    }`,
  styles: [`
    .tri { display: grid; gap: .5rem; }
    .tri-main, .tri-add { display: flex; flex-wrap: wrap; gap: .4rem; align-items: center; font-size: .84rem; }
    .tri-star { color: var(--purple-light); font-weight: 600; }
    .tri-grow { flex: 1; }
    .tri-dim { color: var(--text-dim); font-size: .8rem; }
    .tri-warn { color: var(--amber); font-size: .8rem; }
    .tri-msg { font-size: .8rem; color: var(--green); }
    .tri-msg.err { color: var(--red); }
    .tri-add input { flex: 0 1 260px; padding: .25rem .5rem; border: 1px solid var(--border-strong); border-radius: 6px; background: var(--card-inner); color: inherit; }
    .tri-toggle button { border: 1px solid var(--border-strong); background: none; color: var(--text-dim); padding: .15rem .55rem; cursor: pointer; }
    .tri-toggle button:first-child { border-radius: 6px 0 0 6px; }
    .tri-toggle button:last-child { border-radius: 0 6px 6px 0; }
    .tri-toggle button.on { color: var(--text); background: rgba(139,92,246,.18); }
    .tri-table { width: 100%; border-collapse: collapse; font-size: .82rem; }
    .tri-table th, .tri-table td { padding: .3rem .45rem; border-bottom: 1px solid var(--border); text-align: left; vertical-align: top; }
    .tri-table th { color: var(--text-dim); font-weight: 500; font-size: .74rem; }
    .tri-table tr.closed td { opacity: .6; }
    .tri-table tr.left td { font-style: italic; }
    .tri-sep td { color: var(--text-dim); font-size: .74rem; background: var(--card-inner); }
    .tri-open { border: 0; background: none; color: inherit; padding: 0; text-align: left; cursor: pointer; }
    .tri-state { padding: 0 .35rem; border-radius: 4px; background: var(--card-inner); white-space: nowrap; }
    .tri-state[data-cat='Resolved'] { color: var(--green); }
    .tri-state[data-cat='Completed'], .tri-state[data-cat='Removed'] { color: var(--text-faint); }
    .tri-changed { border: 0; background: none; color: var(--amber); cursor: pointer; font-size: .78rem; }
    .tri-card { margin-right: .25rem; font-size: .76rem; }
    .tri-acts { white-space: nowrap; }
    .tri-act { border: 0; background: none; color: var(--text-dim); cursor: pointer; }
    .tri-diff td { background: var(--card-inner); font-size: .8rem; }
    .tri-before { color: var(--red); }
    .tri-after { color: var(--green); }
  `],
})
export class TeamRelatedItemsComponent {
  readonly state = inject(TeamStateService);
  private readonly api = inject(TeamApiService);
  private readonly confirm = inject(ConfirmDialogService);

  readonly boardId = input.required<string>();
  readonly editable = input(true);

  readonly view = signal<BoardItemsView | null>(null);
  readonly layout = signal<'tree' | 'type'>('tree');
  readonly syncing = signal(false);
  readonly message = signal<string | null>(null);
  readonly isError = signal(false);
  readonly opened = signal<{ conn: string; item: string } | null>(null);
  readonly linking = signal<{ conn: string; item: string } | null>(null);
  readonly diffOf = signal<string | null>(null);
  readonly diff = signal<DiffLine[]>([]);
  readonly syncsLoading = signal(false);
  ref = '';
  private asked = 0;

  readonly lines = computed(() => layoutTree(this.view()?.main ?? null, this.view()?.items ?? []));
  readonly groups = computed(() => byType(this.lines().map((l) => l.item)));
  readonly changedCount = computed(() => this.lines().filter((l) => l.item.changed).length);

  constructor() {
    if (!this.state.loaded()) this.state.load();
    effect(() => {
      const id = this.boardId();
      untracked(() => {
        this.load(id);
        if (this.state.hasToken()) this.sync(false);
      });
    });
    effect(() => {
      const e = this.state.boardEvent();
      if (!e || e.board !== this.boardId()) return;
      untracked(() => {
        if (e.what === 'sync') {
          this.syncing.set(false);
          if (e['error']) this.say(String(e['message'] ?? 'The sync failed'), true);
        }
        if (['items', 'sync', 'cards'].includes(e.what)) this.load(this.boardId());
      });
    });
  }

  private load(id: string): void {
    const mine = ++this.asked;
    this.api.boardItems(id).subscribe({ next: (v) => mine === this.asked && this.view.set(v), error: () => mine === this.asked && this.view.set(null) });
  }

  private say(m: string | null, err = false): void {
    this.message.set(m);
    this.isError.set(err);
  }

  key(i: BoardItem): string {
    return i.row.conn + '/' + i.row.item;
  }

  closed(i: BoardItem): boolean {
    return closedCategory(i.row.stateCategory);
  }

  open(i: BoardItem): void {
    this.opened.set({ conn: i.row.conn, item: i.row.item });
  }

  sync(force: boolean): void {
    this.syncing.set(true);
    this.api.sync(this.boardId(), force).subscribe({
      next: () => undefined, // the 'sync' signal on /ws/teamboards says when it is done
      error: (e) => {
        this.syncing.set(false);
        this.say(e?.error?.message || 'Could not sync', true);
      },
    });
  }

  /** The conn to add with: the picked one (a board's items may come from one tracker only in practice). */
  private conn(): string | null {
    return this.view()?.main?.row.conn ?? this.state.picked()?.id ?? null;
  }

  add(asMain: boolean, maxRefs?: number): void {
    const conn = this.conn();
    const ref = this.ref.trim();
    if (!conn || !ref) return;
    const isUrl = /^https?:/i.test(ref);
    this.api.addBoardItem(this.boardId(), { conn, ...(isUrl ? { url: ref } : { item: ref }), asMain, maxRefs }).subscribe({
      next: (v) => {
        this.view.set(v);
        this.ref = '';
        this.say(asMain ? 'Main item set' : 'Added');
      },
      error: async (e) => {
        if (e?.error?.error === 'ASK' && !maxRefs) {
          if (await this.confirm.confirm(e.error.message, 'Add them all')) this.add(asMain, 1000);
          return;
        }
        this.say(e?.error?.message || 'Could not add it', true);
      },
    });
  }

  async makeMain(i: BoardItem, maxRefs?: number): Promise<void> {
    this.api.setMain(this.boardId(), i.row.conn, i.row.item, maxRefs).subscribe({
      next: (r) => {
        this.view.set(r.view);
        this.say(r.reseedOffer ? `Main item is now ${i.row.item}. Re-seed the brief from it with /alfred-spec.` : `Main item is now ${i.row.item}`);
      },
      error: async (e) => {
        if (e?.error?.error === 'ASK' && !maxRefs) {
          if (await this.confirm.confirm(e.error.message, 'Add them all')) void this.makeMain(i, 1000);
          return;
        }
        this.say(e?.error?.message || 'Could not make it the main item', true);
      },
    });
  }

  async unlink(i: BoardItem): Promise<void> {
    if (i.row.role === 'MAIN' && this.lines().some((l) => l.item.row.role === 'CARD' || l.item.row.relation === 'ADDED')) {
      this.say('Make another item the main (★) first - a board keeps one main while it has items', true);
      return;
    }
    const what = i.row.role === 'MAIN' ? `Remove the main item ${i.row.item} and its tree from this board?` : `Remove ${i.row.item} from this board?`;
    if (!(await this.confirm.confirm(what, 'Remove'))) return;
    this.api.unlinkBoardItem(this.boardId(), i.row.conn, i.row.item).subscribe({
      next: (v) => this.view.set(v),
      error: (e) => this.say(e?.error?.message || 'Could not remove it', true),
    });
  }

  showDiff(i: BoardItem): void {
    const k = this.key(i);
    if (this.diffOf() === k) {
      this.diffOf.set(null);
      return;
    }
    this.diffOf.set(k);
    this.diff.set([]);
    this.syncsLoading.set(true);
    this.api.syncs(this.boardId(), i.row.conn, i.row.item).subscribe({
      next: (rows: SyncRow[]) => {
        this.syncsLoading.set(false);
        const open = rows.filter((r) => !r.kept);
        this.diff.set(diffLines(open.flatMap((r) => r.diff)));
      },
      error: () => this.syncsLoading.set(false),
    });
  }

  keep(i: BoardItem): void {
    this.api.keep(this.boardId(), i.row.conn, i.row.item).subscribe({
      next: (v) => {
        this.view.set(v);
        this.diffOf.set(null);
      },
      error: (e) => this.say(e?.error?.message || 'Could not keep it', true),
    });
  }

  drawerAction(a: RowAction, conn: string, item: string): void {
    const board = this.boardId();
    const fail = (e: { error?: { message?: string } }) => this.say(e?.error?.message || 'Could not do it', true);
    switch (a) {
      case 'MAIN':
        this.api.setMain(board, conn, item).subscribe({ next: (r) => this.view.set(r.view), error: fail });
        break;
      case 'RELATED':
        this.api.addBoardItem(board, { conn, item }).subscribe({ next: (v) => this.view.set(v), error: fail });
        break;
      case 'NEW_CARD':
        this.api.addIncoming(board, conn, item).subscribe({
          next: () => this.api.incomingCard(board, conn, item).subscribe({ next: (r) => this.say(`Card ${r.cardId} created`), error: fail }),
          error: fail,
        });
        break;
      case 'LINK_CARD':
        this.linking.set({ conn, item });
        break;
      case 'START':
        break;
    }
  }

  linked(t: PickedTarget, conn: string, item: string): void {
    this.linking.set(null);
    if (!t.card) return;
    this.api.linkCard(t.card.id, conn, item, t.markers ? { hyperlink: true, comment: true, tag: true } : {}).subscribe({
      next: (r) => this.say(`${item} linked to #${t.card!.number}` + (r.bundle ? ' - telling the tracker waits for your approval' : '')),
      error: (e) => this.say(e?.error?.message || 'Could not link it', true),
    });
  }
}
