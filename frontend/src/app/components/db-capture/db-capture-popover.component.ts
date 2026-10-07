import { ChangeDetectionStrategy, Component, ElementRef, HostListener, OnInit, computed, inject, input, output, signal } from '@angular/core';
import { Router } from '@angular/router';
import { ATTACH_MODE_CHOICES, AttachMode, DbCaptureSettings, agentLacks } from '../../core/models/db-capture.model';
import { DbCaptureApiService } from '../../core/services/db-capture-api.service';
import { DbCaptureStateService } from '../../core/state/db-capture-state.service';
import { ServerSettingsService } from '../../core/services/server-settings.service';
import { AgentAttach } from '../../core/models/server-settings.model';
import { ATTACH_NOTES, attachFeatures } from '../../shared/utils/attach-features';
import { DbWindowService } from './db-window.service';
import { LogLevelSetting } from '../../core/models/call-logs.model';
import { SelectPickerComponent } from '../select-picker/select-picker.component';
import { LOG_LEVEL_CHOICES } from '../../shared/utils/call-log-rows';

/**
 * The ▾ panel next to a project's ◆ switch in the Sources bar (mock: ".db-pop"): the switch again, whether the
 * agent is attached and how it attaches itself (the attach mode, with the proxy feature and Attach now - the same
 * setting as Settings → Database capture), the before-image tables, rows kept per result and ▤ Log level, the
 * per-viewer "show the chip" choice, and the way to the full settings. Positioned under the button that opened it (fixed, so no ancestor clips it).
 */
@Component({
  standalone: true,
  selector: 'app-db-capture-popover',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [SelectPickerComponent],
  template: `
    <div class="db-pop" role="dialog" [attr.aria-label]="'Database capture for ' + project()" [style.top.px]="top()" [style.left.px]="left()">
      <h4>◆ Database capture · {{ project() }}
        <span class="cw-spacer"></span>
        <button type="button" class="cw-switch db" role="switch" [class.on]="enabled()" [class.blocked]="!inboundOn()"
                [attr.aria-checked]="enabled()" [attr.aria-label]="'Database capture for ' + project()"
                [title]="state.switchTitle(project(), inboundOn())" (click)="state.toggle(project(), inboundOn())"></button>
      </h4>
      <div class="pr"><span class="pl">Agent</span>
        <span>
          @if (status()?.attached) {
            <span class="agent-ok">● attached</span> <span class="dimtxt">{{ agentLine() }}</span>
          } @else {
            <span class="agent-no">● not attached</span>
            <button type="button" class="action-btn" (click)="showHow.set(!showHow())">How to attach</button>
          }
        </span>
      </div>
      @if (whyNotAttached(); as why) {
        <div class="db-how db-why" title="The supervisor's last attach attempt (Settings → Server has every project's)">Last attempt: {{ why }}</div>
      }
      @if (lacking().length) {
        <div class="db-how db-lacking">⚠ {{ lacking().join(' and ') }} capture is switched on, but the agent in {{ project() }}'s JVM was loaded
          without it - nothing is recorded until it is loaded: <code>python3 start.py --db-capture on</code> (Docker; the proxy-on step alone
          loads only the proxy), or Attach now below on a native install.</div>
      }
      @if (showHow() && !status()?.attached) {
        <div class="db-how">Run <code>python3 start.py --db-capture on</code> on the machine running {{ project() }} (WildFly found
          automatically), or start the JVM with <code>-javaagent:alfred-agent.jar=alfredUrl=…,project={{ project() }}</code>.
          See docs/db-capture.md.</div>
      }
      <!-- The same attach setting as Settings → Database capture → Agent (specs/012): the supervisor loads the agent into the app's JVM -->
      <div class="pr"><span class="pl">Attach</span>
        <span>
          <app-select-picker class="db-attach-mode" ariaLabel="Attach mode"
                             title="The supervisor finds the app (the JVM listening on this project's upstream port) and loads Alfred's agent into it. When asked: at start, when calls arrive and no agent reports, on Attach now. Automatic: also the moment the app's port opens or its pid changes."
                             [options]="attachModeChoices" [value]="attachMode()" (valueChange)="setAttachMode($event)" />
          <label class="chk" title="Also route the app's outbound calls through Alfred's forward proxy (the proxy feature)">
            <input type="checkbox" [checked]="settings()?.attachProxy !== false" [disabled]="attachMode() === 'OFF'" (change)="toggleAttachProxy()"> route outbound through Alfred</label>
          <button type="button" class="link-btn" [disabled]="attachMode() === 'OFF'" (click)="attachNow()" title="Ask the supervisor to attach now">Attach now</button>
          @if (attachNote(); as note) {
            <span class="dimtxt db-attach-note">{{ note }}</span>
          }
        </span>
      </div>
      <div class="pr"><span class="pl">Before-image</span>
        <span>
          @for (t of settings()?.beforeImageTables ?? []; track t) {
            <span class="tchip on">{{ t }} <a (click)="removeTable(t)" title="Stop reading rows before writes to this table">✕</a></span>
          } @empty {
            <span class="dimtxt">no tables</span>
          }
          @if (adding()) {
            <input class="mini wide" placeholder="table" (keydown.enter)="addTable($event)" (keydown.escape)="adding.set(false)" #t>
          } @else {
            <button type="button" class="action-btn" (click)="adding.set(true)">+ Add table</button>
          }
        </span>
      </div>
      <div class="pr"><span class="pl">Rows per result</span>
        <span><input class="mini" type="number" min="1" [value]="settings()?.rowsPerResult ?? 50000" (change)="setRows($event)"> <span class="dimtxt">then count only</span></span>
      </div>
      <div class="pr" [class.dim]="!logsOn()"><span class="pl">▤ Log lines</span>
        <span [title]="logsOn() ? 'The lowest level of log line the agent catches with each call' : 'Turn ▤ on to catch log lines'">
          <app-select-picker class="db-level" ariaLabel="Log level" [options]="levelChoices" [value]="level()" (valueChange)="setLevel($event)" />
          <span class="dimtxt"> caught with each call while ▤ is on</span></span>
      </div>
      <div class="pr"><span class="pl">This page</span>
        <span><label class="chk"><input type="checkbox" [checked]="state.showChips()" (change)="state.setShowChips(!state.showChips())"> Show the ◆ DB chip on calls</label></span>
      </div>
      @if (error()) {
        <div class="db-pop-err">{{ error() }}</div>
      }
      <div class="foot">
        <span class="dimtxt">Applies to every page and user, live.</span>
        <span class="cw-spacer"></span>
        <a class="lnk" (click)="openOutside()">Outside calls</a>
        <a class="lnk" (click)="allSettings()">All database settings →</a>
      </div>
    </div>
  `,
})
export class DbCapturePopoverComponent implements OnInit {
  private readonly api = inject(DbCaptureApiService);
  private readonly router = inject(Router);
  private readonly window = inject(DbWindowService);
  private readonly server = inject(ServerSettingsService);
  private readonly host = inject(ElementRef<HTMLElement>);
  protected readonly state = inject(DbCaptureStateService);

