import { Component, computed, effect, inject, output, signal, untracked } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { TeamApiService } from '../../../core/team/team-api.service';
import { TeamStateService } from '../../../core/team/team-state.service';
import { TeamChange } from '../../../core/team/team.models';

/**
 * What changed in the tracker since the last refreshes (specs/027 US7): one line per item revision, newest first, the
 * ones nobody marked seen highlighted. The seen mark is shared by everyone looking at this connection.
 */
@Component({
  selector: 'app-team-changes-feed',
  standalone: true,
  imports: [FormsModule],
  template: `
    <div class="tcf-filters">
      <input [ngModel]="squad()" (ngModelChange)="squad.set($event)" [placeholder]="state.ui().word('squad')" [attr.aria-label]="state.ui().word('squad')" />
      <input [ngModel]="person()" (ngModelChange)="person.set($event)" placeholder="Changed by" aria-label="Changed by" />
      <span class="tcf-grow"></span>
      @if (freshCount()) {
        <button type="button" class="action-btn" (click)="seen()" title="Marks them seen for everyone">✓ Mark {{ freshCount() }} seen</button>
      }
    </div>
    @for (c of shown(); track c.id) {
      <div class="tcf-row" [class.fresh]="c.fresh" (click)="opened.emit(c)" tabindex="0" (keydown.enter)="opened.emit(c)">
        <span class="tcf-when">{{ c.at.slice(0, 16).replace('T', ' ') }}</span>
        <span class="tcf-id">{{ c.extId }}</span>
        <span class="tcf-title">{{ c.title }}</span>
        <span class="tcf-sum">{{ c.summary }}</span>
        <span class="tcf-by">{{ c.by }}</span>
      </div>
    } @empty { <div class="tcf-empty">No changes recorded - each Refresh records what changed since the one before.</div> }
    @if (more()) { <button type="button" class="action-btn" (click)="older()">Older…</button> }`,
  styles: [`
    .tcf-filters { display: flex; gap: .4rem; align-items: center; margin-bottom: .5rem; }
    .tcf-filters input { padding: .25rem .5rem; border: 1px solid var(--border-strong); border-radius: 6px; background: var(--card-inner); color: inherit; width: 150px; }
    .tcf-grow { flex: 1; }
    .tcf-row { display: grid; grid-template-columns: 120px 70px minmax(160px, 1.2fr) minmax(160px, 1.5fr) 140px; gap: .5rem; padding: .3rem .4rem;
      border-bottom: 1px solid var(--border); font-size: .82rem; cursor: pointer; }
    .tcf-row:hover { background: rgba(139,92,246,.1); }
    .tcf-row.fresh { border-left: 3px solid var(--purple-light); }
    .tcf-when, .tcf-id, .tcf-by { color: var(--text-dim); }
    .tcf-title, .tcf-sum { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .tcf-empty { color: var(--text-faint); font-size: .84rem; }
  `],
})
export class TeamChangesFeedComponent {
  readonly state = inject(TeamStateService);
  private readonly api = inject(TeamApiService);
  readonly opened = output<TeamChange>();

  readonly squad = signal('');
  readonly person = signal('');
  readonly changes = signal<TeamChange[]>([]);
  readonly more = signal(false);
  private readonly pageSize = 100;
  private asked = 0;

  readonly shown = computed(() => this.changes());
  readonly freshCount = computed(() => this.changes().filter((c) => c.fresh).length);

  constructor() {
    effect(() => {
      const conn = this.state.picked()?.id ?? null;
      this.state.changesVersion();
      const squad = this.squad().trim();
      const person = this.person().trim();
      untracked(() => this.load(conn, squad, person, undefined));
    });
  }

  older(): void {
    const last = this.changes().at(-1);
    const conn = this.state.picked()?.id ?? null;
    if (last) this.load(conn, this.squad().trim(), this.person().trim(), last.id);
  }

  seen(): void {
    const conn = this.state.picked()?.id;
    if (conn) this.api.markSeen(conn).subscribe({ error: () => undefined });
  }

  private load(conn: string | null, squad: string, person: string, after: number | undefined): void {
    if (!conn) {
      this.changes.set([]);
      return;
    }
    const mine = ++this.asked;
    this.api.changes(conn, { squad: squad || undefined, person: person || undefined, after }, this.pageSize).subscribe({
      next: (page) => {
        if (mine !== this.asked) return;
        this.changes.update((old) => (after === undefined ? page : [...old, ...page]));
        this.more.set(page.length === this.pageSize);
      },
      error: () => undefined,
    });
  }
}
