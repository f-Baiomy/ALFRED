import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ConfirmDialogService } from '../../../core/services/confirm-dialog.service';
import { TeamApiService } from '../../../core/team/team-api.service';
import { TeamStateService } from '../../../core/team/team-state.service';
import { TeamConnection } from '../../../core/team/team.models';

interface Draft {
  id: string | null;
  kind: string;
  name: string;
  baseUrl: string;
  projects: string;
  teams: string;
}

/**
 * Settings -> Team trackers (specs/027 US7): add, scope and remove the connections everyone shares, and keep this
 * browser's token for each. The token is never sent here - only to refresh and history, in a header Alfred never stores.
 */
@Component({
  selector: 'app-connection-settings',
  standalone: true,
  imports: [FormsModule],
  template: `
    <section class="panel settings-panel">
      <h3>Team trackers</h3>
      <p class="sub">The team's tracker (Azure DevOps; Jira and ClickUp later), read into a cache every Alfred user shares on the Team tab.
        Each person keeps their own personal access token in their browser - Alfred never stores or logs it.</p>
      @if (message()) { <div class="tc-msg" [class.err]="isError()">{{ message() }}</div> }
      <table class="tc-table">
        <thead><tr><th>Name</th><th>Tracker</th><th>Scope</th><th>Token in this browser</th><th></th></tr></thead>
        <tbody>
          @for (c of state.connections(); track c.id) {
            <tr>
              <td><b>{{ c.name }}</b><div class="tc-dim">{{ c.baseUrl }}</div></td>
              <td>{{ state.uiOf(c.kind).icon }} {{ state.uiOf(c.kind).label }}</td>
              <td class="tc-dim">{{ c.scope.projects.join(', ') || 'every project' }}@if (c.scope.teams.length) { · {{ c.scope.teams.join(', ') }} }</td>
              <td>
                @if (hasToken(c)) {
                  <span class="tc-ok">✓ saved</span> <button type="button" class="action-btn" (click)="forget(c)">Forget</button>
                } @else {
                  <form class="tc-token" (submit)="$event.preventDefault(); saveToken(c)">
                    <input type="password" autocomplete="off" [(ngModel)]="tokenDraft[c.id]" [name]="'t-' + c.id" placeholder="Personal access token"
                           aria-label="Personal access token" />
                    <button type="submit" class="action-btn" [disabled]="!tokenDraft[c.id]?.trim()">Save</button>
                  </form>
                }
              </td>
              <td class="tc-actions">
                <button type="button" class="action-btn" (click)="edit(c)">Edit</button>
                <button type="button" class="action-btn danger" (click)="remove(c)">Remove</button>
              </td>
            </tr>
          } @empty { <tr><td colspan="5" class="tc-dim">No tracker connected.</td></tr> }
        </tbody>
      </table>

      @if (draft(); as d) {
        <form class="tc-form" (submit)="$event.preventDefault(); save()">
          <label>Tracker
            <select [ngModel]="d.kind" (ngModelChange)="patch({ kind: $event })" name="kind" [disabled]="!!d.id">
              @for (k of state.connectors(); track k.kind) {
                <option [value]="k.kind" [disabled]="!k.installed">{{ k.displayName }}{{ k.installed ? '' : ' - not installed' }}</option>
              }
            </select>
          </label>
          <label>Name <input [ngModel]="d.name" (ngModelChange)="patch({ name: $event })" name="name" maxlength="80" required /></label>
          <label>Base URL <input [ngModel]="d.baseUrl" (ngModelChange)="patch({ baseUrl: $event })" name="baseUrl" [disabled]="!!d.id"
                                 [placeholder]="state.uiOf(d.kind).urlHint" /></label>
          <label>Projects <input [ngModel]="d.projects" (ngModelChange)="patch({ projects: $event })" name="projects" placeholder="Comma separated; empty = every project" /></label>
          <label>{{ state.uiOf(d.kind).word('squad') }}s <input [ngModel]="d.teams" (ngModelChange)="patch({ teams: $event })" name="teams"
                                 placeholder="Comma separated; empty = every one" /></label>
          @if (state.uiOf(d.kind).help) { <small class="tc-dim">{{ state.uiOf(d.kind).help }}</small> }
          <div class="tc-form-actions">
            <button type="submit" class="action-btn primary" [disabled]="!valid()">{{ d.id ? 'Save' : 'Add' }}</button>
            <button type="button" class="action-btn" (click)="draft.set(null)">Cancel</button>
          </div>
        </form>
      } @else {
        <button type="button" class="action-btn primary" (click)="add()">+ Add a tracker</button>
      }
    </section>`,
  styles: [`
    .tc-table { width: 100%; border-collapse: collapse; font-size: .84rem; margin: .5rem 0; }
    .tc-table th, .tc-table td { padding: .35rem .5rem; border-bottom: 1px solid var(--border); text-align: left; vertical-align: top; }
    .tc-dim { color: var(--text-dim); font-size: .78rem; }
    .tc-ok { color: var(--green); }
    .tc-token { display: flex; gap: .3rem; }
    .tc-token input, .tc-form input, .tc-form select { padding: .25rem .5rem; border: 1px solid var(--border-strong); border-radius: 6px;
      background: var(--card-inner); color: inherit; }
    .tc-actions { white-space: nowrap; }
    .tc-form { display: grid; gap: .45rem; max-width: 560px; margin-top: .6rem; }
    .tc-form label { display: grid; gap: .2rem; font-size: .82rem; }
    .tc-form-actions { display: flex; gap: .4rem; }
    .tc-msg { font-size: .82rem; color: var(--green); }
    .tc-msg.err { color: var(--red); }
  `],
})
export class ConnectionSettingsComponent {
  readonly state = inject(TeamStateService);
  private readonly api = inject(TeamApiService);
  private readonly confirm = inject(ConfirmDialogService);