  readonly project = input.required<string>();
  readonly inboundOn = input(true);
  readonly anchor = input<HTMLElement | null>(null);
  readonly closed = output<void>();

  readonly settings = signal<DbCaptureSettings | null>(null);
  readonly showHow = signal(false);
  readonly adding = signal(false);
  readonly error = signal<string | null>(null);
  readonly top = signal(0);
  readonly left = signal(0);

  readonly status = computed(() => this.state.projectStatus(this.project()));
  /** The Log level - the same setting as Settings → Database capture (specs/009). */
  protected readonly levelChoices = LOG_LEVEL_CHOICES;
  /** The attach mode - the same setting as Settings → Database capture → Agent (specs/012). */
  protected readonly attachModeChoices = ATTACH_MODE_CHOICES;
  readonly attachMode = computed<AttachMode>(() => this.settings()?.attachMode ?? 'WHEN_ASKED');
  /** What the last ask came to (the Server card has the supervisor's full account). */
  readonly attachNote = signal('');
  /** The supervisor's last attempt for this project (native installs only), read when the panel opens. */
  readonly lastAttempt = signal<AgentAttach | null>(null);
  /** Why the supervisor could not attach - e.g. the app runs as another Windows user than Alfred's service. */
  readonly whyNotAttached = computed(() => {
    const a = this.lastAttempt();
    if (this.status()?.attached || !a || !a.detail || a.state === 'ATTACHED' || a.state === 'ATTACHING') return '';
    return a.detail;
  });
  readonly level = computed<LogLevelSetting>(() => this.settings()?.logLevel ?? 'ERROR');
  readonly logsOn = computed(() => this.state.logsOn(this.project(), this.inboundOn()));
  readonly enabled = computed(() => !!this.status()?.enabled && this.inboundOn());
  readonly agentLine = computed(() => {
    const a = this.status()?.agent;
    if (!a) return '';
    const seen = a.lastSeen ? Math.max(0, Math.round((Date.now() - Date.parse(a.lastSeen)) / 1000)) : null;
    return [a.appServer, a.jvm, seen != null ? `seen ${seen} s ago` : null, a.features != null ? `runs ${a.features || 'nothing'}` : null]
      .filter(Boolean).join(' · ');
  });
  /** Switches on here that the attached agent does not run - the capture is not in the JVM, whatever the switch says. */
  readonly lacking = computed(() => agentLacks(this.status()));

