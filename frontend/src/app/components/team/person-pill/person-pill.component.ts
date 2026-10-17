import { Component, computed, inject, input, signal } from '@angular/core';
import { TeamApiService } from '../../../core/team/team-api.service';
import { TeamStateService } from '../../../core/team/team-state.service';
import { PersonCard, TeamPerson } from '../../../core/team/team.models';

/**
 * A person as a pill (specs/028 FR-085): name (never a raw id), "me" marked, and on hover a card with their email,
 * teams, open items and Alfred cards - read once, on first hover.
 */
@Component({
  selector: 'app-person-pill',
  standalone: true,
  template: `
    @if (shown(); as p) {
      <span class="pp" [class.me]="isMe()" tabindex="0" (mouseenter)="load()" (focus)="load()" [title]="p.email || p.name">
        <span class="pp-av">{{ initials(p.name) }}</span>{{ p.name }}@if (isMe()) { <span class="pp-me">me</span> }
        @if (card(); as c) {
          <span class="pp-card" role="tooltip">
            <b>{{ c.person.name }}</b>@if (c.me) { <span class="pp-me">me</span> }
            @if (c.person.email) { <span class="pp-line">{{ c.person.email }}</span> }
            @if (c.teams.length) { <span class="pp-line">{{ c.teams.map(teamName).join(', ') }}</span> }
            <span class="pp-line">{{ c.assignedOpen === null ? 'Open items: enter a token to count' : c.assignedOpen + ' open items assigned' }}</span>
            <span class="pp-line">{{ c.cardsOwned.length }} cards owned · {{ c.cardsMentioning.length }} mention them · {{ c.boards.length }} boards</span>
            <span class="pp-line pp-dim">{{ conn() }}/{{ c.person.extId }}</span>
          </span>
        }
      </span>
    } @else { <span class="pp pp-none">-</span> }`,
  styles: [`
    :host { display: inline-block; }
    .pp { position: relative; display: inline-flex; align-items: center; gap: .3rem; padding: 0 .45rem 0 .1rem; border-radius: 999px;
      background: var(--card-inner); border: 1px solid var(--border); font-size: .78rem; white-space: nowrap; cursor: default; }
    .pp.me { border-color: var(--purple-light); }
    .pp-none { padding: 0 .4rem; color: var(--text-faint); }
    .pp-av { display: inline-grid; place-items: center; width: 1.2rem; height: 1.2rem; border-radius: 50%; background: var(--purple-dim, #4b3b77);
      color: #fff; font-size: .6rem; font-weight: 600; }
    .pp-me { margin-left: .2rem; padding: 0 .3rem; border-radius: 4px; background: var(--purple-light); color: #fff; font-size: .62rem; }
    .pp-card { display: none; position: absolute; z-index: 60; top: 1.5rem; left: 0; min-width: 220px; max-width: 320px; padding: .5rem .6rem;
      border: 1px solid var(--border-strong); border-radius: 8px; background: var(--popover-solid); white-space: normal; box-shadow: 0 6px 20px rgba(0,0,0,.3); }
    .pp:hover .pp-card, .pp:focus .pp-card { display: block; }
    .pp-line { display: block; margin-top: .2rem; font-size: .76rem; }
    .pp-dim { color: var(--text-faint); }
  `],
})
export class PersonPillComponent {
  private readonly api = inject(TeamApiService);
  private readonly state = inject(TeamStateService);

  readonly person = input<TeamPerson | null>(null);
  /** Or by id / unique name, resolved from the lists. */
  readonly personId = input<string | null>(null);
  readonly conn = input<string | null>(null);

  readonly card = signal<PersonCard | null>(null);
  private loading = false;

  readonly shown = computed<TeamPerson | null>(() => this.person() ?? this.state.personOf(this.personId()) ??
    (this.personId() ? { extId: this.personId(), name: this.personId()!, email: null } : null));
  readonly isMe = computed(() => {
    const me = this.state.me()?.person;
    const p = this.shown();
    return !!me && !!p && ((!!p.extId && p.extId === me.extId) || (!!p.email && p.email.toLowerCase() === (me.email ?? '').toLowerCase()));
  });

  initials(name: string): string {
    return (name || '?').split(/[\s.@]+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join('');
  }

  teamName(t: { name: string }): string {
    return t.name;
  }

  load(): void {
    const conn = this.conn() ?? this.state.picked()?.id;
    const id = this.shown()?.extId;
    if (this.loading || this.card() || !conn || !id) return;
    this.loading = true;
    this.api.person(conn, id).subscribe({ next: (c) => this.card.set(c), error: () => (this.loading = false) });
  }
}
