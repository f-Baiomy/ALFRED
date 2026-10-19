import { Component, DestroyRef, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { DatePipe, DecimalPipe, NgTemplateOutlet } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { SessionsStateService } from '../../core/state/sessions-state.service';
import { SessionsApiService } from '../../core/services/sessions-api.service';
import { AppConfigService } from '../../core/services/app-config.service';
import { BoardBannerService } from '../../core/state/board-banner.service';
import { ConnectPcComponent } from './connect-pc.component';
import { AuditLine, BoardSessionRow, CommandKind, HelperCommand, MySettings, ProjectPlace } from '../../core/models/sessions.models';
import { CloseOnOutsideDirective } from '../../shared/directives/close-on-outside.directive';
import { copyToClipboard } from '../../shared/utils/clipboard';
import { failureLine } from '../../shared/utils/failure-line';
import { shortUser } from '../../shared/utils/claude-mode';

type Dialog = null | 'pair' | 'helper' | 'held' | 'request' | 'notHere' | 'sessions' | 'audit' | 'listen' | 'handback';

/** What to run once Claude is on (the Next card's step). */
export interface ThenRun {
  readonly command: string;
  readonly prompt: string;
  readonly cardNumber?: number | null;
}

/** The helper's words for a session Claude Desktop has not read yet (helper DESKTOP_RESTART). */
export function needsDesktopRestart(result: string | null | undefined): boolean {
  return /reads new sessions only when it starts/i.test(result ?? '');
}

/** A Pause still waiting for the PC after this long says so (one delay, not a poll). */
export const PAUSE_SLOW_MS = 4000;

/**
 * The board's Claude (specs/031, redesigned in specs/032 D4-D7): one control that starts Claude on the user's PC,
 * says it is on, pauses and resumes it, and hands the board back. Its panel says what Claude is doing and every choice in
 * plain words; each action shows that it landed (Pausing…, then a banner), and menus close on an outside click or Escape,
 * never when the pointer leaves them.
 */
@Component({
  selector: 'app-board-session-button',
  standalone: true,
  imports: [FormsModule, RouterLink, DatePipe, DecimalPipe, NgTemplateOutlet, ConnectPcComponent, CloseOnOutsideDirective],
  styles: [`
    :host { position: relative; display: inline-flex; }
    .split { display: inline-flex; }
    .cb { display: inline-flex; align-items: center; gap: 8px; padding: 7px 14px; border: 1px solid transparent; border-radius: 8px 0 0 8px;
      font: inherit; font-size: 13px; font-weight: 600; white-space: nowrap; cursor: pointer; }
    .cm { padding: 7px 9px; border: 1px solid transparent; border-left: 1px solid rgba(255,255,255,.2); border-radius: 0 8px 8px 0; font: inherit; font-size: 12px; cursor: pointer; }
    .solo { border-radius: 8px; }
    .cb:disabled { cursor: default; }
    .k-start { background: var(--purple); color: #fff; }
    .k-on { background: color-mix(in srgb, var(--green) 12%, transparent); border-color: color-mix(in srgb, var(--green) 40%, transparent); color: var(--green); }
    .k-paused { background: color-mix(in srgb, var(--purple) 12%, transparent); border-color: var(--border-strong); color: var(--purple-light); }
    .k-wait { background: color-mix(in srgb, var(--amber) 12%, transparent); border-color: color-mix(in srgb, var(--amber) 40%, transparent); color: var(--amber); }
    .k-bad { background: color-mix(in srgb, var(--red) 12%, transparent); border-color: color-mix(in srgb, var(--red) 40%, transparent); color: var(--red); }
    .k-held { background: var(--card-inner); border-color: var(--border-strong); color: var(--text-dim); }
    .spin { display: inline-block; width: 11px; height: 11px; border: 2px solid currentColor; border-right-color: transparent; border-radius: 50%; animation: sp .8s linear infinite; }
    @keyframes sp { to { transform: rotate(360deg); } }
    .panel { position: absolute; right: 0; top: calc(100% + 8px); z-index: 70; width: 380px; max-width: calc(100vw - 32px); max-height: calc(100vh - 150px);
      overflow: auto; background: var(--popover-solid); border: 1px solid var(--border-strong); border-radius: 12px; box-shadow: 0 14px 34px rgba(0,0,0,.5); }
    .quick { position: sticky; top: 0; z-index: 1; display: flex; gap: 8px; padding: 10px 16px; border-bottom: 1px solid var(--border); background: var(--popover-solid); }
    .quick .action-btn { flex: 1; text-align: center; }
    .ph { padding: 14px 16px 12px; border-bottom: 1px solid var(--border); }
    .ph .t { display: flex; align-items: center; gap: 8px; font-size: 15px; font-weight: 600; }
    .ph .d { margin-top: 3px; color: var(--text-dim); font-size: 12.5px; }
    .d.listen { margin: 10px 16px 0; color: var(--warning, #e0a040); font-size: 12.5px; }
    .d.listen code { font-size: 11.5px; }
    .meter { height: 5px; margin-top: 9px; overflow: hidden; border-radius: 999px; background: var(--card-inner); }
    .meter i { display: block; height: 100%; background: var(--purple); }
    .grp { padding: 8px 8px 6px; border-bottom: 1px solid var(--border); }
    .gl { padding: 2px 8px 4px; color: var(--text-faint); font-size: 10.5px; font-weight: 700; letter-spacing: .6px; text-transform: uppercase; }
    .it { display: grid; grid-template-columns: 24px minmax(0, 1fr) auto; gap: 8px; align-items: center; width: 100%; padding: 7px 8px; border: 0; border-radius: 8px;
      background: none; color: var(--text); font: inherit; font-size: 13px; text-align: left; cursor: pointer; }
    .it:hover:not(:disabled) { background: color-mix(in srgb, var(--purple) 12%, transparent); }
    .it:disabled { opacity: .55; cursor: default; }
    .it .ico { color: var(--purple-light); text-align: center; }
    .it small { display: block; color: var(--text-dim); font-size: 11.5px; }
    .it .kk { color: var(--text-faint); font-size: 11.5px; }
    .hint { padding: 0 8px 4px 40px; color: var(--text-faint); font-size: 11.5px; }
    .hint button { padding: 0; border: 0; background: none; color: var(--purple-light); font: inherit; cursor: pointer; }
    .body { padding: 12px 16px; font-size: 13px; }
    .body p { margin: 0 0 10px; color: var(--text-dim); }
    .body label { display: block; margin: 10px 0 4px; color: var(--text); font-weight: 600; }
    .row { display: flex; gap: 6px; align-items: center; }
    .pills { display: flex; flex-wrap: wrap; gap: 6px; }
    .pill { display: inline-flex; align-items: center; gap: 6px; padding: 3px 11px; border: 1px solid var(--border); border-radius: 999px; background: transparent;
      color: var(--text-dim); font: inherit; font-size: 12px; cursor: pointer; }
    .pill.on { border-color: var(--purple); background: color-mix(in srgb, var(--purple) 12%, transparent); color: var(--purple-light); }
    .faint { color: var(--text-faint); font-size: 11.5px; }
    .acts { display: flex; gap: 8px; justify-content: flex-end; margin-top: 12px; }
    .bad { color: var(--red); }
  `],
  template: `
    <span class="wrap" [appCloseOnOutside]="panel()" (closed)="panel.set(false)">
      <span class="split">
        @switch (view().mode) {
          @case ('start') { <button type="button" class="cb k-start" [title]="view().tooltip" (click)="startOrPanel()">{{ view().label }}</button> }
          @case ('paused') { <button type="button" class="cb k-paused" [title]="view().tooltip" (click)="resume()">{{ view().label }}</button> }
          @case ('busy') { <button type="button" class="cb k-wait" disabled [title]="view().tooltip"><span class="spin"></span>{{ view().label }}</button> }
          @case ('on') { <button type="button" class="cb k-on" [title]="view().tooltip" (click)="panel.set(!panel())">{{ view().label }}</button> }
          @case ('terminal') { <button type="button" class="cb k-on" [title]="view().tooltip" (click)="panel.set(!panel())">{{ view().label }}</button> }
          @case ('failed') { <button type="button" class="cb k-bad" [title]="view().tooltip" (click)="panel.set(true)">{{ view().label }}</button> }
          @case ('held') { <button type="button" class="cb k-held" [title]="view().tooltip" (click)="dialog.set('held')">{{ view().label }}</button> }
          @case ('elsewhere') { <button type="button" class="cb k-paused" [title]="view().tooltip" (click)="dialog.set('notHere')">{{ view().label }}</button> }
        }
        <button type="button" class="cm" [class]="'cm ' + kindClass()" aria-label="More about Claude on this board" [attr.aria-expanded]="panel()" (click)="panel.set(!panel())">▾</button>
      </span>

      @if (panel()) {
        <div class="panel" role="dialog" aria-label="Claude on this board">
          @switch (panelView()) {
            @case ('on') {
              @let s = session()!;
              <div class="quick">
                <button type="button" class="action-btn" [disabled]="view().mode === 'busy'" (click)="pause()">⏸ Pause Claude</button>
                <button type="button" class="action-btn" [disabled]="view().mode === 'busy'" (click)="askHandBack()">↩ Hand the board back</button>
              </div>
              <div class="ph">
                @if (view().mode === 'busy') {
                  <div class="t"><span class="spin"></span> {{ view().label }}</div>
                  <div class="d">{{ s.progress || 'Your PC is working on it' }}</div>
                } @else {
                  <div class="t">● Claude is answering this board</div>
                  <div class="d">On {{ s.machine }} as {{ account() }} · since {{ s.createdAt | date:'shortTime' }}</div>
                }
                <div class="d">{{ (s.tokensToday / 1000) | number:'1.0-0' }}k tokens today@if (budget()) { of {{ (budget()! / 1000) | number:'1.0-0' }}k }</div>
                @if (budget()) { <div class="meter" aria-hidden="true"><i [style.width.%]="meter()"></i></div> }
              </div>
              <div class="grp">
                <div class="gl">See the conversation</div>
                <button type="button" class="it" (click)="cmd('OPEN_DESKTOP')"><span class="ico">🖥</span><span>Open in Claude Desktop<small>the board waits while it is open</small></span></button>
                <div class="hint">Not in Desktop's list? <button type="button" (click)="restartDesktop()">Restart Desktop</button> - it reads new sessions when it starts.</div>
                <button type="button" class="it" (click)="cmd('OPEN_TERMINAL')"><span class="ico">⌨</span><span>Open in a terminal<small>claude --resume {{ s.cliSessionId.slice(0, 8) }}…</small></span></button>
              </div>
              <div class="grp">
                <div class="gl">While you test</div>
                @if (listening()) {
                  <button type="button" class="it" (click)="stopListen()"><span class="ico">👂</span><span>Stop watching<small>Claude stops checking the recording's calls</small></span></button>
                } @else {
                  <button type="button" class="it" [disabled]="!cycles().length" (click)="dialog.set('listen'); panel.set(false)"><span class="ico">👂</span>
                    <span>Watch a recording<small>{{ cycles().length ? 'Claude checks every new call while you test' : 'no recording on this board yet' }}</small></span></button>
                }
              </div>
              <div class="grp">
                <div class="gl">This session</div>
                <button type="button" class="it" (click)="start()"><span class="ico">＋</span><span>Start fresh<small>a new conversation for this board; this one is kept</small></span></button>
                <button type="button" class="it" (click)="dialog.set('sessions'); panel.set(false)"><span class="ico">⇄</span><span>Earlier sessions</span><span class="kk">{{ all().length }} on this board</span></button>
              </div>
              <ng-container *ngTemplateOutlet="foot" />
            }
            @case ('paused') {
              @let s = session()!;
              <div class="ph">
                <div class="t">{{ s.state === 'ANSWERING' ? '⚠ Claude stopped answering' : '⏸ Claude is paused' }}</div>
                <div class="d">Last answered {{ s.lastActive | date:'short' }} on {{ s.machine }}@if (unread()) { · {{ unread() }} new chat message{{ unread() === 1 ? '' : 's' }} since }</div>
              </div>
              @if (s.state === 'ANSWERING') {
                <div class="d listen">Its session no longer hears the board (a Desktop restart, a stopped watch) - your messages wait for it, never
                  answered in a copy. ▶ Resume brings the session up; send <code>{{ listenCmd() }}</code> there
                  <button type="button" class="link-btn" (click)="copy(listenCmd())">{{ copied() === listenCmd() ? 'copied' : 'copy' }}</button></div>
              }
              <div class="body">
                <div class="acts" style="justify-content:flex-start;margin-top:0">
                  <button type="button" class="action-btn primary" (click)="resume()">▶ {{ unread() ? 'Resume and catch up on ' + unread() + ' message' + (unread() === 1 ? '' : 's') : 'Resume Claude' }}</button>
                  <button type="button" class="action-btn" (click)="askHandBack()">↩ Hand back</button>
                </div>
              </div>
              <div class="grp">
                <div class="gl">Or</div>
                <button type="button" class="it" (click)="start()"><span class="ico">＋</span><span>Start fresh<small>a new conversation for this board</small></span></button>
                <button type="button" class="it" (click)="cmd('OPEN_DESKTOP')"><span class="ico">🖥</span><span>Read it in Claude Desktop<small>opens the conversation without resuming it</small></span></button>
                <button type="button" class="it" (click)="dialog.set('sessions'); panel.set(false)"><span class="ico">⇄</span><span>Earlier sessions</span><span class="kk">{{ all().length }} on this board</span></button>
              </div>
              <ng-container *ngTemplateOutlet="foot" />
            }
            @case ('failed') {
              @let f = failure()!;
              <div class="ph"><div class="t bad">⚠ Claude didn't start</div><div class="d">{{ f.text }}</div></div>
              <div class="body">
                @if (f.fix) { <p>{{ f.fix }}</p> }
                <div class="acts">
                  <button type="button" class="action-btn" (click)="dismissFailure()">Close</button>
                  <button type="button" class="action-btn primary" (click)="tryAgain()">↻ Try again</button>
                </div>
              </div>
            }
            @case ('terminal') {
              <div class="ph"><div class="t">● Claude is answering from a terminal</div>
                <div class="d">A <code>/alfred-live</code> in a terminal reads this board's chat - not a session Alfred started.</div></div>
              <div class="body">
                <label>How to stop it</label>
                <p>Type this in that terminal: <code>/alfred-live stop</code>
                  <button type="button" class="action-btn" (click)="copy('/alfred-live stop')">{{ copied() === '/alfred-live stop' ? '✓ Copied' : '⧉ Copy' }}</button></p>
                <p>Or start Claude here: the newest one answers the board, and the terminal stops answering.</p>
                <div class="acts"><button type="button" class="action-btn primary" (click)="start()">▶ Start Claude here</button></div>
              </div>
              <ng-container *ngTemplateOutlet="foot" />
            }
            @default {
              <div class="ph"><div class="t">▶ Start Claude for this board</div>
                <div class="d">Claude runs on your PC, with your Claude account and your copy of the code. Alfred only passes the board's messages to it.</div></div>
              @if (!paired() || !target()) {
                <div class="body">
                  <p>{{ paired() ? 'Your Alfred helper is not running on this PC - it starts Claude there.' : 'Connect this PC first: once per PC, then Start Claude starts it at once.' }}</p>
                  <div class="acts"><button type="button" class="action-btn primary" (click)="start()">{{ paired() ? 'Start the helper…' : '⬇ Connect this PC…' }}</button></div>
                </div>
              } @else if (place()) {
                <div class="body">
                  <p>It starts in <code>{{ place()!.folder }}</code> on {{ target()?.machine ?? 'your PC' }}, in this board's own worktree.</p>
                  <div class="acts" style="justify-content:space-between">
                    <a routerLink="/me" class="faint">Change the folder in My settings</a>
                    <button type="button" class="action-btn primary" (click)="start()">▶ Start Claude</button>
                  </div>
                </div>
              } @else {
                <div class="body">
                  <label for="bsb-folder">Where is {{ project() }}'s code on {{ target()?.machine ?? 'this PC' }}?</label>
                  <div class="row"><input id="bsb-folder" type="text" [(ngModel)]="folder" placeholder="C:\\work\\odeysys" style="flex:1">
                    <button type="button" class="action-btn" [disabled]="picking()" (click)="pickFolder()">Browse…</button></div>
                  @if (picking()) {
                    <div class="faint">A "Browse For Folder" window opened on {{ target()?.machine ?? 'your PC' }}. Not in front? Look for it on the taskbar.</div>
                  } @else {
                    <div class="faint">Claude reads the code there (and fixes it when you ask). Browse opens a folder window on your PC - Alfred never looks at your files.</div>
                  }
                  <label>Show the conversation in</label>
                  <div class="pills" role="radiogroup">
                    @for (o of openChoices; track o.value) {
                      <button type="button" class="pill" role="radio" [class.on]="openIn === o.value" [attr.aria-checked]="openIn === o.value" (click)="openIn = o.value">{{ o.label }}</button>
                    }
                  </div>
                  <p class="faint" style="margin-top:10px">Asked once and kept in My settings. Each board gets its own worktree there, so boards never mix their changes.</p>
                  <div class="acts">
                    <button type="button" class="action-btn" (click)="panel.set(false)">Cancel</button>
                    <button type="button" class="action-btn primary" [disabled]="!folder.trim()" (click)="saveFolderAndStart()">▶ Start Claude</button>
                  </div>
                </div>
              }
            }
          }
        </div>
      }
    </span>

    <ng-template #foot>
      <div class="pf">
        <button type="button" (click)="openAudit()">☰ Who did what</button>
        @if (session(); as s) { <button type="button" (click)="copy(s.cliSessionId)">{{ copied() === s.cliSessionId ? '✓ Copied' : '⧉ Copy session id' }}</button> }
        <a routerLink="/me">⚙ My settings</a>
      </div>
    </ng-template>

    @switch (dialog()) {
      @case ('pair') {
        <div class="shade" data-keep-menu><div class="dlg" role="dialog">
          <h3>Connect this PC to use your Claude</h3>
          <div class="sub">Claude for this board runs on this PC, with the Claude account you are signed in with here - not on {{ host }}.
            Once per PC; then ▶ Start Claude starts it at once.</div>
          <app-connect-pc />
          <div class="foot"><button type="button" class="action-btn" (click)="cancelStart()">Cancel</button></div>
        </div></div>
      }
      @case ('helper') {
        <div class="shade" data-keep-menu><div class="dlg" role="dialog">
          <h3>Your Alfred helper is not running</h3>
          <div class="sub">Starting Claude needs it: Claude runs on your PC, not on {{ host }}.</div>
          <div class="sec">
            <label class="opt"><input type="radio" name="h" [checked]="helperChoice() === 'start'" (change)="helperChoice.set('start')"><span><b>Start it now</b>
              <small class="muted">Opens <code>alfred-helper://connect?server={{ server }}</code>. Installed once with <code>alfred helper install</code>.</small></span></label>
            @for (h of otherOnline(); track h.keyId) {
              <label class="opt"><input type="radio" name="h" [checked]="helperChoice() === h.keyId" (change)="helperChoice.set(h.keyId)"><span><b>Run it on {{ h.machine }}</b><small class="muted">online</small></span></label>
            }
          </div>
          <div class="sec"><b>Not set up on this PC, or it does not start?</b> Connect it again - nothing is lost.<app-connect-pc /></div>
          <div class="foot"><button type="button" class="action-btn" (click)="cancelStart()">Cancel</button>
            <button type="button" class="action-btn primary" (click)="helperGo()">{{ helperChoice() === 'start' ? 'Start helper' : 'Start there' }}</button></div>
        </div></div>
      }
      @case ('held') {
        <div class="shade" data-keep-menu><div class="dlg" role="dialog">
          <h3>🔒 {{ held()!.user }} holds this board</h3>
          <div class="sub">Their Claude answers it@if (held()!.machine) { on {{ held()!.machine }} } since {{ held()!.since | date:'short' }}.
            You can read the board; writing waits until they hand it over. Ask them to hand it over:</div>
          @if (held()!.request; as r) {
            <div class="sec">Asked by {{ r.user }} {{ r.at | date:'short' }}@if (r.note) { - "{{ r.note }}" }</div>
          }
          @if (paired()) {
            <div class="sec">A note for {{ shortUser(held()!.user) }} (optional)<textarea rows="2" [(ngModel)]="note" maxlength="500"></textarea></div>
          } @else {
            <div class="sec">Connect this PC (My settings) to ask for the board.</div>
          }
          <div class="foot">
            @if (admin()) { <button type="button" class="action-btn danger" (click)="forceRelease()">Force release (admin)</button> }
            <button type="button" class="action-btn" (click)="dialog.set(null)">Close</button>
            @if (paired()) { <button type="button" class="action-btn primary" (click)="ask()">Ask them to hand it over</button> }
          </div>
        </div></div>
      }
      @case ('request') {
        <div class="shade" data-keep-menu><div class="dlg" role="dialog">
          <h3>{{ myHolder()!.request!.user }} asks for this board</h3>
          @if (myHolder()!.request!.note) { <div class="sub">"{{ myHolder()!.request!.note }}"</div> }
          <div class="sec">
            <label class="opt"><input type="radio" name="q" [checked]="answer() === 'HAND_OVER'" (change)="answer.set('HAND_OVER')"><span><b>Hand it over</b>
              <small class="muted">Your Claude stops answering; your session is kept. Waiting messages go to their Claude.</small></span></label>
            <label class="opt"><input type="radio" name="q" [checked]="answer() === 'RELEASE'" (change)="answer.set('RELEASE')"><span><b>Hand it back - anyone may take it</b></span></label>
            <label class="opt"><input type="radio" name="q" [checked]="answer() === 'KEEP'" (change)="answer.set('KEEP')"><span><b>Keep it</b>
              <small class="muted">They see that you kept it.</small></span></label>
          </div>
          <div class="foot"><button type="button" class="action-btn" (click)="later()">Later</button>
            <button type="button" class="action-btn primary" (click)="sendAnswer()">Confirm</button></div>
        </div></div>
      }
      @case ('notHere') {
        <div class="shade" data-keep-menu><div class="dlg" role="dialog">
          <h3>Claude for this board runs on {{ session()?.machine ?? 'another PC' }}</h3>
          <div class="sub">Its session is not on this PC (or not under this Windows user). Continue it where it is, or here:</div>
          @if (session(); as s) {
            <div class="sec kv">
              <span>Session</span><span><code>{{ s.cliSessionId }}</code></span>
              <span>PC</span><span>{{ s.machine }}@if (target()) { (this is {{ target()!.machine }}) }</span>
              <span>Account</span><span>{{ s.user }}</span>
              <span>Last active</span><span>{{ s.lastActive | date:'short' }}</span>
            </div>
          }
          <div class="sec">
            <label class="opt"><input type="radio" name="r" [checked]="notHere() === 'copy'" (change)="notHere.set('copy')"><span><b>Continue here from Alfred's copy</b>
              <small class="muted">A new session on this PC, started from the board's chat summary, decisions and brief. It becomes this board's Claude.</small></span></label>
            @if (sessionHelperOnline()) {
              <label class="opt"><input type="radio" name="r" [checked]="notHere() === 'there'" (change)="notHere.set('there')"><span><b>Resume it on {{ session()!.machine }}</b>
                <small class="muted">That PC is connected - Claude continues there, exactly as it was.</small></span></label>
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
      @case ('handback') {
        <div class="shade" data-keep-menu><div class="dlg" role="dialog" aria-label="Hand the board back">
          <h3>Hand {{ ref() || 'this board' }} back?</h3>
          <div class="sub">Use this when you are done for now, or someone else should continue.</div>
          <div class="sec"><ul>
            <li>Claude stops answering@if (session(); as s) { on {{ s.machine }} }.</li>
            <li>Your session is kept - you can resume it later.</li>
            <li>Anyone may take the board.</li>
          </ul></div>
          @if (canNote()) {
            <div class="sec"><label class="opt"><input type="checkbox" [checked]="leaveNote()" (change)="leaveNote.set(!leaveNote())"><span><b>Leave a note for whoever continues</b>
              <small class="muted">Claude writes where things stand and the next step as a Handover note card before it stops.</small></span></label></div>
          }
          <div class="foot"><button type="button" class="action-btn" (click)="dialog.set(null)">Cancel</button>
            <button type="button" class="action-btn primary" (click)="handBack()">↩ Hand back</button></div>
        </div></div>
      }
      @case ('sessions') {
        <div class="shade" data-keep-menu><div class="dlg" role="dialog">
          <h3>Earlier sessions of this board</h3>
          <div class="sec"><table>
            <tr><th>Session</th><th>Where</th><th>State</th><th></th></tr>
            @for (o of all(); track o.id) {
              <tr><td><code>{{ o.cliSessionId.slice(0, 8) }}</code>@if (o.current) { <b> current</b> }</td><td>{{ o.machine }}</td><td>{{ stateText(o) }}</td>
                <td>@if (!o.current) { <button type="button" class="action-btn" (click)="switchTo(o)">Continue this one</button> }</td></tr>
            }
          </table></div>
          <div class="foot"><button type="button" class="action-btn" (click)="dialog.set(null)">Close</button></div>
        </div></div>
      }
      @case ('listen') {
        <div class="shade" data-keep-menu><div class="dlg" role="dialog">
          <h3>👂 Watch a recording</h3>
          <div class="sub">Claude checks every new call of the recording while you test - on {{ session()?.machine }}, in short copies of this board's session, so it never types into your conversation. What it finds lands on the board.</div>
          <div class="sec"><select [(ngModel)]="listenCycle">@for (c of cycles(); track c.id) { <option [value]="c.id">{{ c.name }}</option> }</select></div>
          <div class="foot"><button type="button" class="action-btn" (click)="dialog.set(null)">Cancel</button>
            <button type="button" class="action-btn primary" (click)="startListen()">Start watching</button></div>
        </div></div>
      }
      @case ('audit') {
        <div class="shade" data-keep-menu><div class="dlg" role="dialog">
          <h3>Who did what</h3>
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
  /** What makes the board's session answer again: /alfred-live run in it (2026-10-19). */
  readonly listenCmd = computed(() => `/alfred-live ${this.project()} ${this.boardId()}`);
  readonly title = input<string | null>(null);
  /** How the board is named in commands and dialogs ("AB#59851"). */
  readonly ref = input<string | null>(null);
  /** The board's cycles, to watch one. */
  readonly cycles = input<readonly { id: string; name: string }[]>([]);
  /** A terminal /alfred-live answers the board (no helper session of this user). */
  readonly terminalOn = input(false);
  /** Chat messages waiting for Claude, and the chat's last message id - Resume catches up on them. */
  readonly unread = input(0);
  readonly chatSeq = input<number | null>(null);
  readonly listening = signal<string | null>(null);
  listenCycle = '';

  readonly state = inject(SessionsStateService);
  private readonly api = inject(SessionsApiService);
  private readonly config = inject(AppConfigService);
  private readonly banner = inject(BoardBannerService);

  readonly panel = signal(false);
  readonly dialog = signal<Dialog>(null);
  readonly helperChoice = signal<string>('start');
  readonly answer = signal<'HAND_OVER' | 'RELEASE' | 'KEEP'>('HAND_OVER');
  readonly notHere = signal<'copy' | 'there' | 'other' | 'id'>('copy');
  readonly audit = signal<readonly AuditLine[]>([]);
  readonly leaveNote = signal(true);
  readonly copied = signal<string | null>(null);
  private readonly dismissed = signal<string | null>(null);
  note = '';
  pickId = '';
  enteredId = '';
  folder = '';
  openIn: ProjectPlace['openIn'] = 'DESKTOP';
  readonly openChoices: readonly { value: ProjectPlace['openIn']; label: string }[] = [
    { value: 'DESKTOP', label: 'Claude Desktop' }, { value: 'TERMINAL', label: 'Terminal' }, { value: 'BOTH', label: 'Both' },
    { value: 'BACKGROUND', label: 'Nowhere - board only' }];
  private laterFor: string | null = null;
  readonly picking = signal(false);
  /** Start was pressed before this PC was connected; it continues once it is. */
  private startWaiting = false;
  /** The step to run once Claude is on (the Next card's). */
  private thenRun: ThenRun | null = null;
  private pauseTimer: ReturnType<typeof setTimeout> | null = null;
  readonly shortUser = shortUser;

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
  readonly mine = computed(() => !!this.session() && this.session()!.user === this.state.user());
  readonly otherOnline = computed(() => this.state.onlineHelpers().filter((h) => h.keyId !== this.state.me()?.helperKeyId));
  readonly sessionHelperOnline = computed(() => {
    const s = this.session();
    return !!s && this.state.onlineHelpers().some((h) => h.keyId === s.helperKeyId);
  });
  readonly view = computed(() => this.state.claude(this.boardId(), this.terminalOn(), this.dismissed()));
  readonly panelView = computed<'on' | 'paused' | 'failed' | 'terminal' | 'start'>(() => {
    const v = this.view();
    if (v.mode === 'failed') return 'failed';
    if (v.mode === 'terminal') return 'terminal';
    if (v.mode === 'paused' && this.session()) return 'paused';
    if ((v.mode === 'on' || v.mode === 'busy') && this.session() && this.mine()) return 'on';
    return 'start';
  });
  readonly kindClass = computed(() => ({ start: 'k-start', paused: 'k-paused', busy: 'k-wait', on: 'k-on', terminal: 'k-on', failed: 'k-bad',
    held: 'k-held', elsewhere: 'k-paused' })[this.view().mode]);
  readonly failure = computed(() => (this.view().command ? failureLine(this.view().command!.result) : null));
  readonly place = computed(() => this.placeHere());
  readonly account = computed(() => {
    const s = this.session();
    const h = this.state.helpers().find((x) => x.keyId === s?.helperKeyId) ?? null;
    return this.state.helperInfo(h).claudeAccount || h?.claudeAccount || s?.user || '';
  });
  readonly budget = computed(() => this.state.settings().budget?.dailyTokens ?? null);
  readonly meter = computed(() => Math.min(100, Math.round(((this.session()?.tokensToday ?? 0) / (this.budget() || 1)) * 100)));
  /** A note needs Claude: only while the session's PC is connected. */
  readonly canNote = computed(() => !!this.session() && this.mine() && this.sessionHelperOnline());

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
    // Start waited for this PC to be connected (or its helper to come online): it goes on by itself
    effect(() => {
      const ready = this.paired() && !!this.target();
      untracked(() => {
        if (ready && this.startWaiting && (this.dialog() === 'pair' || this.dialog() === 'helper')) {
          this.dialog.set(null);
          this.start();
        }
      });
    });
    const sub = this.state.finished$.subscribe((c) => {
      if (c.boardId !== this.boardId() && !(c.kind === 'PICK_FOLDER' && this.panel())) return;
      this.onFinished(c);
    });
    const destroy = inject(DestroyRef);
    destroy.onDestroy(() => { sub.unsubscribe(); if (this.pauseTimer) clearTimeout(this.pauseTimer); });
  }

  stateText(s: BoardSessionRow): string {
    return ({ ANSWERING: 'answering', IDLE: 'paused', STOPPED: 'paused', STARTING: 'starting', WAITING_BUDGET: 'budget reached',
      WAITING_LIMIT: 'usage limit', GONE: 'transcript gone' } as Record<string, string>)[s.state] ?? s.state.toLowerCase();
  }

  /** ▶ Start Claude: at once when this PC knows the folder, else the panel asks for it first. */
  startOrPanel(): void {
    if (this.paired() && this.target() && !this.placeHere()) { this.panel.set(true); return; }
    this.start();
  }

  /** The Next card's step, when Claude is not on yet: resume or start it, and the step follows. */
  runAfterStart(then: ThenRun): void {
    this.thenRun = then;
    const v = this.view();
    if (v.mode === 'paused') { this.resume(); return; }
    if (v.mode === 'held') { this.dialog.set('held'); return; }
    if (v.mode === 'elsewhere') { this.dialog.set('notHere'); return; }
    this.startOrPanel();
  }

  start(): void {
    if (!this.paired()) { this.startWaiting = true; this.panel.set(false); this.dialog.set('pair'); return; }
    if (!this.target()) { this.startWaiting = true; this.panel.set(false); this.dialog.set('helper'); return; }
    this.startWaiting = false;
    // no folder for this project on that PC yet: the panel asks here first, saying why - never a folder window out of nowhere
    if (!this.placeHere()) {
      this.folder = '';
      this.picking.set(false);
      this.panel.set(true);
      return;
    }
    this.panel.set(false);
    const thenRun = this.takeThenRun();
    this.send('START', { args: { title: this.title() ?? this.boardId(), boardRef: this.ref() ?? this.boardId(), ...(thenRun ? { thenRun } : {}) } });
  }

  resume(): void {
    const s = this.session();
    if (!s) { this.start(); return; }
    this.panel.set(false);
    const thenRun = this.takeThenRun();
    this.send('RESUME', { sessionId: s.id, helperKeyId: s.helperKeyId, args: { cliSessionId: s.cliSessionId, boardRef: this.ref() ?? this.boardId(),
      unread: this.unread(), ...(this.chatSeq() != null ? { chatSeq: this.chatSeq() } : {}), ...(thenRun ? { thenRun } : {}) } });
  }

  private takeThenRun(): ThenRun | null {
    const t = this.thenRun;
    this.thenRun = null;
    return t;
  }

  cancelStart(): void {
    this.startWaiting = false;
    this.thenRun = null;
    this.dialog.set(null);
  }

  /** This PC's folder row, the way the helper picks it: this PC and Windows user, then this PC, then any PC. */
  private placeHere(): ProjectPlace | null {
    const machine = this.target()?.machine?.toLowerCase();
    const os = (this.target()?.osUser ?? '').toLowerCase();
    const rows = (this.state.settings().projects ?? []).filter((p) => p.project === this.project());
    const here = rows.filter((p) => p.machine?.toLowerCase() === machine);
    return (os ? here.find((p) => p.osUser?.toLowerCase() === os) : undefined) ?? here.find((p) => !p.osUser)
      ?? rows.find((p) => !p.machine) ?? null;
  }

  restartDesktop(): void {
    if (!window.confirm('Restart Claude Desktop on your PC? Its open windows close and come back; a reply being written there stops.')) return;
    this.cmd('RESTART_DESKTOP');
  }

  cmd(kind: 'OPEN_DESKTOP' | 'OPEN_TERMINAL' | 'RESTART_DESKTOP'): void {
    this.panel.set(false);
    const s = this.session();
    if (!s) return;
    this.send(kind, { sessionId: s.id, helperKeyId: s.helperKeyId, args: { cliSessionId: s.cliSessionId, boardRef: this.ref() ?? this.boardId() } });
  }

  /** ⏸ Pause Claude: STOP - the session is kept and Resume continues it. Every outcome is said (specs/032 D5/D6). */
  pause(): void {
    const s = this.session();
    this.panel.set(false);
    if (!s) return;
    const online = this.sessionHelperOnline();
    this.send('STOP', { sessionId: s.id, helperKeyId: s.helperKeyId, args: { cliSessionId: s.cliSessionId, boardRef: this.ref() ?? this.boardId() } }, (c) => {
      if (!online) { this.pauseOffline(s.machine); return; }
      if (this.pauseTimer) clearTimeout(this.pauseTimer);
      this.pauseTimer = setTimeout(() => {
        if (this.state.commands().find((x) => x.id === c.id && (x.state === 'QUEUED' || x.state === 'TAKEN'))) {
          this.banner.show({ boardId: this.boardId(), key: 'pause', tone: 'info', text: 'Waiting for your PC to pause Claude',
            detail: 'It finishes the answer it is writing first.', dismissable: false });
        }
      }, PAUSE_SLOW_MS);
    });
  }

  private pauseOffline(machine: string): void {
    this.banner.show({ boardId: this.boardId(), key: 'pause', tone: 'error', text: "Couldn't pause Claude",
      detail: `Your PC (${machine}) is not connected. It pauses as soon as the PC reconnects - or hand the board back instead.`,
      action: 'Hand back instead', onAction: () => this.askHandBack() });
  }

  askHandBack(): void {
    this.panel.set(false);
    this.leaveNote.set(true);
    this.dialog.set('handback');
  }

  /** ↩ Hand back: RELEASE through the PC (note, stop, release) - or straight to Alfred when the PC is offline. */
  handBack(): void {
    this.dialog.set(null);
    const s = this.session();
    if (s && this.mine() && this.sessionHelperOnline()) {
      this.send('RELEASE', { sessionId: s.id, helperKeyId: s.helperKeyId, args: { cliSessionId: s.cliSessionId, boardRef: this.ref() ?? this.boardId(),
        note: this.leaveNote() } });
      return;
    }
    this.api.release(this.boardId()).subscribe({
      next: () => this.handedBack(s && this.mine() ? 'Handed back without a note - your PC is offline' : null, false),
      error: (e) => this.banner.show({ boardId: this.boardId(), key: 'handback', tone: 'error', text: "Couldn't hand the board back",
        detail: e?.error?.message ?? 'Alfred did not answer' }),
    });
  }

  private handedBack(detail: string | null, note: boolean): void {
    const s = this.session();
    this.banner.show({ boardId: this.boardId(), key: 'handback', tone: 'ok', text: 'You handed the board back',
      detail: detail ?? `Claude stopped answering; your session is kept${note ? ' (and it left a Handover note)' : ''}. Anyone may take the board now.`,
      action: 'Take it again', onAction: () => this.takeAgain(s?.cliSessionId ?? null) });
  }

  takeAgain(sessionId: string | null): void {
    this.api.take(this.boardId(), this.project(), sessionId).subscribe({
      next: () => this.banner.clear('handback'),
      error: (e) => this.banner.show({ boardId: this.boardId(), key: 'handback', tone: 'error', text: "Couldn't take the board", detail: e?.error?.message ?? null }),
    });
  }

  dismissFailure(): void {
    this.dismissed.set(this.view().command?.id ?? null);
    this.panel.set(false);
  }

  /** ↻ Try again: the same command with the same arguments. */
  tryAgain(): void {
    const c = this.view().command;
    this.panel.set(false);
    if (!c) return;
    this.dismissed.set(c.id);
    let args: object = {};
    try { args = JSON.parse(c.args || '{}') as object; } catch { /* sent without arguments */ }
    this.send(c.kind, { sessionId: c.sessionId, helperKeyId: c.helperKeyId, args });
  }

  copy(text: string): void {
    void copyToClipboard(text);
    this.copied.set(text);
    setTimeout(() => this.copied.set(null), 1500);
  }

  ask(): void {
    this.api.ask(this.boardId(), this.note.trim()).subscribe({
      next: (h) => {
        this.dialog.set(null);
        this.banner.show({ boardId: this.boardId(), tone: 'ok', text: h.user === this.state.user() ? 'The board is yours now' : `Asked ${h.user} to hand it over` });
      },
      error: (e) => this.banner.show({ boardId: this.boardId(), tone: 'error', text: 'Could not ask for the board', detail: e?.error?.message ?? null }),
    });
  }

  forceRelease(): void {
    this.api.forceRelease(this.boardId()).subscribe({ next: () => this.dialog.set(null),
      error: (e) => this.banner.show({ boardId: this.boardId(), tone: 'error', text: 'Refused', detail: e?.error?.message ?? null }) });
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
    this.send('LISTEN', { sessionId: s.id, helperKeyId: s.helperKeyId, args: { cliSessionId: s.cliSessionId, cycleId: cycle, cycleName: name } },
      () => this.listening.set(cycle));
  }

  stopListen(): void {
    const s = this.session();
    this.panel.set(false);
    if (!s) return;
    this.send('STOP_LISTEN', { sessionId: s.id, helperKeyId: s.helperKeyId, args: { cliSessionId: s.cliSessionId, cycleId: this.listening() } },
      () => this.listening.set(null));
  }

  sendAnswer(): void {
    const answer = this.answer();
    const s = this.session();
    // hand over through the session when it can still write its handover note (its helper is online)
    if (answer === 'HAND_OVER' && s && this.mine() && this.sessionHelperOnline()) {
      this.dialog.set(null);
      this.send('HANDOVER', { sessionId: s.id, helperKeyId: s.helperKeyId, args: { cliSessionId: s.cliSessionId, to: this.myHolder()?.request?.user, boardRef: this.boardId() } });
      return;
    }
    this.api.answer(this.boardId(), answer).subscribe({
      next: () => {
        this.dialog.set(null);
        if (answer === 'HAND_OVER' && s) this.send('STOP', { sessionId: s.id, helperKeyId: s.helperKeyId, args: { cliSessionId: s.cliSessionId } });
      },
      error: (e) => this.banner.show({ boardId: this.boardId(), tone: 'error', text: 'Could not answer', detail: e?.error?.message ?? null }),
    });
  }

  helperGo(): void {
    const choice = this.helperChoice();
    this.dialog.set(null);
    if (choice === 'start') {
      window.location.href = `alfred-helper://connect?server=${encodeURIComponent(this.server)}`;
      return;
    }
    const thenRun = this.takeThenRun();
    this.send('START', { helperKeyId: choice, args: { title: this.title() ?? this.boardId(), ...(thenRun ? { thenRun } : {}) } });
  }

  notHereGo(): void {
    const s = this.session();
    this.dialog.set(null);
    switch (this.notHere()) {
      case 'copy':
        this.send('CONTINUE_FROM_COPY', { args: { title: this.title() ?? this.boardId(), boardRef: this.ref() ?? this.boardId() } });
        break;
      case 'there':
        if (s) this.send('RESUME', { sessionId: s.id, helperKeyId: s.helperKeyId, args: { cliSessionId: s.cliSessionId } });
        break;
      case 'other': {
        const o = this.others().find((x) => x.id === this.pickId) ?? this.others()[0];
        if (o) this.send('RESUME', { sessionId: o.id, helperKeyId: o.helperKeyId, args: { cliSessionId: o.cliSessionId } });
        break;
      }
      case 'id': {
        const id = (this.enteredId.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i) ?? [])[0];
        if (!id) { this.banner.show({ boardId: this.boardId(), tone: 'error', text: 'That is not a Claude session id' }); return; }
        this.send('ATTACH', { args: { cliSessionId: id, title: this.title() ?? this.boardId() } });
        break;
      }
    }
  }

  pickFolder(): void {
    this.picking.set(true);
    this.state.send('PICK_FOLDER', { project: this.project() }).subscribe((c) => {
      if (!c) { this.picking.set(false); this.banner.show({ boardId: this.boardId(), tone: 'error', text: 'Could not reach your PC' }); }
    });
  }

  saveFolderAndStart(): void {
    const machine = this.target()?.machine ?? '';
    const osUser = this.target()?.osUser || undefined;
    const s: MySettings = this.state.settings();
    const rest = (s.projects ?? []).filter((p) => !(p.project === this.project() && p.machine === machine && (p.osUser || undefined) === osUser));
    const place: ProjectPlace = { project: this.project(), machine, osUser, folder: this.folder.trim(), openIn: this.openIn, worktrees: true };
    this.state.saveSettings({ ...s, projects: [...rest, place] }).subscribe((saved) => {
      if (!saved) { this.banner.show({ boardId: this.boardId(), tone: 'error', text: 'Could not save My settings' }); return; }
      this.start();
    });
  }

  switchTo(o: BoardSessionRow): void {
    this.dialog.set(null);
    this.send('RESUME', { sessionId: o.id, helperKeyId: o.helperKeyId, args: { cliSessionId: o.cliSessionId, makeCurrent: true } });
  }

  openAudit(): void {
    this.panel.set(false);
    this.api.audit(this.boardId()).subscribe({ next: (a) => { this.audit.set(a); this.dialog.set('audit'); }, error: () => undefined });
  }

  /** Sends a command for this board; a refusal is said in the banner, never dropped. */
  private send(kind: CommandKind, o: { sessionId?: string | null; helperKeyId?: string | null; args?: object }, then?: (c: HelperCommand) => void): void {
    this.state.send(kind, { boardId: this.boardId(), project: this.project(), ...o }).subscribe((c) => {
      if (!c) { this.banner.show({ boardId: this.boardId(), tone: 'error', text: 'Could not send it to your PC', detail: 'Alfred did not take the command - try again.' }); return; }
      then?.(c);
    });
  }

  private onFinished(c: HelperCommand): void {
    const r = c.result ?? '';
    if (c.kind === 'PICK_FOLDER') {
      this.picking.set(false);
      if (c.state === 'DONE' && r) this.folder = r;
      return;
    }
    if (c.state === 'FAILED' && r.startsWith('NO_FOLDER')) { this.folder = ''; this.panel.set(true); return; }
    if (c.state === 'FAILED' && r.startsWith('NOT_HERE')) { this.dialog.set('notHere'); return; }
    switch (c.kind) {
      case 'STOP':
        if (this.pauseTimer) { clearTimeout(this.pauseTimer); this.pauseTimer = null; }
        if (c.state === 'DONE') {
          this.banner.show({ boardId: this.boardId(), key: 'pause', tone: 'ok', text: 'Claude is paused',
            detail: 'Messages you send now wait. ▶ Resume continues the same conversation.', action: 'Resume now', onAction: () => this.resume() });
        } else {
          this.banner.show({ boardId: this.boardId(), key: 'pause', tone: 'error', text: "Couldn't pause Claude", detail: failureLine(r).text,
            action: 'Try again', onAction: () => this.pause() });
        }
        return;
      case 'RELEASE':
        if (c.state === 'DONE') this.handedBack(null, !/no note/.test(r) && /note/i.test(r));
        else this.banner.show({ boardId: this.boardId(), key: 'handback', tone: 'error', text: "Couldn't hand the board back", detail: failureLine(r).text });
        return;
      case 'START':
      case 'RESUME':
      case 'CONTINUE_FROM_COPY':
      case 'ATTACH':
        if (c.state === 'DONE') this.banner.show({ boardId: this.boardId(), key: 'claude', tone: 'ok', text: 'Claude is on', detail: r || null,
          ...(needsDesktopRestart(r) ? { action: 'Restart Desktop', onAction: () => this.restartDesktop() } : {}) });
        return; // a failure shows on the button ("⚠ Claude didn't start") with its panel
      case 'OPEN_DESKTOP':
        if (c.state === 'DONE' && needsDesktopRestart(r)) {
          this.banner.show({ boardId: this.boardId(), key: 'desktop', tone: 'info', text: 'Claude Desktop has not loaded this session yet',
            detail: 'Desktop reads new sessions only when it starts. Restart it and the session opens there.', action: 'Restart Desktop', onAction: () => this.restartDesktop() });
        } else if (c.state === 'FAILED') {
          this.banner.show({ boardId: this.boardId(), tone: 'error', text: 'Could not open it in Claude Desktop', detail: failureLine(r).text });
        }
        return;
      default:
        if (c.state === 'FAILED') this.banner.show({ boardId: this.boardId(), tone: 'error', text: 'Your PC could not do it', detail: failureLine(r).text });
    }
  }
}
