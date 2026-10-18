import { Injectable, computed, inject, signal } from '@angular/core';
import { Observable, Subject, catchError, of, share, tap } from 'rxjs';
import { AppConfigService } from '../services/app-config.service';
import { SessionsApiService } from '../services/sessions-api.service';
import { readKey, saveKey } from '../services/alfred-key';
import { reconnectingSocket } from './reconnecting-socket';
import {
  BoardSessionRow, CommandKind, ConnectStart, HelperCommand, HelperInfo, HelperRow, Holder, Me, MySettings, SessionsEvent,
} from '../models/sessions.models';

/**
 * Who this browser is, who holds which board, the boards' Claude sessions and the commands sent to the user's PCs
 * (specs/031). Fetched on demand and again on each /ws/sessions signal - no polling.
 */
@Injectable({ providedIn: 'root' })
export class SessionsStateService {
  private readonly api = inject(SessionsApiService);
  private readonly config = inject(AppConfigService);

  readonly me = signal<Me | null>(null);
  readonly helpers = signal<readonly HelperRow[]>([]);
  readonly settings = signal<MySettings>({});
  readonly holders = signal<readonly Holder[]>([]);
  readonly sessions = signal<readonly BoardSessionRow[]>([]);
  readonly commands = signal<readonly HelperCommand[]>([]);
  /** A finished command the page should say something about (its result or why it failed). */
  readonly finished$ = new Subject<HelperCommand>();
  private readonly seenDone = new Set<string>();

  readonly paired = computed(() => !!this.me()?.user);
  /** A "Connect this PC" file this browser downloaded and waits for (kept for this tab across a reload). */
  readonly connecting = signal<ConnectStart | null>(readConnecting());
  readonly user = computed(() => this.me()?.user ?? null);
  readonly onlineHelpers = computed(() => this.helpers().filter((h) => h.online));
  /** The PC a command from this browser goes to: the helper it was paired with when online, else any online one. */
  readonly targetHelper = computed<HelperRow | null>(() => {
    const mine = this.me()?.helperKeyId;
    const online = this.onlineHelpers();
    return online.find((h) => h.keyId === mine) ?? online[0] ?? null;
  });

  readonly events$: Observable<SessionsEvent> = reconnectingSocket<SessionsEvent>(
    `${this.config.backendUrl.replace(/^http/, 'ws')}/ws/sessions`,
    () => this.reloadAll(),
  ).pipe(share());

  private started = false;

  /** Starts once: first reads, then the socket. */
  start(): void {
    if (this.started) return;
    this.started = true;
    try {
      this.reloadAll();
    } catch {
      return; // no HttpClient here (a component test): nothing to read, nothing to follow
    }
    // back from running the connect file: collect at once, in case the signal came while the socket was away
    window.addEventListener('focus', () => this.collect());
    this.events$.subscribe({
      next: (e) => {
        if (e.what === 'holders') this.loadHolders();
        else if (e.what === 'sessions') this.loadSessions();
        else if (e.what === 'commands') this.loadCommands();
        else if (e.what === 'keys') { this.loadMe(); this.loadHelpers(); }
        else if (e.what === 'connect') this.collect();
        else if (e.what === 'settings') this.loadSettings();
      },
      error: () => undefined,
    });
  }

  reloadAll(): void {
    this.collect();
    this.loadMe();
    this.loadHolders();
    this.loadSessions();
  }

  loadMe(): void {
    // the key this request is sent with: an answer to an older request (before pairing or connecting finished) must
    // neither overwrite who this browser is now nor drop the key it has just been given
    const sent = readKey();
    this.api.me().subscribe({
      next: (m) => {
        if (readKey() !== sent) return;
        this.me.set(m);
        if (m.user) {
          this.loadHelpers();
          this.loadSettings();
          this.loadCommands();
        } else if (readKey()) {
          saveKey(null); // the key was revoked or Alfred was reset: this browser is unpaired again
        }
      },
      error: () => { if (readKey() === sent) this.me.set(null); },
    });
  }

  loadHelpers(): void {
    if (!this.paired()) return;
    this.api.myHelpers().subscribe({ next: (h) => this.helpers.set(h), error: () => this.helpers.set([]) });
  }

  loadSettings(): void {
    if (!this.paired()) return;
    this.api.settings().subscribe({ next: (s) => this.settings.set(s ?? {}), error: () => undefined });
  }

  loadHolders(): void {
    this.api.holders('').subscribe({ next: (h) => this.holders.set(h), error: () => undefined });
  }

  loadSessions(): void {
    this.api.sessions('').subscribe({ next: (s) => this.sessions.set(s), error: () => undefined });
  }

  loadCommands(): void {
    if (!this.paired()) return;
    this.api.commands().subscribe({
      next: (cs) => {
        const first = this.commands().length === 0 && this.seenDone.size === 0;
        this.commands.set(cs);
        for (const c of cs) {
          if ((c.state === 'DONE' || c.state === 'FAILED') && !this.seenDone.has(c.id)) {
            this.seenDone.add(c.id);
            if (!first) this.finished$.next(c);
          }
        }
      },
      error: () => undefined,
    });
  }

