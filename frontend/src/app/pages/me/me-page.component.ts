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
    .me { display: grid; grid-template-columns: 200px minmax(0, 1fr); gap: 1rem; padding: 1rem; max-width: 1200px; box-sizing: border-box; }
    .side { display: flex; flex-direction: column; gap: 2px; }
    .side button { text-align: left; border: 0; border-left: 3px solid transparent; background: none; color: var(--text-dim); padding: .45rem .6rem;
      border-radius: 0 6px 6px 0; font: inherit; cursor: pointer; white-space: nowrap; }
    .side button:hover { color: var(--text); }
    .side button.on { background: var(--card-inner); color: var(--text); border-left-color: var(--accent-blue, #5b8def); font-weight: 600; }
    .head { display: flex; align-items: center; gap: .6rem; flex-wrap: wrap; margin-bottom: .6rem; }
    .head h1 { margin: 0; font-size: 1.2rem; }
    .tag { display: inline-block; padding: .05rem .5rem; border-radius: 999px; background: var(--card-inner); font-size: .75rem; color: var(--text-dim); }
    .tag.ok { color: #3fb950; } .tag.warn { color: #d29922; } .tag.bad { color: #f85149; }
    .card { border: 1px solid var(--border); border-radius: 10px; background: var(--card); padding: .8rem 1rem; margin-bottom: 1rem; }
    .card h2 { margin: 0 0 .5rem; font-size: 1rem; }
    .muted { color: var(--text-dim); font-size: .85rem; }
    table { width: 100%; border-collapse: collapse; font-size: .85rem; }
    th, td { text-align: left; padding: .45rem .5rem; border-bottom: 1px solid var(--border); vertical-align: middle; }
    td .action-btn { white-space: nowrap; }
    .places select { min-width: 9rem; }
    .places td.folder { min-width: 18rem; }
    .folder-row { display: flex; gap: .4rem; align-items: center; }
    .folder-row input { flex: 1; min-width: 0; }
    .check { display: inline-flex; align-items: center; gap: .35rem; white-space: nowrap; cursor: pointer; }
    .add { margin-top: .6rem; }
    .dirty { color: #d29922; font-size: .8rem; }
    .nowrap { white-space: nowrap; }
    main { min-width: 0; }
    th { color: var(--text-dim); font-weight: 500; font-size: .78rem; }
    input[type=text], input[type=number], select { box-sizing: border-box; padding: .35rem .45rem; border: 1px solid var(--border); border-radius: 6px;
      background: var(--card-inner); color: var(--text); font: inherit; font-size: .85rem; }
    input.wide { width: 100%; }
    .kv { display: grid; grid-template-columns: 160px 1fr; gap: .45rem .8rem; align-items: center; font-size: .88rem; }
    .kv > span:nth-child(odd) { color: var(--text-dim); }
    code { background: var(--card-inner); padding: 0 .3rem; border-radius: 4px; font-size: .8rem; word-break: break-all; }
    .scroll { overflow-x: auto; }
    .row { display: flex; gap: .4rem; flex-wrap: wrap; }
    @media (max-width: 760px) {
      .me { grid-template-columns: 1fr; padding: .75rem 16px; }
      .side { flex-direction: row; overflow-x: auto; }
      .side button { border-left: 0; border-bottom: 3px solid transparent; border-radius: 6px 6px 0 0; }
      .side button.on { border-bottom-color: var(--accent-blue, #5b8def); }
      .kv { grid-template-columns: 1fr; }
    }
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
          @if (dirty()) { <span class="dirty">unsaved changes</span> <button type="button" class="action-btn primary" (click)="save()">Save</button> }
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
                      <td class="nowrap"><b>{{ h.machine }}</b>@if (osUserOf(h); as u) { <br><span class="muted">Windows user {{ u }}</span> }
                        @if (h.keyId === state.me()?.helperKeyId) { <br><span class="tag">this browser's PC</span> }</td>
                      <td class="nowrap">@if (h.online) { <span class="tag ok">● online</span> } @else { <span class="tag">○ last seen {{ h.lastSeen | date:'short' }}</span> }</td>
                      <td>@for (a of claudeAccounts(h); track a.where) {
                          <div>{{ a.account }} <span class="muted">· {{ a.where }}</span></div>
                        } @empty { - }
                        @if (otherClaude(h)) { <span class="muted">another Claude account - still you</span> }</td>
                      <td>{{ info(h).desktop ? '✓ found' : 'not found' }}</td>
                      <td>{{ info(h).mcp || '-' }}</td>
                      <td>{{ info(h).version || '-' }}</td>
                      <td><button type="button" class="action-btn" (click)="revoke(h.keyId)">Revoke</button></td>
                    </tr>
                  } @empty { <tr><td colspan="7" class="muted">No helper yet.</td></tr> }
                </table></div>
                <p class="muted">A revoked helper stops working at once; its browsers are unpaired with it. Each Windows user on a PC runs its own
                  helper - connecting one never replaces another's.</p>
              </div>
              <div class="card">
                <h2>Connect another PC, or repair this one</h2>
                <p class="muted">Run the connect file on the PC it is for. Running it again on a connected PC repairs it and keeps its browsers and sessions.</p>
                <app-connect-pc />
              </div>
              <div class="card">
                <h2>Your browsers</h2>
                <div class="scroll"><table>
                  <tr><th>Browser</th><th>Paired</th><th>Last seen</th><th></th></tr>
                  @for (b of devices().browsers; track b.keyId) {
                    <tr><td>{{ b.label || 'Browser' }}@if (b.thisOne) { <span class="tag">this one</span> }</td><td>{{ b.pairedAt | date:'short' }}</td>
                      <td>{{ b.lastSeen | date:'short' }}</td>
                      <td>@if (b.thisOne) { <button type="button" class="action-btn" (click)="state.unpair()">Unpair</button> }
                        @else { <button type="button" class="action-btn" (click)="revoke(b.keyId)">Revoke</button> }</td></tr>
                  }
                </table></div>
              </div>
            }
            @case ('projects') {
              <div class="card">
                <h2>Projects and folders <span class="muted">- per PC, because paths differ per PC</span></h2>
                <div class="scroll"><table class="places">
                  <tr><th>Project</th><th>PC</th><th>Repo folder</th><th>Open sessions in</th><th>Board worktrees</th><th></th></tr>
                  @for (p of places(); track $index) {
                    <tr>
                      <td><select [ngModel]="p.project" (ngModelChange)="setPlace($index, { project: $event })" aria-label="Project">
                        @for (o of projectChoices(p.project); track o) { <option [value]="o">{{ o }}</option> }</select></td>
                      <td><select [ngModel]="placeKey(p)" (ngModelChange)="setPc($index, $event)" aria-label="PC">
                        @for (m of pcChoices(p); track m.key) { <option [value]="m.key">{{ m.label }}</option> }</select></td>
                      <td class="folder"><div class="folder-row">
                        <input type="text" [ngModel]="p.folder" (ngModelChange)="setPlace($index, { folder: $event })" placeholder="C:\\work\\odeysys" aria-label="Repo folder">
                        <button type="button" class="action-btn" (click)="pickFolder($index)" [disabled]="!pickerFor(p)"
                          [title]="pickerTitle(p)">Pick…</button></div></td>
                      <td><select [ngModel]="p.openIn" (ngModelChange)="setPlace($index, { openIn: $event })" aria-label="Open sessions in">
                        <option value="DESKTOP">Claude Desktop</option><option value="TERMINAL">Terminal</option><option value="BOTH">Both</option>
                        <option value="BACKGROUND">Background only</option></select></td>
                      <td><label class="check"><input type="checkbox" [ngModel]="p.worktrees" (ngModelChange)="setPlace($index, { worktrees: $event })"> one per board</label></td>
                      <td><button type="button" class="action-btn" (click)="removePlace($index)">Remove</button></td>
                    </tr>
                  } @empty {
                    <tr><td colspan="6" class="muted">None yet - the first ▶ Start Claude of a project asks for its folder on your PC and keeps it here.</td></tr>
                  }
                </table></div>
                <button type="button" class="action-btn add" (click)="addPlace()">＋ Add a project folder</button>
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
                  <span>Your token</span><span class="row">
                    @if (tokenSet()) { <span class="tag ok">✓ in use now - for your searches only</span> }
                    @for (h of devices().helpers; track h.keyId) {
                      @if (info(h).azureToken) { <span class="tag ok">🔐 kept on {{ pcLabel(h) }}</span> }
                    }
                    @if (!tokenSet() && !azureOnSomePc()) { <span class="tag warn">not set</span> }</span>
                  <span>Set or replace</span><span class="folder-row">
                    <input type="password" [(ngModel)]="azureToken" placeholder="Paste your Azure DevOps personal access token" autocomplete="off" aria-label="Azure DevOps token">
                    <button type="button" class="action-btn primary" [disabled]="!azureToken.trim()" (click)="setToken()">Save token</button></span>
                  <span>Keep it on</span><span>
                    <select [(ngModel)]="tokenPc" aria-label="Keep the token on">
                      @for (h of devices().helpers; track h.keyId) {
                        <option [value]="h.keyId" [disabled]="!h.online">{{ pcLabel(h) }}{{ h.online ? '' : ' (offline)' }}</option>
                      }
                      <option value="">no PC - only until Alfred restarts</option>
                    </select></span>
                  <span>Forget it</span><span class="row">
                    @for (h of devices().helpers; track h.keyId) {
                      @if (info(h).azureToken) { <button type="button" class="action-btn" (click)="clearToken(h.keyId)" [disabled]="!h.online">Remove from {{ pcLabel(h) }}</button> }
                    }
                    <button type="button" class="action-btn" (click)="clearToken(null)">Stop using it now</button></span>
                  <span>Where it is kept</span><span class="muted">On the PC you choose, encrypted for your Windows user; that PC's helper hands it to Alfred
                    whenever it starts. Alfred holds it in memory only, for <b>your</b> searches and writes - another user never reads with it - and
                    never puts it on its disk, in a log or in an answer to a browser.</span>
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
                      <td><button type="button" class="action-btn" (click)="release(h.boardId)">Hand back</button></td></tr>
                  } @empty { <tr><td colspan="6" class="muted">You hold no board. ▶ Start Claude on a board takes it.</td></tr> }
                </table>
                <p class="muted">Commenters may chat and comment on your board; Claude answers them only after you let it. Card edits stay yours.</p>
              </div>
            }
            @case ('sessions') {
              <div class="card">
                <div class="head"><h2 style="margin:0">Sessions</h2><span class="tag">today {{ tokensToday() | number }} tokens</span>
                  <span style="flex:1"></span>
                  @if (state.targetHelper(); as t) { <button type="button" class="action-btn danger" (click)="stopAll()">■ Stop all on {{ pcLabel(t) }}</button> }</div>
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
  azureToken = '';
  /** The PC the token is kept on: this browser's own, else the first online one. */
  tokenPc = '';
  readonly tokenSet = signal(false);
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
  readonly azureOnSomePc = computed(() => this.devices().helpers.filter((h) => this.info(h).azureToken).map((h) => this.pcLabel(h)).join(', '));

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
      const online = this.devices().helpers.filter((h) => h.online);
      const mine = this.state.me()?.helperKeyId;
      untracked(() => {
        if (!this.tokenPc || !online.some((h) => h.keyId === this.tokenPc)) this.tokenPc = online.find((h) => h.keyId === mine)?.keyId ?? online[0]?.keyId ?? '';
      });
    });
    effect(() => {
      if (this.section() !== 'azure' || !this.state.paired()) return;
      untracked(() => this.api.myTokenLive().subscribe({ next: (live) => this.tokenSet.set(live), error: () => this.tokenSet.set(false) }));
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
    // a helper's heartbeat says whether it keeps a token: the devices list follows the keys signal
    const keys = this.state.events$.subscribe((e) => { if (e.what === 'keys') this.loadDevices(); });
    inject(DestroyRef).onDestroy(() => { sub.unsubscribe(); keys.unsubscribe(); });
  }

  info(h: HelperRow) {
    return this.state.helperInfo(h);
  }

  /** The Windows user a helper runs as, from Alfred's record or its last heartbeat. */
  osUserOf(h: HelperRow): string {
    return h.osUser || this.info(h).osUser || '';
  }

  /** A PC as people tell it apart: its name, and the Windows user when that PC carries more than one helper. */
  pcLabel(h: HelperRow): string {
    const u = this.osUserOf(h);
    const shared = this.devices().helpers.filter((x) => x.machine.toLowerCase() === h.machine.toLowerCase()).length > 1;
    return u && shared ? `${h.machine} · ${u}` : h.machine;
  }

  /**
   * The Claude accounts signed in on that PC: Claude Code's (board sessions run with it) and Claude Desktop's when it is
   * another one - each can be switched on the PC at any time.
   */
  claudeAccounts(h: HelperRow): { account: string; where: string }[] {
    const code = this.info(h).claudeAccount || h.claudeAccount || '';
    const desktop = this.info(h).desktopAccount || '';
    if (desktop && desktop.toLowerCase() !== code.toLowerCase()) {
      return [...(code ? [{ account: code, where: 'Claude Code' }] : []), { account: desktop, where: 'Claude Desktop' }];
    }
    return code ? [{ account: code, where: desktop ? 'Code and Desktop' : 'Claude Code' }] : [];
  }

  /** Claude on that PC is signed in with another account than the one this user connected as. */
  otherClaude(h: HelperRow): boolean {
    return this.claudeAccounts(h).some((a) => a.account.includes('@') && a.account.toLowerCase() !== h.user.toLowerCase());
  }

  helperOf(machine: string, osUser?: string): HelperRow | undefined {
    const here = this.devices().helpers.filter((h) => h.machine.toLowerCase() === machine.toLowerCase());
    return (osUser ? here.find((h) => this.osUserOf(h).toLowerCase() === osUser.toLowerCase()) : undefined) ?? here[0];
  }

  /** A row's PC as one select value: machine and Windows user. */
  placeKey(p: ProjectPlace): string {
    return `${p.machine ?? ''}|${p.osUser ?? ''}`;
  }

  /** The PCs a row may name: "Any PC", each of this user's PCs (one per Windows user), and the row's own even when gone. */
  pcChoices(p: ProjectPlace): { key: string; label: string }[] {
    const out = new Map<string, string>([['|', 'Any PC']]);
    for (const h of this.devices().helpers) {
      const shared = this.devices().helpers.filter((x) => x.machine.toLowerCase() === h.machine.toLowerCase()).length > 1;
      out.set(`${h.machine}|${shared ? this.osUserOf(h) : ''}`, this.pcLabel(h));
    }
    const mine = this.placeKey(p);
    if (!out.has(mine)) out.set(mine, p.osUser ? `${p.machine} · ${p.osUser}` : p.machine);
    return [...out].map(([key, label]) => ({ key, label }));
  }

  setPc(i: number, key: string): void {
    const [machine, osUser] = key.split('|');
    this.setPlace(i, { machine, osUser: osUser || undefined });
  }

  projectChoices(current: string): string[] {
    const all = this.projects();
    return current && !all.includes(current) ? [current, ...all] : all;
  }

  /** The online PC a folder picker opens on: the row's PC, or for "Any PC" this browser's own. */
  pickerFor(p: ProjectPlace): HelperRow | null {
    const h = p.machine ? this.helperOf(p.machine, p.osUser) : this.state.targetHelper() ?? undefined;
    return h?.online ? h : null;
  }

  pickerTitle(p: ProjectPlace): string {
    const h = this.pickerFor(p);
    return h ? `Opens a folder picker on ${this.pcLabel(h)}` : 'That PC is not online';
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
    const h = this.state.targetHelper() ?? this.devices().helpers[0];
    const machine = h?.machine ?? '';
    const osUser = h && this.devices().helpers.filter((x) => x.machine === h.machine).length > 1 ? this.osUserOf(h) || undefined : undefined;
    this.places.set([...this.places(), { project: this.projects()[0] ?? '', machine, osUser, folder: '', openIn: 'DESKTOP', worktrees: true }]);
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
    const h = this.pickerFor(this.places()[i]);
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

  /** Into Alfred's memory now, and - unless "no PC" - onto the chosen PC, which keeps it and hands it over on every start. */
  setToken(): void {
    const token = this.azureToken.trim();
    const pc = this.tokenPc;
    this.azureToken = '';
    this.api.putMyToken(token).subscribe({
      next: () => {
        this.tokenSet.set(true);
        this.error.set(null);
        if (pc) this.api.pcToken(pc, token).subscribe({ error: () => this.error.set('Saved for now, but that PC could not be reached') });
      },
      error: () => this.error.set('Alfred did not take the token - is a tracker connected (Team tab)?'),
    });
  }

  /** From one PC (it stops handing it over), or - with null - out of Alfred's memory now. */
  clearToken(helperKeyId: string | null): void {
    if (helperKeyId) {
      this.api.pcToken(helperKeyId, '').subscribe({ error: () => this.error.set('Could not reach that PC') });
      return;
    }
    this.api.forgetMyToken().subscribe({ next: () => this.tokenSet.set(false), error: () => this.error.set('Could not forget the token') });
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
