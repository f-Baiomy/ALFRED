import { Component, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { BoardApiService } from '../../../core/services/board-api.service';
import { TeamStateService } from '../../../core/team/team-state.service';
import { PersonPillComponent } from '../person-pill/person-pill.component';

/**
 * A card's owner (specs/028 US6 FR-089): one person of the tracker's organisation, shown as a pill; "me" one click away.
 * Stored as "<conn>/<person id>" next to the card; Claude may set it only on its own Inbox cards.
 */
@Component({
  selector: 'app-team-card-owner',
  standalone: true,
  imports: [FormsModule, PersonPillComponent],
  template: `
    @if (state.connections().length) {
      <span class="tco">
        <span class="tco-k">Owner</span>
        @if (owner(); as o) {
          <app-person-pill [person]="state.personOf(o.person) ?? { extId: o.person, name: o.name ?? o.person, email: null }" [conn]="o.conn" />
          @if (editable()) { <button type="button" class="tco-x" title="No owner" (click)="set(null)">✕</button> }
        } @else if (editable()) {
          @if (picking()) {
            <select [ngModel]="''" (ngModelChange)="set($event || null)" aria-label="Owner" name="owner">
              <option value="">Pick a person</option>
              @if (meId()) { <option [value]="meId()">me ({{ state.me()?.person?.name }})</option> }
              @for (p of state.lists()?.people ?? []; track $index) { <option [value]="p.extId ?? ''">{{ p.name }}</option> }
            </select>
          } @else {
            <button type="button" class="cd-prop cd-dash" (click)="picking.set(true)">+ owner</button>
            @if (meId()) { <button type="button" class="board-link" (click)="set(meId())">me</button> }
          }
        } @else { <span class="tco-none">-</span> }
      </span>
    }`,
  styles: [`
    .tco { display: inline-flex; gap: .3rem; align-items: center; font-size: .8rem; }
    .tco-k { color: var(--text-dim); font-size: .74rem; }
    .tco-x { border: 0; background: none; color: var(--text-dim); cursor: pointer; }
    .tco-none { color: var(--text-faint); }
    select { padding: .1rem .3rem; border: 1px solid var(--border-strong); border-radius: 6px; background: var(--card-inner); color: inherit; }
  `],
})
export class TeamCardOwnerComponent {
  readonly state = inject(TeamStateService);
  private readonly api = inject(BoardApiService);

  readonly cardId = input.required<string>();
  readonly editable = input(true);

  private readonly raw = signal<string | null>(null);
  readonly picking = signal(false);
  /** "<conn>/<person id>|<name>". */
  readonly owner = computed(() => {
    const r = this.raw();
    const slash = r?.indexOf('/') ?? -1;
    if (!r || slash <= 0) return null;
    const bar = r.indexOf('|', slash);
    return { conn: r.slice(0, slash), person: bar > 0 ? r.slice(slash + 1, bar) : r.slice(slash + 1), name: bar > 0 ? r.slice(bar + 1) : null };
  });
  readonly meId = computed(() => this.state.me()?.person?.extId ?? null);

  constructor() {
    if (!this.state.loaded()) this.state.load();
    effect(() => {
      const id = this.cardId();
      untracked(() => {
        this.raw.set(null);
        this.api.cardOwner(id).subscribe({ next: (o) => this.cardId() === id && this.raw.set(o.owner), error: () => undefined });
      });
    });
  }

  set(person: string | null): void {
    const conn = this.state.picked()?.id;
    const name = (this.state.lists()?.people.find((p) => p.extId === person)?.name ?? (person === this.meId() ? this.state.me()?.person?.name : null) ?? person ?? '')
      .replace(/[|\]\r\n]/g, ' ').trim();
    const owner = person && conn ? `${conn}/${person}|${name || person}` : null;
    this.picking.set(false);
    this.api.setCardOwner(this.cardId(), owner).subscribe({ next: () => this.raw.set(owner), error: () => undefined });
  }
}
