import { ChangeDetectionStrategy, Component, ElementRef, HostListener, OnInit, computed, inject, input, output, signal } from '@angular/core';
import { Router } from '@angular/router';
import { DbCaptureSettings } from '../../core/models/db-capture.model';
import { DbCaptureApiService } from '../../core/services/db-capture-api.service';
import { DbCaptureStateService } from '../../core/state/db-capture-state.service';
import { DbWindowService } from './db-window.service';
import { LogLevelSetting } from '../../core/models/call-logs.model';
import { LOG_LEVEL_CHOICES } from '../../shared/utils/call-log-rows';

/**
 * The ▾ panel next to a project's ◆ switch in the Sources bar (mock: ".db-pop"): the switch again, whether the
 * agent is attached, the before-image tables, rows kept per result and ▤ Log level, the per-viewer "show the chip" choice, and
 * the way to the full settings. Positioned under the button that opened it (fixed, so no ancestor clips it).
 */
@Component({
  standalone: true,
  selector: 'app-db-capture-popover',
  changeDetection: ChangeDetectionStrategy.OnPush,
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
      @if (showHow() && !status()?.attached) {
        <div class="db-how">Run <code>python3 start.py --db-capture on</code> on the machine running {{ project() }} (WildFly found
          automatically), or start the JVM with <code>-javaagent:alfred-db-agent.jar=alfredUrl=…,project={{ project() }}</code>.
          See docs/db-capture.md.</div>
      }
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
          <select class="mini" [value]="level()" (change)="setLevel($event)">
            @for (c of levelChoices; track c.value) {<option [value]="c.value" [selected]="level() === c.value">{{ c.label }}</option>}
          </select>
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
  readonly level = computed<LogLevelSetting>(() => this.settings()?.logLevel ?? 'ERROR');
  readonly logsOn = computed(() => this.state.logsOn(this.project(), this.inboundOn()));
  readonly enabled = computed(() => !!this.status()?.enabled && this.inboundOn());
  readonly agentLine = computed(() => {
    const a = this.status()?.agent;
    if (!a) return '';
    const seen = a.lastSeen ? Math.max(0, Math.round((Date.now() - Date.parse(a.lastSeen)) / 1000)) : null;
    return [a.appServer, a.jvm, seen != null ? `seen ${seen} s ago` : null].filter(Boolean).join(' · ');
  });

  ngOnInit(): void {
    this.place();
    this.api.settings(this.project()).subscribe({ next: (s) => this.settings.set(s), error: () => this.error.set('Could not load the settings.') });
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

  private save(next: DbCaptureSettings): void {
    this.error.set(null);
    this.api.saveSettings(this.project(), next).subscribe({
      next: (s) => this.settings.set(s),
      error: (e) => this.error.set(e?.error?.error ?? 'Could not save.'),
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

  setLevel(event: Event): void {
    const level = (event.target as HTMLSelectElement).value as LogLevelSetting;
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
