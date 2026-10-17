import { Component, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { TeamApiService } from '../../../core/team/team-api.service';
import { TeamStateService } from '../../../core/team/team-state.service';
import { IncomingRow } from '../../../core/team/team.models';
import { PickedTarget, TeamBoardPickerComponent } from '../board-picker/board-picker.component';

const SOURCE: Record<IncomingRow['source'], string> = { TREE: 'new in the tree', RULE: 'watch rule', HOOK: 'service hook', HAND: 'added by hand', MCP: 'from Claude' };

/**
 * A board's Incoming lane (specs/028 US3 FR-050..056): work items that arrived for this board - new in the main's tree,
 * matched by a watch rule, pushed by the service hook, added by hand or by Claude - each offered once. "Looks like #n"
 * when a card already matches; Claude's proposal waits for Accept. New card, Link to a card, or Ignore (until it changes).
 */
@Component({
  selector: 'app-team-incoming-lane',
  standalone: true,
  imports: [FormsModule, TeamBoardPickerComponent],
  template: `
    <section class="til">
      <h4>Incoming <span class="til-dim">{{ waiting().length }}</span></h4>
      @for (r of waiting(); track r.conn + r.item) {
        <div class="til-row">
          <span class="til-what"><span class="til-dim">{{ r.type }} {{ r.item }}</span> {{ r.title }}
            <span class="til-src">{{ source(r) }}</span></span>
          @if (r.matchCard) { <span class="til-match" [title]="'Similarity ' + (r.matchScore ?? 0)">Looks like {{ r.matchCard }}</span> }
          @if (r.proposalAction) {
            <span class="til-prop">✦ Claude: {{ r.proposalAction === 'NEW' ? 'a new card' : 'link to ' + r.proposalCard }}{{ r.proposalReason ? ' - ' + r.proposalReason : '' }}
              @if (editable()) { <button type="button" class="action-btn primary" (click)="accept(r)">Accept</button> }</span>
          }
          @if (editable()) {
            <span class="til-acts">
              <button type="button" class="action-btn" (click)="card(r)">New card</button>
              @if (r.matchCard) { <button type="button" class="action-btn" (click)="link(r, r.matchCard)">Link to {{ r.matchCard }}</button> }
              <button type="button" class="action-btn" (click)="linking.set(r)">Link to card…</button>
              <button type="button" class="action-btn" (click)="ignore(r)" title="Hidden until it changes in the tracker">Ignore</button>
            </span>
          }
        </div>
      } @empty { <div class="til-dim">Nothing waiting. New items under the main item, watch rule matches and hook pings land here.</div> }
      @if (editable()) {
        <form class="til-add" (submit)="$event.preventDefault(); add()">
          <input [(ngModel)]="ref" name="ref" placeholder="Offer an item here by id" aria-label="Work item id" />
          <button type="submit" class="action-btn" [disabled]="!ref.trim()">+ Incoming</button>
          <label class="til-check"><input type="checkbox" [(ngModel)]="markers" name="markers" /> New cards also tell the tracker (waits for approval)</label>
        </form>
      }
      @if (message()) { <div class="til-msg" [class.err]="isError()">{{ message() }}</div> }
    </section>
    @if (linking(); as r) {
      <app-team-board-picker title="Link to which card?" action="Link" [card]="true" (picked)="picked($event, r)" (closed)="linking.set(null)" />
    }`,
  styles: [`
    .til { margin-top: .6rem; display: grid; gap: .35rem; }
    h4 { margin: 0; }
    .til-row { display: flex; flex-wrap: wrap; gap: .4rem; align-items: center; padding: .35rem .5rem; border: 1px solid var(--border); border-radius: 7px; font-size: .82rem; }
    .til-what { flex: 1 1 260px; }
    .til-src { margin-left: .3rem; padding: 0 .35rem; border-radius: 4px; background: var(--card-inner); font-size: .72rem; color: var(--text-dim); }
    .til-match { color: var(--amber); font-size: .78rem; }
    .til-prop { color: var(--purple-light); font-size: .78rem; display: inline-flex; gap: .3rem; align-items: center; }
    .til-acts { display: flex; flex-wrap: wrap; gap: .25rem; }
    .til-dim { color: var(--text-dim); font-size: .8rem; }
    .til-add { display: flex; flex-wrap: wrap; gap: .4rem; align-items: center; font-size: .8rem; }
    .til-add input[name=ref] { padding: .25rem .5rem; border: 1px solid var(--border-strong); border-radius: 6px; background: var(--card-inner); color: inherit; }
    .til-check { display: inline-flex; gap: .25rem; align-items: center; color: var(--text-dim); }
    .til-msg { font-size: .8rem; color: var(--green); }
    .til-msg.err { color: var(--red); }
  `],
})
export class TeamIncomingLaneComponent {
  private readonly api = inject(TeamApiService);
  private readonly state = inject(TeamStateService);

  readonly boardId = input.required<string>();
  readonly editable = input(true);

  readonly rows = signal<IncomingRow[]>([]);
  readonly waiting = computed(() => this.rows().filter((r) => r.state === 'WAITING'));
  readonly linking = signal<IncomingRow | null>(null);
  readonly message = signal<string | null>(null);
  readonly isError = signal(false);
  ref = '';
  markers = false;

  constructor() {
    effect(() => {
      const id = this.boardId();
      untracked(() => this.load(id));
    });
    effect(() => {
      const e = this.state.boardEvent();
      if (e && e.board === this.boardId() && ['incoming', 'sync', 'cards'].includes(e.what)) untracked(() => this.load(this.boardId()));
    });
  }

  private load(id: string): void {
    this.api.incoming(id).subscribe({ next: (r) => this.boardId() === id && this.rows.set(r), error: () => this.rows.set([]) });
  }

  private say(m: string, err = false): void {
    this.message.set(m);
    this.isError.set(err);
  }

  private fail = (e: { error?: { message?: string } }) => this.say(e?.error?.message || 'Could not do it', true);

  source(r: IncomingRow): string {
    return SOURCE[r.source] ?? r.source.toLowerCase();
  }

  card(r: IncomingRow): void {
    this.api.incomingCard(this.boardId(), r.conn, r.item, this.markers).subscribe({
      next: (c) => {
        this.say(`Card ${c.cardId} created`);
        this.load(this.boardId());
      },
      error: this.fail,
    });
  }

  link(r: IncomingRow, cardId: string): void {
    this.api.incomingLink(this.boardId(), r.conn, r.item, cardId, this.markers).subscribe({
      next: () => {
        this.say(`${r.item} linked to ${cardId}`);
        this.load(this.boardId());
      },
      error: this.fail,
    });
  }

  picked(t: PickedTarget, r: IncomingRow): void {
    this.linking.set(null);
    if (t.card) {
      this.markers = this.markers || t.markers;
      this.link(r, t.card.id);
    }
  }

  accept(r: IncomingRow): void {
    if (r.proposalAction === 'LINK' && r.proposalCard) this.link(r, r.proposalCard);
    else this.card(r);
  }

  ignore(r: IncomingRow): void {
    this.api.incomingIgnore(this.boardId(), r.conn, r.item).subscribe({ next: () => this.load(this.boardId()), error: this.fail });
  }

  add(): void {
    const conn = this.state.picked()?.id;
    const ref = this.ref.trim().replace(/^AB#/i, '');
    if (!conn || !ref) return;
    this.api.addIncoming(this.boardId(), conn, ref).subscribe({
      next: () => {
        this.ref = '';
        this.load(this.boardId());
      },
      error: this.fail,
    });
  }
}