  readonly draft = signal<Draft | null>(null);
  readonly message = signal<string | null>(null);
  readonly isError = signal(false);
  tokenDraft: Record<string, string | undefined> = {};

  readonly valid = computed(() => {
    const d = this.draft();
    return !!d && !!d.name.trim() && (!!d.id || /^https?:\/\/\S+$/.test(d.baseUrl.trim()));
  });

  constructor() {
    this.state.load();
  }

  hasToken(c: TeamConnection): boolean {
    this.state.tokens.version();
    return this.state.tokens.has(c.id);
  }

  add(): void {
    const kind = this.state.connectors().find((k) => k.installed)?.kind ?? 'azure';
    this.draft.set({ id: null, kind, name: '', baseUrl: '', projects: '', teams: '' });
  }

  edit(c: TeamConnection): void {
    this.draft.set({ id: c.id, kind: c.kind, name: c.name, baseUrl: c.baseUrl, projects: c.scope.projects.join(', '), teams: c.scope.teams.join(', ') });
  }

  patch(p: Partial<Draft>): void {
    this.draft.update((d) => (d ? { ...d, ...p } : d));
  }

  save(): void {
    const d = this.draft();
    if (!d || !this.valid()) return;
    const list = (s: string) => s.split(',').map((x) => x.trim()).filter(Boolean);
    const scope = { projects: list(d.projects), teams: list(d.teams) };
    const done = {
      next: () => {
        this.draft.set(null);
        this.say('Saved', false);
        this.state.load();
      },
      error: (e: { error?: { message?: string } }) => this.say(e?.error?.message || 'Could not save - Settings may be read-only from here', true),
    };
    if (d.id) this.api.updateConnection(d.id, { name: d.name.trim(), scope }).subscribe(done);
    else this.api.createConnection({ kind: d.kind, name: d.name.trim(), baseUrl: d.baseUrl.trim(), scope }).subscribe(done);
  }

  async remove(c: TeamConnection): Promise<void> {
    const ok = await this.confirm.confirm(
      `Remove ${c.name}? Its cached items, changes and mappings are deleted for everyone. Alfred boards opened from its items stay.`, 'Remove');
    if (!ok) return;
    this.api.deleteConnection(c.id).subscribe({
      next: () => {
        this.state.tokens.clear(c.id);
        this.state.load();
      },
      error: (e) => this.say(e?.error?.message || 'Could not remove it', true),
    });
  }

  saveToken(c: TeamConnection): void {
    const t = this.tokenDraft[c.id]?.trim();
    if (!t) return;
    this.state.tokens.set(c.id, t);
    this.tokenDraft[c.id] = '';
    this.say('Token saved in this browser', false);
  }

  forget(c: TeamConnection): void {
    this.state.tokens.clear(c.id);
  }

  private say(m: string, err: boolean): void {
    this.message.set(m);
    this.isError.set(err);
  }
}
