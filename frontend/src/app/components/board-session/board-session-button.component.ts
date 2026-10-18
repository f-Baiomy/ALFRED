import { Component, DestroyRef, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { DatePipe, DecimalPipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { SessionsStateService } from '../../core/state/sessions-state.service';
import { SessionsApiService } from '../../core/services/sessions-api.service';
import { AppConfigService } from '../../core/services/app-config.service';
import { AuditLine, BoardSessionRow, HelperCommand, MySettings, ProjectPlace } from '../../core/models/sessions.models';

type Dialog = null | 'pair' | 'helper' | 'held' | 'request' | 'notHere' | 'folder' | 'sessions' | 'audit' | 'listen';

/**
 * ▶ alfred-live (specs/031, mock steps 1-9 and 14-15): the board's own Claude session, started on the user's PC by their
 * helper, shown in Claude Desktop and resumable in a terminal. The button follows the session it is attached to; a board
 * someone else holds shows who and lets this user ask for it; the holder answers a request here.
 */
@Component({
  selector: 'app-board-session-button',
  standalone: true,
  imports: [FormsModule, RouterLink, DatePipe, DecimalPipe],
  styles: [`
    :host { position: relative; display: inline-flex; }
    .bsb { display: inline-flex; border: 1px solid var(--border); border-radius: 6px; overflow: hidden; }
    .bsb button { border: 0; background: var(--card); color: var(--text); padding: .35rem .7rem; font: inherit; font-size: .85rem; cursor: pointer; }
    .bsb button:hover { background: var(--card-inner); }
    .bsb .main.go { background: var(--accent-blue, #5b8def); color: #fff; }
    .bsb .caret { border-left: 1px solid var(--border); padding: .35rem .5rem; }
    .dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: .4rem; background: var(--text-dim); }
    .dot.ok { background: #3fb950; } .dot.warn { background: #d29922; } .dot.bad { background: #f85149; }
    .menu { position: absolute; top: calc(100% + 4px); right: 0; z-index: 40; width: 330px; background: var(--card); border: 1px solid var(--border);
      border-radius: 8px; box-shadow: 0 8px 24px rgba(0,0,0,.25); }
    .menu .head { padding: .55rem .75rem; border-bottom: 1px solid var(--border); font-size: .85rem; }
    .menu .head small, .muted { color: var(--text-dim); }
    .menu button { display: block; width: 100%; text-align: left; border: 0; background: none; color: var(--text); padding: .45rem .75rem; font: inherit; font-size: .85rem; cursor: pointer; }
    .menu button:hover { background: var(--card-inner); }
    .menu hr { border: 0; border-top: 1px solid var(--border); margin: 0; }
    .danger { color: #f85149 !important; }
    .shade { position: fixed; inset: 0; background: rgba(0,0,0,.45); z-index: 60; display: flex; align-items: center; justify-content: center; padding: 16px; }
    .dlg { width: 540px; max-width: 100%; max-height: 90vh; overflow: auto; background: var(--card); color: var(--text); border: 1px solid var(--border);
      border-radius: 10px; box-shadow: 0 16px 40px rgba(0,0,0,.35); }
    .dlg h3 { margin: 0; padding: .9rem 1rem .25rem; font-size: 1rem; }
    .dlg .sub { padding: 0 1rem .6rem; color: var(--text-dim); font-size: .88rem; }
    .dlg .sec { padding: .6rem 1rem; border-top: 1px solid var(--border); font-size: .88rem; }
    .dlg .foot { padding: .7rem 1rem; border-top: 1px solid var(--border); display: flex; gap: .5rem; justify-content: flex-end; flex-wrap: wrap; }
    .opt { display: flex; gap: .6rem; padding: .35rem 0; align-items: flex-start; cursor: pointer; }
    .opt input[type=radio] { margin-top: .25rem; }
    .opt b { display: block; }
    .kv { display: grid; grid-template-columns: 110px 1fr; gap: .2rem .7rem; }
    .kv span:nth-child(odd) { color: var(--text-dim); }
    input[type=text], textarea, select { width: 100%; box-sizing: border-box; padding: .4rem .5rem; border: 1px solid var(--border); border-radius: 6px;
      background: var(--bg, var(--card-inner)); color: var(--text); font: inherit; margin-top: .3rem; }
    code { background: var(--card-inner); padding: 0 .3rem; border-radius: 4px; font-size: .82rem; word-break: break-all; }
    .notice { position: absolute; top: calc(100% + 4px); right: 0; z-index: 39; width: 330px; padding: .5rem .7rem; background: var(--card);
      border: 1px solid var(--border); border-radius: 8px; font-size: .82rem; box-shadow: 0 6px 18px rgba(0,0,0,.2); }
    table { width: 100%; border-collapse: collapse; font-size: .82rem; }
    td, th { text-align: left; padding: .3rem .4rem; border-bottom: 1px solid var(--border); vertical-align: top; }
    th { color: var(--text-dim); font-weight: 500; }
  `],
  template: `
    <span class="bsb">
      @switch (mode()) {
        @case ('held') {
          <button type="button" class="main" (click)="dialog.set('held')" [title]="'Held by ' + held()!.user">🔒 Held by {{ held()!.user }}@if (held()!.machine) { · {{ held()!.machine }} }</button>
        }
        @case ('busy') {
          <button type="button" class="main" disabled><span class="dot warn"></span>{{ busyLabel() }}</button>
        }
        @case ('live') {
          <button type="button" class="main" (click)="menu.set(!menu())"><span class="dot" [class.ok]="session()!.state === 'ANSWERING'"
            [class.warn]="waiting()"></span>{{ liveLabel() }}</button>
        }
        @case ('elsewhere') {
          <button type="button" class="main" (click)="dialog.set('notHere')"><span class="dot bad"></span>Session on {{ session()!.machine }}</button>
        }
        @default {
          <button type="button" class="main go" (click)="startOrAsk()" title="Start this board's own Claude session on your PC">▶ alfred-live</button>
        }
      }
      @if (mode() !== 'busy') { <button type="button" class="caret" aria-label="More" (click)="menu.set(!menu())">▾</button> }
    </span>

    @if (menu()) {
      <div class="menu" (mouseleave)="menu.set(false)">
        @if (session(); as s) {
          <div class="head"><b>Session {{ s.cliSessionId.slice(0, 8) }}</b>
            <small>{{ s.machine }} · {{ s.user }} · {{ stateText(s) }} · {{ (s.tokensToday / 1000) | number:'1.0-0' }}k tokens today</small></div>
        } @else {
          <div class="head"><b>No session yet</b><small>{{ paired() ? 'Starts on ' + (target()?.machine ?? 'your PC') : 'Pair this browser first' }}</small></div>
        }
        @if (session(); as s) {
          @if (mine()) {
            <button type="button" (click)="cmd('OPEN_DESKTOP')">🖥 Open in Claude Desktop</button>
            <button type="button" (click)="cmd('OPEN_TERMINAL')">⌨ Open in terminal <small class="muted">claude --resume {{ s.cliSessionId.slice(0, 8) }}…</small></button>
            <button type="button" (click)="copy(s.cliSessionId)">⧉ Copy session id</button>
            <hr>
            @if (s.state === 'STOPPED' || s.state === 'IDLE') { <button type="button" (click)="cmd('RESUME')">▶ Answer the board again</button> }
            <button type="button" (click)="cmd('SYNC')">⇅ Sync with the board chat</button>
            @if (listening()) { <button type="button" (click)="stopListen()">👂 Stop listening</button> }
            @else { <button type="button" (click)="dialog.set('listen'); menu.set(false)" [disabled]="!cycles().length">👂 Listen to a cycle… <small class="muted">(background lane)</small></button> }
            <button type="button" (click)="start()">＋ New session for this board</button>
            <button type="button" (click)="dialog.set('sessions')">⇄ Switch session… <small class="muted">({{ all().length }} on this board)</small></button>
            <hr>
            <button type="button" (click)="cmd('STOP')" class="danger">■ Stop answering (keep session)</button>
          }
        }
        @if (heldByMe()) { <button type="button" (click)="releaseBoard()">↩ Release the board</button> }
        <button type="button" (click)="openAudit()">☰ Board audit</button>
        <a routerLink="/me" style="display:block;padding:.45rem .75rem;font-size:.85rem">⚙ My settings</a>
      </div>
    }

    @if (notice(); as n) { <div class="notice" (click)="notice.set(null)">{{ n }}</div> }

    @switch (dialog()) {
      @case ('pair') {
        <div class="shade"><div class="dlg">
          <h3>Pair this browser first</h3>
          <div class="sub">Claude runs on your PC, through your Alfred helper. Pair this browser with it once - then ▶ starts the board's session there.</div>
          <div class="sec">On your PC run <code>alfred helper pair</code> (or the helper's tray ▸ Pair) and enter the code in My settings.</div>
          <div class="foot"><button type="button" class="action-btn" (click)="dialog.set(null)">Cancel</button>
            <a class="action-btn" routerLink="/me" (click)="dialog.set(null)">Open My settings</a></div>
        </div></div>
      }
      @case ('helper') {
        <div class="shade"><div class="dlg">
          <h3>Your Alfred helper is not running</h3>
          <div class="sub">▶ alfred-live needs it: Claude runs on your PC, not on {{ host }}.</div>
          <div class="sec">
            <label class="opt"><input type="radio" name="h" [checked]="helperChoice() === 'start'" (change)="helperChoice.set('start')"><span><b>Start it now</b>
              <small class="muted">Opens <code>alfred-helper://connect?server={{ server }}</code>. Installed once with <code>alfred helper install</code>.</small></span></label>
            @for (h of otherOnline(); track h.keyId) {
              <label class="opt"><input type="radio" name="h" [checked]="helperChoice() === h.keyId" (change)="helperChoice.set(h.keyId)"><span><b>Run it on {{ h.machine }}</b><small class="muted">online</small></span></label>
            }
          </div>
          <div class="foot"><button type="button" class="action-btn" (click)="dialog.set(null)">Cancel</button>
            <button type="button" class="action-btn primary" (click)="helperGo()">{{ helperChoice() === 'start' ? 'Start helper' : 'Start there' }}</button></div>
        </div></div>
      }
      @case ('held') {
        <div class="shade"><div class="dlg">
          <h3>🔒 Held by {{ held()!.user }}</h3>
          <div class="sub">Session {{ (held()!.sessionId ?? '-').slice(0, 8) }} on {{ held()!.machine || 'their PC' }} since {{ held()!.since | date:'short' }}.
            You can read this board; writing waits until they hand it over or release it.</div>
          @if (held()!.request; as r) {
            <div class="sec">Asked by {{ r.user }} {{ r.at | date:'short' }}@if (r.note) { - "{{ r.note }}" }</div>
          }
          @if (paired()) {
            <div class="sec">A note for {{ held()!.user }} (optional)<textarea rows="2" [(ngModel)]="note" maxlength="500"></textarea></div>
          } @else {
            <div class="sec">Pair this browser (My settings) to ask for the board.</div>
          }
          <div class="foot">
            @if (admin()) { <button type="button" class="action-btn danger" (click)="forceRelease()">Force release (admin)</button> }
            <button type="button" class="action-btn" (click)="dialog.set(null)">Close</button>
            @if (paired()) { <button type="button" class="action-btn primary" (click)="ask()">Ask for the board</button> }
          </div>
        </div></div>
      }
      @case ('request') {
        <div class="shade"><div class="dlg">
          <h3>{{ myHolder()!.request!.user }} asks for this board</h3>
          @if (myHolder()!.request!.note) { <div class="sub">"{{ myHolder()!.request!.note }}"</div> }
          <div class="sec">
            <label class="opt"><input type="radio" name="q" [checked]="answer() === 'HAND_OVER'" (change)="answer.set('HAND_OVER')"><span><b>Hand it over</b>
              <small class="muted">Your session stops answering and stays (resumable). Waiting messages go to their session.</small></span></label>
            <label class="opt"><input type="radio" name="q" [checked]="answer() === 'RELEASE'" (change)="answer.set('RELEASE')"><span><b>Release, anyone may take it</b></span></label>
            <label class="opt"><input type="radio" name="q" [checked]="answer() === 'KEEP'" (change)="answer.set('KEEP')"><span><b>Keep it</b>
              <small class="muted">They see that you kept it.</small></span></label>
          </div>
          <div class="foot"><button type="button" class="action-btn" (click)="later()">Later</button>
            <button type="button" class="action-btn primary" (click)="sendAnswer()">Confirm</button></div>
        </div></div>
      }
      @case ('notHere') {
        <div class="shade"><div class="dlg">
          <h3>Session not found on this PC</h3>
          <div class="sub">This board's session isn't here. It was last used on another machine or account.</div>
          @if (session(); as s) {
            <div class="sec kv">
              <span>Session</span><span><code>{{ s.cliSessionId }}</code></span>
              <span>Machine</span><span>{{ s.machine }}@if (target()) { (this is {{ target()!.machine }}) }</span>
              <span>Account</span><span>{{ s.user }}</span>
              <span>Last active</span><span>{{ s.lastActive | date:'short' }}</span>
            </div>
          }
          <div class="sec">
            <label class="opt"><input type="radio" name="r" [checked]="notHere() === 'copy'" (change)="notHere.set('copy')"><span><b>Continue here from Alfred's copy</b>
              <small class="muted">A new session on this PC, started from the board's chat summary, decisions and brief. Becomes this board's session.</small></span></label>
            @if (sessionHelperOnline()) {
              <label class="opt"><input type="radio" name="r" [checked]="notHere() === 'there'" (change)="notHere.set('there')"><span><b>Resume it on {{ session()!.machine }}</b>
                <small class="muted">That PC's helper is online - the session continues there, exactly as it was.</small></span></label>
            }
            @if (others().length) {
              <label class="opt"><input type="radio" name="r" [checked]="notHere() === 'other'" (change)="notHere.set('other')"><span><b>Pick another session of this board</b>
                <select [(ngModel)]="pickId">@for (o of others(); track o.id) { <option [value]="o.id">{{ o.cliSessionId.slice(0, 8) }} · {{ o.machine }} · {{ o.lastActive | date:'short' }}</option> }</select></span></label>
            }
            <label class="opt"><input type="radio" name="r" [checked]="notHere() === 'id'" (change)="notHere.set('id')"><span><b>Enter a session id</b>
              <small class="muted">Any Claude Code session on this PC - its id, or paste a <code>claude --resume</code> line.</small>
              <input type="text" [(ngModel)]="enteredId" placeholder="e.g. 4e7c1a02-91b3-… or claude --resume 4e7c…"></span></label>
          </div>
          <div class="foot"><button type="button" class="action-btn" (click)="dialog.set(null)">Cancel</button>
            <button type="button" class="action-btn primary" (click)="notHereGo()">Continue</button></div>
        </div></div>
      }
      @case ('folder') {
        <div class="shade"><div class="dlg">
          <h3>Where is {{ project() }} on {{ target()?.machine ?? 'this PC' }}?</h3>
          <div class="sub">Sessions start in the project's repo folder on your PC; each board gets its own worktree there.</div>
          <div class="sec">Repo folder<input type="text" [(ngModel)]="folder" placeholder="C:\\work\\odeysys">
            <button type="button" class="action-btn" style="margin-top:.4rem" (click)="pickFolder()">Pick folder on {{ target()?.machine ?? 'this PC' }}…</button></div>
          <div class="sec">Open sessions in
            <select [(ngModel)]="openIn"><option value="DESKTOP">Claude Desktop</option><option value="TERMINAL">Terminal</option>
              <option value="BOTH">Both</option><option value="BACKGROUND">Background only</option></select></div>
          <div class="foot"><button type="button" class="action-btn" (click)="dialog.set(null)">Cancel</button>
            <button type="button" class="action-btn primary" [disabled]="!folder.trim()" (click)="saveFolderAndStart()">Save and start</button></div>
        </div></div>
      }
      @case ('sessions') {
        <div class="shade"><div class="dlg">
          <h3>This board's sessions</h3>
          <div class="sec"><table>
            <tr><th>Session</th><th>Where</th><th>State</th><th></th></tr>
            @for (o of all(); track o.id) {
              <tr><td><code>{{ o.cliSessionId.slice(0, 8) }}</code>@if (o.current) { <b> current</b> }</td><td>{{ o.machine }}</td><td>{{ stateText(o) }}</td>
                <td>@if (!o.current) { <button type="button" class="action-btn" (click)="switchTo(o)">Make current</button> }</td></tr>
            }
          </table></div>
          <div class="foot"><button type="button" class="action-btn" (click)="dialog.set(null)">Close</button></div>
        </div></div>
      }
      @case ('listen') {
        <div class="shade"><div class="dlg">
          <h3>👂 Listen to a cycle</h3>
          <div class="sub">Claude checks every new call of the cycle while you test - on {{ session()?.machine }}, in short copies of this board's session, so it never types into your conversation. Findings land on the board.</div>
          <div class="sec"><select [(ngModel)]="listenCycle">@for (c of cycles(); track c.id) { <option [value]="c.id">{{ c.name }}</option> }</select></div>
          <div class="foot"><button type="button" class="action-btn" (click)="dialog.set(null)">Cancel</button>
            <button type="button" class="action-btn primary" (click)="startListen()">Start listening</button></div>
        </div></div>
      }
      @case ('audit') {
        <div class="shade"><div class="dlg">
          <h3>Board audit</h3>
          <div class="sec"><table>
            <tr><th>When</th><th>What</th><th>By</th><th>PC · through</th></tr>
            @for (a of audit(); track a.id) {
              <tr><td>{{ a.at | date:'short' }}</td><td>{{ a.what }}</td><td>{{ a.user }}</td><td>{{ a.machine }} · {{ a.via }}</td></tr>
            } @empty { <tr><td colspan="4" class="muted">Nothing written on this board yet.</td></tr> }
          </table></div>
          <div class="foot"><button type="button" class="action-btn" (click)="dialog.set(null)">Close</button></div>
        </div></div>
      }
    }
  `,
})
export class BoardSessionButtonComponent {
  readonly project = input.required<string>();
  readonly boardId = input.required<string>();
  readonly title = input<string | null>(null);
  /** The board's cycles, to listen to one. */
  readonly cycles = input<readonly { id: string; name: string }[]>([]);
  readonly listening = signal<string | null>(null);
  listenCycle = '';

  readonly state = inject(SessionsStateService);
  private readonly api = inject(SessionsApiService);
  private readonly config = inject(AppConfigService);

  readonly menu = signal(false);
  readonly dialog = signal<Dialog>(null);
  readonly notice = signal<string | null>(null);
  readonly helperChoice = signal<string>('start');
  readonly answer = signal<'HAND_OVER' | 'RELEASE' | 'KEEP'>('HAND_OVER');
  readonly notHere = signal<'copy' | 'there' | 'other' | 'id'>('copy');
  readonly audit = signal<readonly AuditLine[]>([]);
  note = '';
  pickId = '';
  enteredId = '';
  folder = '';
  openIn: ProjectPlace['openIn'] = 'DESKTOP';
  private laterFor: string | null = null;

  readonly host = window.location.host;
  readonly server = this.config.backendUrl;
  readonly paired = this.state.paired;
  readonly admin = computed(() => !!this.state.me()?.admin);
  readonly target = this.state.targetHelper;
  readonly held = computed(() => this.state.heldByOther(this.boardId()));
  readonly myHolder = computed(() => (this.state.heldByMe(this.boardId()) ? this.state.holderOf(this.boardId()) : null));
  readonly heldByMe = computed(() => this.state.heldByMe(this.boardId()));
  readonly session = computed(() => this.state.currentSession(this.boardId()));
  readonly all = computed(() => this.state.sessionsOf(this.boardId()));
  readonly others = computed(() => this.all().filter((s) => s.id !== this.session()?.id && s.user === this.state.user()));
  readonly pending = computed(() => this.state.pendingFor(this.boardId()));
  readonly mine = computed(() => !!this.session() && this.session()!.user === this.state.user());
  readonly otherOnline = computed(() => this.state.onlineHelpers().filter((h) => h.keyId !== this.state.me()?.helperKeyId));
  readonly sessionHelperOnline = computed(() => {
    const s = this.session();
    return !!s && this.state.onlineHelpers().some((h) => h.keyId === s.helperKeyId);
  });
  readonly waiting = computed(() => ['WAITING_BUDGET', 'WAITING_LIMIT', 'STARTING'].includes(this.session()?.state ?? ''));
  readonly mode = computed<'held' | 'busy' | 'live' | 'elsewhere' | 'start'>(() => {
    if (this.held()) return 'held';
    if (this.pending()) return 'busy';
    const s = this.session();
    if (!s || !this.mine()) return 'start';
    const here = this.target();
    if (here && s.helperKeyId !== here.keyId && s.machine !== here.machine) return 'elsewhere';
    return 'live';
  });
  readonly busyLabel = computed(() => {
    const c = this.pending();
    if (!c) return '';
    return c.state === 'QUEUED' ? `Waiting for ${this.helperName(c)}…` : `${({ START: 'Starting', RESUME: 'Resuming', SYNC: 'Syncing', CONTINUE_FROM_COPY: 'Starting', ATTACH: 'Attaching' } as Record<string, string>)[c.kind] ?? 'Working'}…`;
  });
  readonly liveLabel = computed(() => {
    const s = this.session()!;
    const id = s.cliSessionId.slice(0, 8);
    switch (s.state) {
      case 'ANSWERING': return `Live · session ${id}${s.openIn !== 'NONE' ? ` · in ${s.openIn === 'DESKTOP' ? 'Desktop' : 'terminal'}` : ''}`;
      case 'WAITING_BUDGET': return '⏸ Budget reached';
      case 'WAITING_LIMIT': return '⏸ Usage limit - retries later';
      case 'STARTING': return 'Starting…';
      default: return `Session ${id} · idle`;
    }
  });

  constructor() {
    this.state.start();
    // the holder sees a request the moment it arrives (once per request, "Later" waits for the next)
    effect(() => {
      const h = this.myHolder();
      untracked(() => {
        const key = h?.request ? `${h.boardId}|${h.request.user}|${h.request.at}` : null;
        if (key && key !== this.laterFor && this.dialog() === null) this.dialog.set('request');
      });
    });
    const sub = this.state.finished$.subscribe((c) => {
      if (c.boardId !== this.boardId() && !(c.kind === 'PICK_FOLDER' && this.dialog() === 'folder')) return;
      this.onFinished(c);
    });
    inject(DestroyRef).onDestroy(() => sub.unsubscribe());
  }

  helperName(c: HelperCommand): string {
    return this.state.helpers().find((h) => h.keyId === c.helperKeyId)?.machine ?? 'your PC';
  }

  stateText(s: BoardSessionRow): string {
    return ({ ANSWERING: 'answering', IDLE: 'idle', STOPPED: 'stopped', STARTING: 'starting', WAITING_BUDGET: 'budget reached',
      WAITING_LIMIT: 'usage limit', GONE: 'transcript gone' } as Record<string, string>)[s.state] ?? s.state.toLowerCase();
  }

  startOrAsk(): void {
    if (this.held()) { this.dialog.set('held'); return; }
    const s = this.session();
    if (s && this.mine()) { this.cmd('RESUME'); return; }
    this.start();
  }

  start(): void {
    this.menu.set(false);
    if (!this.paired()) { this.dialog.set('pair'); return; }
    if (!this.target()) { this.dialog.set('helper'); return; }
    const place = this.placeHere();
    if (!place) {
      this.folder = '';
      this.dialog.set('folder');
      return;
    }
    this.state.send('START', { boardId: this.boardId(), project: this.project(), args: { title: this.title() ?? this.boardId(), boardRef: this.boardId() } })
      .subscribe((c) => { if (!c) this.notice.set('Could not send it to your PC'); });
  }

  private placeHere(): ProjectPlace | null {
    const machine = this.target()?.machine?.toLowerCase();
    return (this.state.settings().projects ?? []).find((p) => p.project === this.project() && (!p.machine || p.machine.toLowerCase() === machine)) ?? null;
  }

  cmd(kind: 'OPEN_DESKTOP' | 'OPEN_TERMINAL' | 'RESUME' | 'SYNC' | 'STOP'): void {
    this.menu.set(false);
    const s = this.session();
    if (!s) return;
    this.state.send(kind, { boardId: this.boardId(), project: this.project(), sessionId: s.id, helperKeyId: s.helperKeyId,
      args: { cliSessionId: s.cliSessionId, boardRef: this.boardId() } }).subscribe((c) => { if (!c) this.notice.set('Could not send it to your PC'); });
  }

  copy(id: string): void {
    this.menu.set(false);
    void navigator.clipboard?.writeText(id).then(() => this.notice.set(`Copied ${id}`), () => this.notice.set(id));
  }

  releaseBoard(): void {
    this.menu.set(false);
    this.api.release(this.boardId()).subscribe({ next: () => this.notice.set('Board released - anyone may take it now'), error: () => undefined });
  }

  ask(): void {
    this.api.ask(this.boardId(), this.note.trim()).subscribe({
      next: (h) => { this.dialog.set(null); this.notice.set(h.user === this.state.user() ? 'The board is yours now' : `Asked ${h.user} for the board`); },
      error: (e) => this.notice.set(e?.error?.message ?? 'Could not ask'),
    });
  }

  forceRelease(): void {
    this.api.forceRelease(this.boardId()).subscribe({ next: () => this.dialog.set(null), error: (e) => this.notice.set(e?.error?.message ?? 'Refused') });
  }

  later(): void {
    const h = this.myHolder();
    this.laterFor = h?.request ? `${h.boardId}|${h.request.user}|${h.request.at}` : null;
    this.dialog.set(null);
  }

  startListen(): void {
    const s = this.session();
    const cycle = this.listenCycle || this.cycles()[0]?.id;
    if (!s || !cycle) return;
    this.dialog.set(null);
    const name = this.cycles().find((c) => c.id === cycle)?.name ?? cycle;
    this.state.send('LISTEN', { boardId: this.boardId(), project: this.project(), sessionId: s.id, helperKeyId: s.helperKeyId,
      args: { cliSessionId: s.cliSessionId, cycleId: cycle, cycleName: name } }).subscribe((c) => { if (c) this.listening.set(cycle); });
  }

  stopListen(): void {
    const s = this.session();
    this.menu.set(false);
    if (!s) return;
    this.state.send('STOP_LISTEN', { boardId: this.boardId(), project: this.project(), sessionId: s.id, helperKeyId: s.helperKeyId,
      args: { cliSessionId: s.cliSessionId, cycleId: this.listening() } }).subscribe(() => this.listening.set(null));
  }

  sendAnswer(): void {
    const answer = this.answer();
    const s = this.session();
    // hand over through the session when it can still write its handover note (its helper is online)
    if (answer === 'HAND_OVER' && s && this.mine() && this.state.onlineHelpers().some((h) => h.keyId === s.helperKeyId)) {
      this.dialog.set(null);
      this.state.send('HANDOVER', { boardId: this.boardId(), project: this.project(), sessionId: s.id, helperKeyId: s.helperKeyId,
        args: { cliSessionId: s.cliSessionId, to: this.myHolder()?.request?.user, boardRef: this.boardId() } }).subscribe();
      return;
    }
    this.api.answer(this.boardId(), answer).subscribe({
      next: () => {
        this.dialog.set(null);
        if (answer === 'HAND_OVER' && this.session()) this.cmd('STOP');
      },
      error: (e) => this.notice.set(e?.error?.message ?? 'Could not answer'),
    });
  }

  helperGo(): void {
    const choice = this.helperChoice();
    if (choice === 'start') {
      window.location.href = `alfred-helper://connect?server=${encodeURIComponent(this.server)}`;
      this.dialog.set(null);
      return;
    }
    this.dialog.set(null);
    this.state.send('START', { boardId: this.boardId(), project: this.project(), helperKeyId: choice, args: { title: this.title() ?? this.boardId() } }).subscribe();
  }

  notHereGo(): void {
    const s = this.session();
    this.dialog.set(null);
    switch (this.notHere()) {
      case 'copy':
        this.state.send('CONTINUE_FROM_COPY', { boardId: this.boardId(), project: this.project(), args: { title: this.title() ?? this.boardId(), boardRef: this.boardId() } }).subscribe();
        break;
      case 'there':
        if (s) this.state.send('RESUME', { boardId: this.boardId(), project: this.project(), sessionId: s.id, helperKeyId: s.helperKeyId, args: { cliSessionId: s.cliSessionId } }).subscribe();
        break;
      case 'other': {
        const o = this.others().find((x) => x.id === this.pickId) ?? this.others()[0];
        if (o) this.state.send('RESUME', { boardId: this.boardId(), project: this.project(), sessionId: o.id, helperKeyId: o.helperKeyId, args: { cliSessionId: o.cliSessionId } }).subscribe();
        break;
      }
      case 'id': {
        const id = (this.enteredId.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i) ?? [])[0];
        if (!id) { this.notice.set('That is not a Claude session id'); return; }
        this.state.send('ATTACH', { boardId: this.boardId(), project: this.project(), args: { cliSessionId: id, title: this.title() ?? this.boardId() } }).subscribe();
        break;
      }
    }
  }

  pickFolder(): void {
    this.state.send('PICK_FOLDER', { project: this.project() }).subscribe();
  }

  saveFolderAndStart(): void {
    const machine = this.target()?.machine ?? '';
    const s: MySettings = this.state.settings();
    const rest = (s.projects ?? []).filter((p) => !(p.project === this.project() && p.machine === machine));
    const place: ProjectPlace = { project: this.project(), machine, folder: this.folder.trim(), openIn: this.openIn, worktrees: true };
    this.state.saveSettings({ ...s, projects: [...rest, place] }).subscribe((saved) => {
      if (!saved) { this.notice.set('Could not save My settings'); return; }
      this.dialog.set(null);
      this.start();
    });
  }

  switchTo(o: BoardSessionRow): void {
    this.dialog.set(null);
    this.state.send('RESUME', { boardId: this.boardId(), project: this.project(), sessionId: o.id, helperKeyId: o.helperKeyId,
      args: { cliSessionId: o.cliSessionId, makeCurrent: true } }).subscribe();
  }

  openAudit(): void {
    this.menu.set(false);
    this.api.audit(this.boardId()).subscribe({ next: (a) => { this.audit.set(a); this.dialog.set('audit'); }, error: () => undefined });
  }

  private onFinished(c: HelperCommand): void {
    const r = c.result ?? '';
    if (c.kind === 'PICK_FOLDER') {
      if (c.state === 'DONE' && r) this.folder = r;
      return;
    }
    if (c.state === 'FAILED' && r.startsWith('NO_FOLDER')) { this.folder = ''; this.dialog.set('folder'); return; }
    if (c.state === 'FAILED' && r.startsWith('NOT_HERE')) { this.dialog.set('notHere'); return; }
    this.notice.set(c.state === 'DONE' ? r || 'Done' : `Failed: ${r}`);
  }
}