  ngOnInit(): void {
    this.place();
    this.api.settings(this.project()).subscribe({ next: (s) => this.settings.set(s), error: () => this.error.set('Could not load the settings.') });
    this.server.status().subscribe({
      next: (st) => this.lastAttempt.set(st.agents?.find((a) => a.project === this.project()) ?? null),
      error: () => this.lastAttempt.set(null),
    });
  }

  private place(): void {
    const rect = this.anchor()?.getBoundingClientRect();
    if (!rect) return;
    const width = Math.min(420, window.innerWidth - 32);
    this.top.set(rect.bottom + 6);
    this.left.set(Math.max(16, Math.min(rect.right - width, window.innerWidth - width - 16)));
  }

  @HostListener('document:keydown.escape')
  onEscape(): void {
    this.closed.emit();
  }

  @HostListener('document:mousedown', ['$event'])
  onOutside(event: MouseEvent): void {
    const target = event.target as Node;
    if (!this.host.nativeElement.contains(target) && !this.anchor()?.contains(target)) this.closed.emit();
  }

  private save(next: DbCaptureSettings, then?: () => void): void {
    this.error.set(null);
    this.api.saveSettings(this.project(), next).subscribe({
      next: (s) => {
        this.settings.set(s);
        then?.();
      },
      error: (e) => this.error.set(e?.error?.error ?? 'Could not save.'),
    });
  }

  /** A mode other than OFF asks the supervisor right away, so the pick has an effect the user can see. */
  setAttachMode(value: string): void {
    const attachMode = value as AttachMode;
    const s = this.settings();
    if (!s || attachMode === this.attachMode()) return;
    this.save({ ...s, attachMode }, attachMode !== 'OFF' ? () => this.attachNow() : undefined);
  }

  toggleAttachProxy(): void {
    const s = this.settings();
    if (s) this.save({ ...s, attachProxy: s.attachProxy === false }, () => this.attachNow());
  }

  /** Asks the supervisor now with the features the settings say - the answer is only "asked"; the Server card shows the outcome. */
  attachNow(): void {
    this.attachNote.set(ATTACH_NOTES.asking);
    this.server.attachAgent(this.project(), attachFeatures(this.settings())).subscribe({
      next: () => this.attachNote.set(ATTACH_NOTES.asked),
      error: (e) => this.attachNote.set(e?.error?.message ?? ATTACH_NOTES.failed),
    });
  }

  addTable(event: Event): void {
    const input = event.target as HTMLInputElement;
    const table = input.value.trim();
    const s = this.settings();
    if (!table || !s) return;
    this.adding.set(false);
    this.save({ ...s, beforeImageTables: [...s.beforeImageTables, table] });
  }

  removeTable(table: string): void {
    const s = this.settings();
    if (s) this.save({ ...s, beforeImageTables: s.beforeImageTables.filter((t) => t !== table) });
  }

  setRows(event: Event): void {
    const rows = Math.round(Number((event.target as HTMLInputElement).value));
    const s = this.settings();
    if (s && rows > 0 && rows !== s.rowsPerResult) this.save({ ...s, rowsPerResult: rows });
  }

  setLevel(value: string): void {
    const level = value as LogLevelSetting;
    const s = this.settings();
    if (s && level !== this.level()) this.save({ ...s, logLevel: level });
  }

  openOutside(): void {
    this.closed.emit();
    this.window.openOutside(this.project());
  }

  allSettings(): void {
    this.closed.emit();
    void this.router.navigate(['/settings'], { queryParams: { section: 'database-capture' } });
  }
}
