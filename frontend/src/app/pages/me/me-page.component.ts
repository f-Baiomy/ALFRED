import { Component, DestroyRef, computed, effect, inject, signal, untracked } from '@angular/core';
import { DatePipe, DecimalPipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { catchError, map, of } from 'rxjs';
import { toSignal } from '@angular/core/rxjs-interop';
import { SessionsStateService } from '../../core/state/sessions-state.service';
import { ConnectPcComponent } from '../../components/board-session/connect-pc.component';
import { SessionsApiService } from '../../core/services/sessions-api.service';
import { DbCaptureApiService } from '../../core/services/db-capture-api.service';
import { BoardSessionRow, BrowserRow, HelperRow, MySettings, ProjectPlace, UserLine } from '../../core/models/sessions.models';

type Section = 'devices' | 'projects' | 'claude' | 'azure' | 'boards' | 'sessions' | 'routing' | 'users';

/**
 * My settings (specs/031, mock steps 8, 12, 13, 16-18, 22-23): this user's own page - their PCs and browsers, where each
 * project's sessions open on each PC, Claude's models and limits, the Azure token's status (kept on their PC), the boards
 * they hold and every board session. Read and written with this browser's key only; nobody else can open it.
 */
@Component({
  selector: 'app-me-page',
  standalone: true,
  imports: [FormsModule, RouterLink, DatePipe, DecimalPipe, ConnectPcComponent],
  styles: [`
    .me { display: grid; grid-template-columns: 200px 1fr; gap: 1rem; padding: 1rem; max-width: 1200px; }
    .side { display: flex; flex-direction: column; gap: 2px; }
    .side button { text-align: left; border: 0; background: none; color: var(--text-dim); padding: .45rem .6rem; border-radius: 6px; font: inherit; cursor: pointer; }
    .side button.on, .side button:hover { background: var(--card-inner); color: var(--text); }
    .head { display: flex; align-items: center; gap: .6rem; flex-wrap: wrap; margin-bottom: .6rem; }
    .head h1 { margin: 0; font-size: 1.2rem; }
    .tag { display: inline-block; padding: .05rem .5rem; border-radius: 999px; background: var(--card-inner); font-size: .75rem; color: var(--text-dim); }
    .tag.ok { color: #3fb950; } .tag.warn { color: #d29922; } .tag.bad { color: #f85149; }
    .card { border: 1px solid var(--border); border-radius: 10px; background: var(--card); padding: .8rem 1rem; margin-bottom: 1rem; }
    .card h2 { margin: 0 0 .5rem; font-size: 1rem; }
    .muted { color: var(--text-dim); font-size: .85rem; }
    table { width: 100%; border-collapse: collapse; font-size: .85rem; }
    th, td { text-align: left; padding: .4rem .45rem; border-bottom: 1px solid var(--border); vertical-align: top; }
    th { color: var(--text-dim); font-weight: 500; font-size: .78rem; }
    input[type=text], input[type=number], select { box-sizing: border-box; padding: .35rem .45rem; border: 1px solid var(--border); border-radius: 6px;
      background: var(--card-inner); color: var(--text); font: inherit; font-size: .85rem; }
    input.wide { width: 100%; }
    .kv { display: grid; grid-template-columns: 160px 1fr; gap: .45rem .8rem; align-items: center; font-size: .88rem; }
    .kv > span:nth-child(odd) { color: var(--text-dim); }
    code { background: var(--card-inner); padding: 0 .3rem; border-radius: 4px; font-size: .8rem; word-break: break-all; }
    .scroll { overflow-x: auto; }
    .row { display: flex; gap: .4rem; flex-wrap: wrap; }
    @media (max-width: 760px) { .me { grid-template-columns: 1fr; } .side { flex-direction: row; overflow-x: auto; } .kv { grid-template-columns: 1fr; } }
  `],
  template: `
    <div class="me">
      <nav class="side" aria-label="My settings">
        @for (s of sections(); track s.key) {
          <button type="button" [class.on]="section() === s.key" (click)="section.set(s.key)">{{ s.label }}</button>
        }
      </nav>
      <main>
        <div class="head">
          <h1>👤 My settings</h1>
          @if (state.user(); as u) { <span class="muted">{{ u }}</span> <span class="tag">🔒 only you see this</span> }
          @if (dirty()) { <button type="button" class="action-btn primary" (click)="save()">Save</button> }
          @if (saved()) { <span class="tag ok">✓ saved</span> }
          @if (error()) { <span class="tag bad">{{ error() }}</span> }
        </div>

        @if (!state.paired()) {
          <div class="card">
            <h2>Connect this PC</h2>
            <p class="muted">Alfred has no logins: you are the Claude account this PC is signed in with. Until this PC is connected this
              browser can read boards but not write on a board someone holds, and has no settings.</p>
            <app-connect-pc />
          </div>
        } @else {
          @switch (section()) {
            @case ('devices') {
              <div class="card">
                <h2>Your PCs (helpers)</h2>
                <div class="scroll"><table>
                  <tr><th>PC</th><th>State</th><th>Claude</th><th>Desktop</th><th>MCP</th><th>Helper</th><th></th></tr>
                  @for (h of devices().helpers; track h.keyId) {
                    <tr>
                      <td><b>{{ h.machine }}</b>@if (h.keyId === state.me()?.helperKeyId) { <span class="tag">this browser's</span> }<br><span class="muted">{{ h.ip }}</span></td>
                      <td>@if (h.online) { <span class="tag ok">● online</span> } @else { <span class="tag">○ last seen {{ h.lastSeen | date:'short' }}</span> }</td>
                      <td>{{ info(h).claudeAccount || h.claudeAccount || '-' }}</td>
                      <td>{{ info(h).desktop ? 'found' : '-' }}</td>
                      <td>{{ info(h).mcp || '-' }}</td>
                      <td>{{ info(h).version || '-' }}</td>
                      <td><button type="button" class="action-btn" (click)="revoke(h.keyId)">Revoke</button></td>
                    </tr>
                  } @empty { <tr><td colspan="7" class="muted">No helper yet.</td></tr> }
                </table></div>
                <p class="muted">A revoked helper stops working at once; its browsers are unpaired with it.</p>
              </div>
              <div class="card">
                <h2>Your browsers</h2>
                <table>
                  <tr><th>Browser</th><th>Paired</th><th>Last seen</th><th></th></tr>
                  @for (b of devices().browsers; track b.keyId) {
                    <tr><td>{{ b.label || 'Browser' }}@if (b.thisOne) { <span class="tag">this one</span> }</td><td>{{ b.pairedAt | date:'short' }}</td>
                      <td>{{ b.lastSeen | date:'short' }}</td>
                      <td>@if (b.thisOne) { <button type="button" class="action-btn" (click)="state.unpair()">Unpair</button> }
                        @else { <button type="button" class="action-btn" (click)="revoke(b.keyId)">Revoke</button> }</td></tr>
                  }
                </table>
              </div>
            }
            @case ('projects') {
              <div class="card">
                <h2>Projects and folders <span class="muted">- per PC, because paths differ per PC</span></h2>
                <div class="scroll"><table>
                  <tr><th>Project</th><th>PC</th><th>Repo folder</th><th>Open sessions in</th><th>Board worktrees</th><th></th></tr>
                  @for (p of places(); track $index) {
                    <tr>
                      <td><select [ngModel]="p.project" (ngModelChange)="setPlace($index, { project: $event })">
                        @for (o of projects(); track o) { <option [value]="o">{{ o }}</option> }</select></td>
                      <td><select [ngModel]="p.machine" (ngModelChange)="setPlace($index, { machine: $event })">
                        @for (h of devices().helpers; track h.keyId) { <option [value]="h.machine">{{ h.machine }}</option> }</select></td>
                      <td><input type="text" class="wide" [ngModel]="p.folder" (ngModelChange)="setPlace($index, { folder: $event })" placeholder="C:\\work\\odeysys">
                        <button type="button" class="action-btn" (click)="pickFolder($index)" [disabled]="!helperOf(p.machine)?.online">Pick folder…</button></td>
                      <td><select [ngModel]="p.openIn" (ngModelChange)="setPlace($index, { openIn: $event })">
                        <option value="DESKTOP">Claude Desktop</option><option value="TERMINAL">Terminal</option><option value="BOTH">Both</option>
                        <option value="BACKGROUND">Background only</option></select></td>
                      <td><label><input type="checkbox" [ngModel]="p.worktrees" (ngModelChange)="setPlace($index, { worktrees: $event })"> one per board</label></td>
                      <td><button type="button" class="action-btn" (click)="removePlace($index)">Remove</button></td>
                    </tr>
                  }
                </table></div>
                <button type="button" class="action-btn" (click)="addPlace()">＋ Add a project folder</button>
                <p class="muted">Pick folder opens a folder picker on that PC through its helper - Alfred never browses your PC. Claude Desktop shows a new
                  session after it restarts, and asks you once to trust each folder.</p>
              </div>
            }
            @case ('claude') {
              <div class="card">
                <h2>Claude sessions</h2>
                <div class="kv">
                  <span>Model - chat, asks, listen</span><span><select [(ngModel)]="modelChat" (ngModelChange)="touch()">@for (m of models; track m) { <option [value]="m">{{ m || "Claude Code's default" }}</option> }</select></span>
                  <span>Model - setup, triage, verify, fix</span><span><select [(ngModel)]="modelSetup" (ngModelChange)="touch()">@for (m of models; track m) { <option [value]="m">{{ m || "Claude Code's default" }}</option> }</select></span>
                  <span>Daily budget (tokens)</span><span><input type="number" min="0" step="100000" [(ngModel)]="budget" (ngModelChange)="touch()"> <span class="muted">0 = none · today {{ tokensToday() | number }}</span></span>
                  <span>Max at once, per PC</span><span><input type="number" min="1" max="20" [(ngModel)]="maxSessions" (ngModelChange)="touch()"></span>
                  <span>Away rule</span><span>offline over <input type="number" min="0" max="720" style="width:5rem" [(ngModel)]="awayHours" (ngModelChange)="touch()"> h →
                    <select [(ngModel)]="awayAction" (ngModelChange)="touch()"><option value="nothing">do nothing</option><option value="accept">accept the next request</option>
                      <option value="release">release the board</option></select></span>
                  <span>Tell me (Windows toasts)</span><span class="row">
                    <label><input type="checkbox" [(ngModel)]="notifyQuestions" (ngModelChange)="touch()"> questions</label>
                    <label><input type="checkbox" [(ngModel)]="notifyDrafts" (ngModelChange)="touch()"> drafts ready</label>
                    <label><input type="checkbox" [(ngModel)]="notifyFindings" (ngModelChange)="touch()"> listen findings</label>
                    <label><input type="checkbox" [(ngModel)]="notifyRequests" (ngModelChange)="touch()"> board requests</label></span>
                </div>
                <p class="muted">Tools per job are fixed by the helper: chat, asks and listen read only; setup, triage and review also write the board; verify runs
                  tests; fix edits files, in the board's worktree only.</p>
              </div>
            }
            @case ('azure') {
              <div class="card">
                <h2>Azure DevOps</h2>
                <div class="kv">
                  <span>Your token</span><span>
                    @if (azureOnSomePc()) { <span class="tag ok">✓ kept on {{ azureOnSomePc() }}</span> } @else { <span class="tag warn">not set</span> }</span>
                  <span>Where it is kept</span><span>On your PC only, encrypted for your Windows user. Never on Alfred's disk. Alfred holds it in memory while your
                    helper is online, for <b>your</b> searches and writes only - another user never reads with it.</span>
                  <span>Set or replace</span><span>On your PC: <code>alfred helper token set</code> (paste it; it is never shown or logged) ·
                    <code>alfred helper token clear</code> removes it.</span>
                </div>
              </div>
            }
            @case ('boards') {
              <div class="card">
                <h2>Boards I hold</h2>
                <table>
                  <tr><th>Board</th><th>Project</th><th>Since</th><th>Asked by</th><th>Commenters</th><th></th></tr>
                  @for (h of mine(); track h.boardId) {
                    <tr><td><a [routerLink]="['/board']" [queryParams]="{ project: h.project, board: h.boardId.startsWith('default:') ? null : h.boardId }">{{ h.boardId }}</a></td>
                      <td>{{ h.project }}</td><td>{{ h.since | date:'short' }}</td>
                      <td>@if (h.request; as r) { {{ r.user }} <span class="muted">{{ r.note }}</span> } @else { - }</td>
                      <td><input type="text" class="wide" [ngModel]="h.commenters.join(', ')" #cm (change)="setCommenters(h.boardId, cm.value)" placeholder="ahmed@company.com"></td>
                      <td><button type="button" class="action-btn" (click)="release(h.boardId)">Release</button></td></tr>
                  } @empty { <tr><td colspan="6" class="muted">You hold no board. ▶ alfred-live on a board takes it.</td></tr> }
                </table>
                <p class="muted">Commenters may chat and comment on your board; Claude answers them only after you let it. Card edits stay yours.</p>
              </div>
            }
            @case ('sessions') {
              <div class="card">
                <div class="head"><h2 style="margin:0">Sessions</h2><span class="tag">today {{ tokensToday() | number }} tokens</span>
                  <span style="flex:1"></span>
                  @if (state.targetHelper(); as t) { <button type="button" class="action-btn danger" (click)="stopAll()">■ Stop all on {{ t.machine }}</button> }</div>
                <div class="scroll"><table>
                  <tr><th>Board</th><th>Session</th><th>Where</th><th>State</th><th>Today</th><th></th></tr>
                  @for (s of state.sessions(); track s.id) {
                    <tr><td>{{ s.title || s.boardId }}@if (s.current) { <span class="tag">current</span> }<br><span class="muted">{{ s.project }}</span></td>
                      <td><code>{{ s.cliSessionId.slice(0, 8) }}</code></td>
                      <td>{{ s.machine }}<br><span class="muted">{{ s.user }}</span></td>
                      <td><span class="tag" [class.ok]="s.state === 'ANSWERING'" [class.warn]="s.state.startsWith('WAITING')">{{ s.state.toLowerCase().replace('_', ' ') }}</span>
                        @if (s.openIn !== 'NONE') { <span class="tag">in {{ s.openIn.toLowerCase() }}</span> }</td>
                      <td>{{ (s.tokensToday / 1000) | number:'1.0-0' }}k</td>
                      <td>@if (s.user === state.user()) {
                        <span class="row"><button type="button" class="action-btn" (click)="send('OPEN_DESKTOP', s)">Desktop</button>
                          <button type="button" class="action-btn" (click)="send('OPEN_TERMINAL', s)">Terminal</button>
                          @if (s.state === 'ANSWERING') { <button type="button" class="action-btn" (click)="send('STOP', s)">Stop</button> }
                          @else { <button type="button" class="action-btn" (click)="send('RESUME', s)">Resume</button> }</span>
                      } @else { <span class="tag">view only</span> }</td></tr>
                  } @empty { <tr><td colspan="6" class="muted">No board session yet.</td></tr> }
                </table></div>
              </div>
            }
            @case ('routing') {
              <div class="card">
                <h2>Who answers what</h2>
                <table>
                  <tr><th>Job</th><th>Goes to</th></tr>
                  <tr><td>Board chat message, card comment, ✦ ask on a board</td><td>the board's session</td></tr>
                  <tr><td>Project chat, an ask off any board, Team Incoming</td><td>the project session (its default board)</td></tr>
                  <tr><td>Define · Start from Azure (/alfred-setup)</td><td>the board's session - made if there is none</td></tr>
                  <tr><td>▶ verify · fix · sync · triage · review · spec · report · resume</td><td>the board's session, one at a time, ⚡ first</td></tr>
                  <tr><td>Listen to a cycle (/alfred-listen)</td><td>a background lane on the board session's PC - forks only</td></tr>
                  <tr><td>Requirement verdicts, re-test checks</td><td>no Claude - Alfred's own code</td></tr>
                </table>
              </div>
            }
            @case ('users') {
              <div class="card">
                <h2>Users (admin)</h2>
                <table>
                  <tr><th>User</th><th>PCs</th><th>Browsers</th><th>Last seen</th><th></th></tr>
                  @for (u of users(); track u.user) {
                    <tr><td>{{ u.user }}</td><td>{{ u.machines.join(', ') }}</td><td>{{ u.browsers }}</td><td>{{ u.lastSeen | date:'short' }}</td>
                      <td><button type="button" class="action-btn danger" (click)="adminRevokeUser(u)">Revoke helpers</button></td></tr>
                  }
                </table>
                <p class="muted">You see users and PCs - never their settings or tokens. Revoking a user's helpers frees the boards they hold.</p>
              </div>
            }
          }
        }
      </main>
    </div>
  `,
})
export class MePageComponent {
  readonly state = inject(SessionsStateService);
  private readonly api = inject(SessionsApiService);
  private readonly db = inject(DbCaptureApiService);

  readonly section = signal<Section>('devices');
  readonly devices = signal<{ helpers: readonly HelperRow[]; browsers: readonly BrowserRow[] }>({ helpers: [], browsers: [] });
  readonly users = signal<readonly UserLine[]>([]);
  readonly places = signal<ProjectPlace[]>([]);
  readonly dirty = signal(false);
  readonly saved = signal(false);
  readonly error = signal<string | null>(null);
  readonly models = ['', 'sonnet', 'opus', 'haiku'];
  modelChat = '';
  modelSetup = '';
  budget = 0;
  maxSessions = 4;
  awayHours = 0;
  awayAction: 'accept' | 'release' | 'nothing' = 'nothing';
  notifyQuestions = true;
  notifyDrafts = true;
  notifyFindings = true;
  notifyRequests = true;
  private pickingRow: number | null = null;

  readonly projects = toSignal(this.db.projects().pipe(map((ps) => ps.map((p) => p.project)), catchError(() => of([] as string[]))),
    { initialValue: [] as string[] });
  readonly sections = computed(() => [
    { key: 'devices' as const, label: 'Profile and devices' },
    { key: 'projects' as const, label: 'Projects and folders' },
    { key: 'claude' as const, label: 'Claude sessions' },
    { key: 'azure' as const, label: 'Azure DevOps' },
    { key: 'boards' as const, label: 'Boards I hold' },
    { key: 'sessions' as const, label: 'Sessions' },
    { key: 'routing' as const, label: 'Who answers what' },
    ...(this.state.me()?.admin ? [{ key: 'users' as const, label: 'Users (admin)' }] : []),
  ]);
  readonly mine = computed(() => this.state.holders().filter((h) => h.user === this.state.user()));
  readonly tokensToday = computed(() => this.state.sessions().filter((s) => s.user === this.state.user()).reduce((n, s) => n + s.tokensToday, 0));
  readonly azureOnSomePc = computed(() => this.devices().helpers.filter((h) => this.info(h).azureToken).map((h) => h.machine).join(', '));

  constructor() {
    this.state.start();
    effect(() => {
      if (!this.state.paired()) return;
      untracked(() => this.loadDevices());
    });
    effect(() => {
      const s = this.state.settings();
      untracked(() => { if (!this.dirty()) this.fill(s); });
    });
    effect(() => {
      if (this.section() !== 'users' || !this.state.me()?.admin) return;
      untracked(() => this.api.users().subscribe({ next: (u) => this.users.set(u), error: () => this.users.set([]) }));
    });
    const sub = this.state.finished$.subscribe((c) => {
      if (c.kind === 'PICK_FOLDER' && c.state === 'DONE' && c.result && this.pickingRow !== null) {
        this.setPlace(this.pickingRow, { folder: c.result });
        this.pickingRow = null;
      }
    });
    const keys = this.state.events$.subscribe((e) => { if (e.what === 'keys') this.loadDevices(); });
    inject(DestroyRef).onDestroy(() => { sub.unsubscribe(); keys.unsubscribe(); });
  }

  info(h: HelperRow) {
    return this.state.helperInfo(h);
  }

  helperOf(machine: string): HelperRow | undefined {
    return this.devices().helpers.find((h) => h.machine === machine);
  }

  private loadDevices(): void {
    this.api.devices().subscribe({ next: (d) => this.devices.set(d), error: () => undefined });
  }

  private fill(s: MySettings): void {
    this.places.set([...(s.projects ?? [])]);
    this.modelChat = s.models?.chat ?? '';
    this.modelSetup = s.models?.setup ?? '';
    this.budget = s.budget?.dailyTokens ?? 0;
    this.maxSessions = s.maxSessions ?? 4;
    this.awayHours = s.away?.hours ?? 0;
    this.awayAction = s.away?.action ?? 'nothing';
    this.notifyQuestions = s.notify?.questions ?? true;
    this.notifyDrafts = s.notify?.drafts ?? true;
    this.notifyFindings = s.notify?.findings ?? true;
    this.notifyRequests = s.notify?.requests ?? true;
  }

  touch(): void {
    this.dirty.set(true);
    this.saved.set(false);
  }

  revoke(keyId: string): void {
    this.api.revoke(keyId).subscribe({ next: () => this.loadDevices(), error: () => this.error.set('Could not revoke') });
  }

  addPlace(): void {
    const machine = this.state.targetHelper()?.machine ?? this.devices().helpers[0]?.machine ?? '';
    this.places.set([...this.places(), { project: this.projects()[0] ?? '', machine, folder: '', openIn: 'DESKTOP', worktrees: true }]);
    this.touch();
  }

  setPlace(i: number, patch: Partial<ProjectPlace>): void {
    this.places.set(this.places().map((p, j) => (j === i ? { ...p, ...patch } : p)));
    this.touch();
  }

  removePlace(i: number): void {
    this.places.set(this.places().filter((_, j) => j !== i));
    this.touch();
  }

  pickFolder(i: number): void {
    const h = this.helperOf(this.places()[i].machine);
    if (!h) return;
    this.pickingRow = i;
    this.state.send('PICK_FOLDER', { helperKeyId: h.keyId }).subscribe();
  }

  save(): void {
    this.error.set(null);
    const s: MySettings = {
      ...this.state.settings(),
      projects: this.places().filter((p) => p.project && p.folder.trim()).map((p) => ({ ...p, folder: p.folder.trim() })),
      models: { chat: this.modelChat || undefined, setup: this.modelSetup || undefined, fix: this.modelSetup || undefined },
      budget: { dailyTokens: Math.max(0, Math.round(this.budget || 0)) },
      maxSessions: Math.max(1, Math.min(20, Math.round(this.maxSessions || 4))),
      away: { hours: Math.max(0, this.awayHours || 0), action: this.awayAction },
      notify: { questions: this.notifyQuestions, drafts: this.notifyDrafts, findings: this.notifyFindings, requests: this.notifyRequests },
    };
    this.state.saveSettings(s).subscribe((v) => {
      if (!v) { this.error.set('Not saved'); return; }
      this.dirty.set(false);
      this.saved.set(true);
      this.fill(v);
    });
  }

  release(boardId: string): void {
    this.api.release(boardId).subscribe({ error: () => this.error.set('Could not release') });
  }

  setCommenters(boardId: string, text: string): void {
    const list = text.split(/[,;\s]+/).map((x) => x.trim()).filter(Boolean);
    this.api.commenters(boardId, list).subscribe({ error: () => this.error.set('Could not save commenters') });
  }

  send(kind: 'OPEN_DESKTOP' | 'OPEN_TERMINAL' | 'STOP' | 'RESUME', s: BoardSessionRow): void {
    this.state.send(kind, { boardId: s.boardId, project: s.project, sessionId: s.id, helperKeyId: s.helperKeyId, args: { cliSessionId: s.cliSessionId } }).subscribe();
  }

  stopAll(): void {
    this.state.send('STOP_ALL', {}).subscribe();
  }

  adminRevokeUser(u: UserLine): void {
    this.api.userHelpers(u.user).subscribe({
      next: (hs) => hs.forEach((h) => this.api.adminRevoke(h.keyId).subscribe({ next: () => this.api.users().subscribe((x) => this.users.set(x)) })),
      error: () => this.error.set('Refused'),
    });
  }
}
