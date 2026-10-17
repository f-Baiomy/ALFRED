import { Component, DestroyRef, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { TeamApiService } from '../../../core/team/team-api.service';
import { TeamStateService } from '../../../core/team/team-state.service';

/**
 * The Team tab's head (specs/027 mock §Team): which connection, when it was last fetched and by whom, Refresh (with this
 * browser's token), and the banners for a missing or refused token. A refresh fills the shared cache for everyone.
 */
@Component({
  selector: 'app-connection-switcher',
  standalone: true,
  imports: [FormsModule, RouterLink],
  template: `
    <div class="team-head">
      @if (state.connections().length > 1) {
        <select class="team-conn" [ngModel]="state.picked()?.id" (ngModelChange)="state.pick($event)" aria-label="Connection">
          @for (c of state.connections(); track c.id) { <option [value]="c.id">{{ state.uiOf(c.kind).icon }} {{ c.name }}</option> }
        </select>
      } @else if (state.picked()) {
        <b class="team-conn-one">{{ state.ui().icon }} {{ state.picked()?.name }}</b>
      }
      @if (state.picked(); as c) {
        <span class="team-fetched">{{ c.fetchedAt ? 'fetched ' + ago(c.fetchedAt) + (c.fetchedBy ? ' by ' + c.fetchedBy : '') : 'never fetched' }}</span>
        <span class="team-grow"></span>
        @if (state.hasToken()) {
          <button type="button" class="action-btn primary" [disabled]="busy()" (click)="refresh()">{{ busy() ? 'Refreshing…' : '↻ Refresh' }}</button>
          <button type="button" class="action-btn" title="Forget the token in this browser" (click)="state.tokens.clear(c.id)">Forget token</button>
        }
      }
    </div>
    @if (state.picked(); as c) {
      @if (!state.hasToken() || rejected()) {
        <div class="team-banner" role="alert">
          <b>{{ rejected() ? 'Your token was refused - it may have expired.' : 'Add your personal access token to refresh.' }}</b>
          Everyone sees what anyone fetched; the token stays in this browser and Alfred never stores it.
          <form class="team-token" (submit)="$event.preventDefault(); saveToken()">
            <input type="password" [(ngModel)]="token" name="token" autocomplete="off" placeholder="Personal access token" aria-label="Personal access token" />
            <input [(ngModel)]="who" name="who" maxlength="80" placeholder="Your name (shown as fetched by)" aria-label="Your name" />
            <button type="submit" class="action-btn primary" [disabled]="!token.trim()">Save and refresh</button>
          </form>
          @if (state.ui().help) { <small class="team-help">{{ state.ui().help }}</small> }
        </div>
      }
      @if (message()) { <div class="team-msg" [class.err]="isError()">{{ message() }}</div> }
    } @else if (state.loaded()) {
      <div class="team-empty">
        <b>No team tracker connected yet.</b> Add Azure DevOps (Jira and ClickUp later) in
        <a routerLink="/settings" [queryParams]="{ section: 'team-trackers' }">Settings → Team trackers</a>.
      </div>
    }`,
  styles: [`
    .team-head { display: flex; flex-wrap: wrap; gap: .6rem; align-items: center; margin-bottom: .5rem; }
    .team-conn { padding: .3rem .5rem; border: 1px solid var(--border-strong); border-radius: 7px; background: var(--card-inner); color: inherit; }
    .team-fetched { color: var(--text-dim); font-size: .82rem; }
    .team-grow { flex: 1; }
    .team-banner { margin: .4rem 0 .8rem; padding: .6rem .8rem; border: 1px solid var(--amber); border-radius: 8px; font-size: .84rem; }
    .team-token { display: flex; flex-wrap: wrap; gap: .4rem; margin-top: .4rem; }
    .team-token input { flex: 1 1 200px; padding: .3rem .5rem; border: 1px solid var(--border-strong); border-radius: 6px; background: var(--card-inner); color: inherit; }
    .team-help { display: block; margin-top: .35rem; color: var(--text-dim); }
    .team-msg { margin: .3rem 0; font-size: .82rem; color: var(--green); }
    .team-msg.err { color: var(--red); }
    .team-empty { padding: 1.2rem; border: 1px dashed var(--border-strong); border-radius: 10px; color: var(--text-dim); }
  `],
})
export class ConnectionSwitcherComponent {
  readonly state = inject(TeamStateService);
  private readonly api = inject(TeamApiService);

  readonly busy = signal(false);
  readonly message = signal<string | null>(null);
  readonly isError = signal(false);
  readonly rejected = signal(false);
  token = '';
  who = this.state.tokens.who();

  readonly picked = computed(() => this.state.picked());
  /** The connection this browser is refreshing in the background, until its outcome arrives. */
  private running: string | null = null;

  constructor() {
    const sub = this.api.events$.subscribe((e) => {
      if (e.what !== 'refresh' || !e.conn || e.conn !== this.running) return;
      this.running = null;
      this.done(e.conn, e.outcome ?? 'OK', e.changed ?? 0, e.message ?? null, e.retryAfter ?? null);
    });
    // the socket dropped: the outcome may have gone by - stop waiting; the lists still refill on their own signals
    const again = this.api.reconnected$.subscribe(() => {
      if (!this.running) return;
      this.running = null;
      this.busy.set(false);
      this.message.set('The connection to Alfred was interrupted - the refresh may still be running');
    });
    inject(DestroyRef).onDestroy(() => {
      sub.unsubscribe();
      again.unsubscribe();
    });
  }

  private done(conn: string, outcome: string, changed: number, message: string | null, retryAfter: number | null): void {
    this.busy.set(false);
    if (outcome === 'OK') {
      this.isError.set(false);
      this.message.set(changed ? `${changed} item${changed === 1 ? '' : 's'} changed` : 'Up to date');
      return;
    }
    this.isError.set(true);
    if (outcome === 'TOKEN_REJECTED') {
      this.rejected.set(true);
      this.state.tokens.clear(conn); // a refused token is not kept: the banner asks for a new one
    }
    this.message.set(outcome === 'PROVIDER_BUSY' ? `${this.state.ui().label} asks to wait ${retryAfter ?? 30} s - try again then`
      : message || 'Refresh failed');
  }

  ago(iso: string): string {
    const s = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
    if (s < 60) return 'just now';
    if (s < 3600) return `${Math.round(s / 60)} min ago`;
    if (s < 86400) return `${Math.round(s / 3600)} h ago`;
    return `${Math.round(s / 86400)} d ago`;
  }

  saveToken(): void {
    const c = this.picked();
    if (!c || !this.token.trim()) return;
    this.state.tokens.set(c.id, this.token);
    if (this.who.trim()) this.state.tokens.setWho(this.who);
    this.token = '';
    this.rejected.set(false);
    this.refresh();
  }

  refresh(): void {
    const c = this.picked();
    if (!c) return;
    this.busy.set(true);
    this.message.set(null);
    this.api.refresh(c.id, true).subscribe({
      next: (r) => {
        if (r.state === 'STARTED') {
          this.running = c.id; // the outcome comes on /ws/teamboards; the lists refill as pages land
          this.message.set(r.message ?? 'Refreshing…');
          this.isError.set(false);
          return;
        }
        this.done(c.id, 'OK', r.changed ?? 0, null, null);
      },
      error: (e) => {
        this.busy.set(false);
        this.isError.set(true);
        const code = e?.error?.error;
        if (code === 'TOKEN_REJECTED') {
          this.rejected.set(true);
          this.state.tokens.clear(c.id); // a refused token is not kept: the banner asks for a new one
        }
        this.message.set(code === 'PROVIDER_BUSY' ? `${this.state.ui().label} asks to wait ${e.error.retryAfter ?? 30} s - try again then`
          : e?.error?.message || 'Refresh failed');
      },
    });
  }
}