  holderOf(boardId: string | null | undefined): Holder | null {
    return boardId ? this.holders().find((h) => h.boardId === boardId) ?? null : null;
  }

  /** Held by someone other than this browser's user (an unpaired browser: by anyone). */
  heldByOther(boardId: string | null | undefined): Holder | null {
    const h = this.holderOf(boardId);
    return h && h.user !== this.user() ? h : null;
  }

  heldByMe(boardId: string | null | undefined): boolean {
    const h = this.holderOf(boardId);
    return !!h && !!this.user() && h.user === this.user();
  }

  currentSession(boardId: string | null | undefined): BoardSessionRow | null {
    if (!boardId) return null;
    const all = this.sessions().filter((s) => s.boardId === boardId);
    return all.find((s) => s.current) ?? all[0] ?? null;
  }

  sessionsOf(boardId: string): readonly BoardSessionRow[] {
    return this.sessions().filter((s) => s.boardId === boardId);
  }

  pendingFor(boardId: string | null | undefined): HelperCommand | null {
    return this.commands().find((c) => c.boardId === boardId && (c.state === 'QUEUED' || c.state === 'TAKEN')) ?? null;
  }

  helperInfo(h: HelperRow | null): HelperInfo {
    try {
      return h?.info ? (JSON.parse(h.info) as HelperInfo) : {};
    } catch {
      return {};
    }
  }

  /** Sends a command to one of the user's PCs (the target helper unless named). */
  send(kind: CommandKind, o: { boardId?: string | null; project?: string; sessionId?: string | null; args?: object; helperKeyId?: string | null }): Observable<HelperCommand | null> {
    return this.api.command(kind, { ...o, helperKeyId: o.helperKeyId ?? this.targetHelper()?.keyId ?? null }).pipe(
      tap((c) => this.commands.set([c, ...this.commands()])),
      catchError(() => of(null)),
    );
  }

  /**
   * "Connect this PC": saves the file that installs the helper here and pairs this browser, and waits for it - the
   * /ws/sessions signal (or coming back to the tab) collects the key, never a poll.
   */
  connect(): Observable<ConnectStart | null> {
    const os = /Win/i.test(navigator.platform || navigator.userAgent) ? 'windows' : /Mac/i.test(navigator.platform || '') ? 'mac' : 'linux';
    return this.api.connect(this.config.backendUrl, os, browserLabel()).pipe(
      tap((c) => {
        this.connecting.set(c);
        keepConnecting(c);
        downloadText(c.fileName, c.script);
      }),
      catchError(() => of(null)),
    );
  }

  /** Downloads the same connect file again (it was not saved, or was deleted). */
  downloadAgain(): void {
    const c = this.connecting();
    if (c) downloadText(c.fileName, c.script);
  }

  cancelConnect(): void {
    this.connecting.set(null);
    keepConnecting(null);
  }

  /** Takes this browser's key once its PC has run the connect file; nothing while it has not. */
  collect(): void {
    const c = this.connecting();
    if (!c) return;
    if (Date.parse(c.expiresAt) < Date.now()) { this.cancelConnect(); return; }
    this.api.collect(c.connectId, c.collectSecret).subscribe({
      next: (r) => { saveKey(r.key); this.cancelConnect(); this.loadMe(); },
      error: () => undefined,
    });
  }

  pair(code: string): Observable<boolean> {
    return new Observable<boolean>((sub) => {
      this.api.pair(code.replace(/\s/g, ''), browserLabel()).subscribe({
        next: (r) => { saveKey(r.key); this.loadMe(); sub.next(true); sub.complete(); },
        error: () => { sub.next(false); sub.complete(); },
      });
    });
  }

  unpair(): void {
    const me = this.me();
    const done = () => { saveKey(null); this.me.set({ user: null, machine: null, kind: null, keyId: null, helperKeyId: null, admin: me?.admin ?? false }); };
    if (me?.keyId) this.api.revoke(me.keyId).subscribe({ next: done, error: done });
    else done();
  }

  saveSettings(s: MySettings): Observable<MySettings | null> {
    return this.api.saveSettings(s).pipe(tap((v) => this.settings.set(v)), catchError(() => of(null)));
  }
}

const CONNECTING = 'alfred.connecting';

function browserLabel(): string {
  const ua = navigator.userAgent;
  const name = ua.includes('Edg/') ? 'Edge' : ua.includes('Chrome') ? 'Chrome' : ua.includes('Firefox') ? 'Firefox' : 'Browser';
  return `${name} on ${navigator.platform || 'this PC'}`;
}

function readConnecting(): ConnectStart | null {
  try {
    const v = sessionStorage.getItem(CONNECTING);
    return v ? (JSON.parse(v) as ConnectStart) : null;
  } catch {
    return null;
  }
}

function keepConnecting(c: ConnectStart | null): void {
  try {
    if (c) sessionStorage.setItem(CONNECTING, JSON.stringify(c));
    else sessionStorage.removeItem(CONNECTING);
  } catch { /* storage blocked: the wait lasts as long as the page */ }
}

function downloadText(fileName: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/octet-stream' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}
