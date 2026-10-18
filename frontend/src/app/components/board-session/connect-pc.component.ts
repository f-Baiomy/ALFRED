import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { SessionsStateService } from '../../core/state/sessions-state.service';

/**
 * "Connect this PC" (specs/031): one download and one double-click. The file installs the Alfred helper on this PC (with
 * Node when it has none), registers it as the Claude account this PC is signed in with, pairs THIS browser, installs the
 * /alfred-* skills and Alfred's MCP server, and keeps them current. Shared by ▶ alfred-live and 👤 Me - one panel.
 * A browser on a PC that is already connected can still pair with the six-digit code (`alfred helper pair`).
 */
@Component({
  selector: 'app-connect-pc',
  standalone: true,
  imports: [FormsModule],
  styles: [`
    :host { display: block; }
    .steps { margin: .6rem 0; padding-left: 1.2rem; line-height: 1.6; }
    .wait { display: flex; gap: .6rem; align-items: center; padding: .6rem .75rem; border: 1px solid var(--border); border-radius: 6px;
      background: var(--card-inner); margin: .6rem 0; }
    .spin { width: 14px; height: 14px; border-radius: 50%; border: 2px solid var(--border); border-top-color: var(--accent-blue, #5b8def);
      animation: spin 1s linear infinite; flex: none; }
    @keyframes spin { to { transform: rotate(360deg); } }
    .row { display: flex; gap: .5rem; flex-wrap: wrap; align-items: center; margin-top: .5rem; }
    .muted { color: var(--text-dim); font-size: .85rem; }
    .bad { color: #f85149; font-size: .85rem; }
    .code input { width: 8rem; letter-spacing: .2em; text-align: center; }
    .link { background: none; border: 0; color: var(--accent-blue, #5b8def); cursor: pointer; padding: 0; font: inherit; font-size: .85rem; }
  `],
  template: `
    @if (state.connecting(); as c) {
      <div class="wait"><span class="spin"></span>
        <div><b>{{ c.run }}</b><div class="muted">This page continues by itself once your PC is connected.</div></div></div>
      <div class="row">
        <button type="button" class="action-btn" (click)="state.downloadAgain()">Download again</button>
        <button type="button" class="action-btn" (click)="state.cancelConnect()">Cancel</button>
      </div>
      <p class="muted">Windows may ask before running a downloaded file: choose <i>More info ▸ Run anyway</i>. The file only talks to
        this Alfred.</p>
    } @else {
      <ol class="steps">
        <li>Download the connect file.</li>
        <li>Run it once (double-click). It sets everything up and comes back here.</li>
      </ol>
      <div class="row">
        <button type="button" class="action-btn primary" [disabled]="busy()" (click)="connect()">⬇ Connect this PC</button>
        @if (failed()) { <span class="bad">Alfred did not give a connect file - try again</span> }
      </div>
      <p class="muted">Claude Code must be installed and signed in on this PC; your Claude account is who you are in Alfred.
        Nothing else to install or update - the skills and Alfred's MCP server come with it and stay current.</p>
      @if (!showCode()) {
        <button type="button" class="link" (click)="showCode.set(true)">This PC is already connected - pair with a code instead</button>
      } @else {
        <div class="row code">
          <span class="muted">Run <code>alfred helper pair</code> on the connected PC:</span>
          <input type="text" inputmode="numeric" maxlength="7" [(ngModel)]="code" placeholder="482 917" aria-label="Pairing code">
          <button type="button" class="action-btn" [disabled]="code.replace(' ', '').length !== 6" (click)="pair()">Pair</button>
          @if (pairFailed()) { <span class="bad">That code is wrong, used or expired</span> }
        </div>
      }
    }
  `,
})
export class ConnectPcComponent {
  readonly state = inject(SessionsStateService);
  readonly busy = signal(false);
  readonly failed = signal(false);
  readonly showCode = signal(false);
  readonly pairFailed = signal(false);
  code = '';

  connect(): void {
    this.busy.set(true);
    this.failed.set(false);
    this.state.connect().subscribe((c) => {
      this.busy.set(false);
      if (!c) this.failed.set(true);
    });
  }

  pair(): void {
    this.pairFailed.set(false);
    this.state.pair(this.code).subscribe((ok) => { if (ok) this.code = ''; else this.pairFailed.set(true); });
  }
}
