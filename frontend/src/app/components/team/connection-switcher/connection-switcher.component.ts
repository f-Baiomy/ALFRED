import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { TeamApiService } from '../../../core/team/team-api.service';
import { TeamStateService } from '../../../core/team/team-state.service';
import { PersonPillComponent } from '../person-pill/person-pill.component';

/**
 * The Team tab's head (specs/028 FR-001..004): which connection, the token - entered once, kept 8 hours in Alfred's
 * memory, never on disk or in this browser - whose it is and how long it lasts, Forget, and the one-time notice that the
 * old cache was deleted by the upgrade.
 */
@Component({
  selector: 'app-connection-switcher',
  standalone: true,
  imports: [FormsModule, RouterLink, PersonPillComponent],
  template: `
    @if (state.upgradeNotice()) {
      <div class="team-banner info" role="status">
        <b>The Team tab now searches your tracker live.</b> The old cache of every work item and the old board links were deleted by
        the upgrade - nothing was migrated. Search, then add items to boards again from the results.
        <button type="button" class="action-btn" (click)="state.dismissUpgrade()">Got it</button>
      </div>
    }
    <div class="team-head">
      @if (state.connections().length > 1) {
        <select class="team-conn" [ngModel]="state.picked()?.id" (ngModelChange)="state.pick($event)" aria-label="Connection">
          @for (c of state.connections(); track c.id) { <option [value]="c.id">{{ state.uiOf(c.kind).icon }} {{ c.name }}</option> }
        </select>
      } @else if (state.picked()) {
        <b class="team-conn-one">{{ state.ui().icon }} {{ state.picked()?.name }}</b>
      }
      @if (state.picked(); as c) {
        <span class="team-grow"></span>
        @if (state.token()?.live) {
          <span class="team-live" title="Kept in Alfred's memory only - a restart or Forget drops it">● token live ·</span>
          <app-person-pill [person]="state.token()?.owner ?? null" [conn]="c.id" />
          <span class="team-dim">· {{ left() }} left</span>
          <button type="button" class="action-btn" (click)="forget(c.id)">Forget</button>
        }
      }
    </div>
    @if (state.picked(); as c) {
      @if (!state.token()?.live) {
        <div class="team-banner" role="alert">
          <b>Enter your personal access token to search {{ state.ui().label }}.</b>
          Alfred keeps it 8 hours in memory only - never on disk, in a log or in this browser - and drops it on a restart or Forget.
          Everyone using this Alfred searches with the last token entered; its owner is "me".
          <form class="team-token" (submit)="$event.preventDefault(); save(c.id)">
            <input type="password" [(ngModel)]="token" name="token" autocomplete="off" placeholder="Personal access token" aria-label="Personal access token" />
            <button type="submit" class="action-btn primary" [disabled]="!token.trim() || busy()">{{ busy() ? 'Checking…' : 'Use this token' }}</button>
          </form>
          @if (state.ui().help) { <small class="team-help">{{ state.ui().help }}</small> }
        </div>
      }
      @if (message()) { <div class="team-msg err" role="alert">{{ message() }}</div> }
    } @else if (state.loaded()) {
      <div class="team-empty">
        <b>No team tracker connected yet.</b> Add Azure DevOps (Jira and ClickUp later) in
        <a routerLink="/settings" [queryParams]="{ section: 'team-trackers' }">Settings → Team trackers</a>.
      </div>
    }`,
  styles: [`
    .team-head { display: flex; flex-wrap: wrap; gap: .5rem; align-items: center; margin-bottom: .5rem; }
    .team-conn { padding: .3rem .5rem; border: 1px solid var(--border-strong); border-radius: 7px; background: var(--card-inner); color: inherit; }
    .team-grow { flex: 1; }
    .team-live { color: var(--green); font-size: .8rem; }
    .team-dim { color: var(--text-dim); font-size: .8rem; }
    .team-banner { margin: .4rem 0 .8rem; padding: .6rem .8rem; border: 1px solid var(--amber); border-radius: 8px; font-size: .84rem; }
    .team-banner.info { border-color: var(--purple-light); display: flex; flex-wrap: wrap; gap: .5rem; align-items: center; }
    .team-token { display: flex; flex-wrap: wrap; gap: .4rem; margin-top: .4rem; }
    .team-token input { flex: 1 1 240px; padding: .3rem .5rem; border: 1px solid var(--border-strong); border-radius: 6px; background: var(--card-inner); color: inherit; }
    .team-help { display: block; margin-top: .35rem; color: var(--text-dim); }
    .team-msg { margin: .3rem 0; font-size: .82rem; }
    .team-msg.err { color: var(--red); }
    .team-empty { padding: 1.2rem; border: 1px dashed var(--border-strong); border-radius: 10px; color: var(--text-dim); }
  `],
})
export class ConnectionSwitcherComponent {
  readonly state = inject(TeamStateService);
  private readonly api = inject(TeamApiService);

  readonly busy = signal(false);
  readonly message = signal<string | null>(null);
  token = '';

  readonly left = computed(() => {
    const at = this.state.token()?.expiresAt;
    if (!at) return '';
    const min = Math.max(0, Math.round((Date.parse(at) - Date.now()) / 60000));
    return min >= 60 ? `${Math.floor(min / 60)} h ${min % 60} min` : `${min} min`;
  });

  save(conn: string): void {
    if (!this.token.trim()) return;
    this.busy.set(true);
    this.message.set(null);
    this.api.putToken(conn, this.token).subscribe({
      next: (t) => {
        this.token = '';
        this.busy.set(false);
        this.state.token.set(t);
        this.state.readMe();
      },
      error: (e) => {
        this.busy.set(false);
        this.message.set(e?.error?.message || 'The token was not accepted');
      },
    });
  }

  forget(conn: string): void {
    this.api.forgetToken(conn).subscribe({ next: () => this.state.readToken(), error: () => this.state.readToken() });
  }
}
