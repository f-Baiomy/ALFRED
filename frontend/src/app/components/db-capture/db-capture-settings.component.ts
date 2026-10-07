import { ChangeDetectionStrategy, Component, OnInit, computed, effect, inject, signal, untracked } from '@angular/core';
import { ATTACH_MODE_CHOICES, AttachMode, DbCaptureSettings, DbThresholds, ProjectCaptureStatus } from '../../core/models/db-capture.model';
import { DbCaptureApiService } from '../../core/services/db-capture-api.service';
import { DbCaptureStateService } from '../../core/state/db-capture-state.service';
import { RedactionsStore } from '../../core/state/redactions-store.service';
import { ServerSettingsService } from '../../core/services/server-settings.service';
import { LogLevelSetting } from '../../core/models/call-logs.model';
import { SelectPickerComponent } from '../select-picker/select-picker.component';
import { LOG_LEVEL_CHOICES } from '../../shared/utils/call-log-rows';
import { DEFAULT_REDIS_SETTINGS, RedisSettings } from '../../core/models/store-command.model';

type ListKey = 'beforeImageTables' | 'expectedFingerprints' | 'ignorePatterns' | 'passThroughClasses';

/**
 * Settings → Database capture (mock: "Settings → Database capture"): the same per-project switch as the Sources bar
 * and the cycle widget, the agent's status, and each project's capture settings - rows kept per result, before-image
 * tables, flag thresholds, expected statements, ignored statements, the Log level of caught lines, outside-call capture - plus which database
 * columns are hidden in exports. Changes save as they are made and reach the agent on its next heartbeat.
 */
@Component({
  standalone: true,
  selector: 'app-db-capture-settings',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [SelectPickerComponent],
  template: `
    <section class="panel settings-panel db-settings">
      <h3>Database capture</h3>
      <p class="sub">Records every database statement your Java application runs, tied to the inbound call that caused it.
        One switch per project - the same switch as the ◆ in the Live Calls Sources bar and the cycle widget's Log DB column.</p>

      <div class="set-row"><div class="set-l">Capture</div>
        <div>
          @for (p of state.projects(); track p.project) {
            <label class="chk" [title]="state.switchTitle(p.project, p.inboundLogging)">
              <input type="checkbox" [checked]="state.isOn(p.project, p.inboundLogging)" [disabled]="!p.inboundLogging"
                     (change)="state.toggle(p.project, p.inboundLogging)"> {{ p.project }}
            </label>&nbsp;
          } @empty {
            <span class="dimtxt">No projects yet - configure internal_call_services (inbound logging) first.</span>
          }
          <div class="dimtxt" style="margin-top:.3rem">
            @for (p of state.projects(); track p.project) {
              <span>{{ agentText(p) }}</span>@if (!$last) {<span> · </span>}
            }
          </div>
          @if (state.switchError(); as err) {<div class="db-err">{{ err }}</div>}
        </div>
      </div>

      <div class="set-row"><div class="set-l">Redaction</div>
        <div class="dimtxt">Values are never hidden in Alfred itself. In exports, the columns below are masked in result rows,
          before-images and the parameters bound to them (use ⊘ on a column in the database window to add one).
          @if (hiddenColumns().length) {
            Now hiding:
            @for (r of hiddenColumns(); track r.id) {
              <span class="tchip">{{ r.name }} <a (click)="redactions.remove(r.id)" title="Include it in exports again">✕</a></span>
            }
          } @else {
            No database columns are hidden.
          }
        </div>
      </div>

      @for (p of state.projects(); track p.project) {
        @if (settingsOf(p.project); as s) {
          <div class="db-proj">
            <h4>{{ p.project }}</h4>
            <div class="set-row"><div class="set-l">Rows kept per result</div>
              <div><input class="mini" type="number" min="1" [value]="s.rowsPerResult" (change)="setNumber(p.project, 'rowsPerResult', $event)">
                <span class="dimtxt"> beyond this only the count is kept; the window shows it</span></div></div>
            <div class="set-row"><div class="set-l">Before-image</div>
              <div>
                @for (t of s.beforeImageTables; track t) {<span class="tchip on">{{ t }} <a (click)="removeFrom(p.project, 'beforeImageTables', t)">✕</a></span>}
                <input class="mini wide" placeholder="+ add table" (keydown.enter)="addTo(p.project, 'beforeImageTables', $event)">
                <div class="dimtxt" style="margin-top:.3rem">For these tables the agent reads the rows just before each UPDATE or DELETE, so
                  "Deleted rows" and "Before → after" are always complete. Costs one extra read per write.</div>
              </div></div>
            <div class="set-row"><div class="set-l">Where in code</div>
              <div>
                @for (c of s.passThroughClasses ?? []; track c) {<span class="tchip">{{ c }} <a (click)="removeFrom(p.project, 'passThroughClasses', c)">✕</a></span>}
                <input class="mini wide" placeholder="+ pass-through class (e.g. GenericDAOImpl)" (keydown.enter)="addTo(p.project, 'passThroughClasses', $event)">
                <div class="dimtxt" style="margin-top:.3rem">Each statement records the application code that issued it - up to
                  <input class="mini" type="number" min="1" max="10" [value]="s.callerFrames ?? 5" (change)="setNumber(p.project, 'callerFrames', $event)"> frames,
                  skipping these classes (a class name, or a package/class prefix like <code>com.acme.dao.</code>). A generic DAO every query goes through
                  tells you nothing; the services above it do. JDK, drivers, pools, Hibernate and Spring are always skipped.</div>
              </div></div>
            <div class="set-row"><div class="set-l">Flags</div>
              <div class="dimtxt">Slow over <input class="mini" type="number" [value]="s.thresholds.slowMs" (change)="setThreshold(p.project, 'slowMs', $event)"> ms <span title="Measured from the call's fastest SELECTs - a remote database's network time is not counted">beyond the database round trip</span> ·
                Huge result over <input class="mini" type="number" [value]="s.thresholds.hugeRows" (change)="setThreshold(p.project, 'hugeRows', $event)"> rows ·
                N+1 from <input class="mini" type="number" [value]="s.thresholds.repeatCount" (change)="setThreshold(p.project, 'repeatCount', $event)"> repeats ·
                Large delete over <input class="mini" type="number" [value]="s.thresholds.largeDeleteRows" (change)="setThreshold(p.project, 'largeDeleteRows', $event)"> rows ·
                DELETE/UPDATE without WHERE always</div></div>
            <div class="set-row"><div class="set-l">Expected</div>
              <div>
                @for (f of s.expectedFingerprints; track f) {<span class="tchip">{{ f }} <a (click)="removeFrom(p.project, 'expectedFingerprints', f)">✕</a></span>}
                <span class="dimtxt">statements marked expected (from a flag's "Mark as expected") never raise a flag</span>
              </div></div>
            <div class="set-row"><div class="set-l">Ignore</div>
              <div>
                @for (i of s.ignorePatterns; track i) {<span class="tchip">{{ i }} <a (click)="removeFrom(p.project, 'ignorePatterns', i)">✕</a></span>}
                <input class="mini wide" placeholder="+ add (e.g. QRTZ_%)" (keydown.enter)="addTo(p.project, 'ignorePatterns', $event)">
                <span class="dimtxt"> health checks and scheduler tables are not recorded</span>
              </div></div>
            <div class="set-row"><div class="set-l">Index check</div>
              <div><label class="chk"><input type="checkbox" [checked]="!!s.indexInfo" (change)="toggleIndexInfo(p.project)">
                For a slow statement, read its table's index list once (database metadata - never a query of your data; EXPLAIN is not run)</label></div></div>
            <div class="set-row"><div class="set-l">Log level</div>
              <div><app-select-picker class="db-level" ariaLabel="Log level" title="The lowest level of log line the agent catches with each call (▤)"
                                      [options]="levelChoices" [value]="s.logLevel ?? 'ERROR'" (valueChange)="setLogLevel(p.project, $event)" />
                <div class="dimtxt" style="margin-top:.3rem">Log lines caught with each call while <b>▤</b> is on. Can't go below the app's
                  own level - the agent catches after the app's check and never changes what it logs.</div></div></div>
            <div class="set-row"><div class="set-l">Outside calls</div>
              <div><label class="chk"><input type="checkbox" [checked]="s.outsideCallCapture" (change)="toggleOutside(p.project)">
                Also record statements no inbound call caused (scheduled jobs, message listeners, startup)</label></div></div>
            <div class="set-row"><div class="set-l">Agent</div>
              <div>
                <app-select-picker class="db-attach-mode" ariaLabel="Attach mode"
                                   title="The supervisor finds the app (the JVM listening on this project's upstream port) and loads Alfred's agent into it. When asked: at start, when calls arrive and no agent reports, on Attach now. Automatic: also the moment the app's port opens or its pid changes - the supervisor watches the port."
                                   [options]="attachModeChoices" [value]="s.attachMode ?? 'WHEN_ASKED'" (valueChange)="setAttachMode(p.project, $event)" />
                <label class="chk" title="Also route the app's outbound calls through Alfred's forward proxy (the proxy feature)">
                  <input type="checkbox" [checked]="s.attachProxy !== false" [disabled]="s.attachMode === 'OFF'" (change)="toggleAttachProxy(p.project)"> and route its outbound calls through Alfred</label>
                <button type="button" class="link-btn" [disabled]="s.attachMode === 'OFF'" (click)="attachNow(p.project)" title="Ask the supervisor to attach now">Attach now</button>
                <div class="dimtxt" style="margin-top:.3rem">{{ agentText(p) }}@if (attachNote(p.project); as note) { · {{ note }}}
                  Native install only; the outcome shows on Settings → Server. The agent also follows the reverse proxy: a call it serves tells it where this Alfred is.</div>
              </div></div>
            <!-- ⬢ Redis capture (specs/011-redis-capture, mock section 5): nothing here limits what is stored -->
            <h4 class="rd-h"><span class="redis-glyph">⬢</span> Redis capture</h4>
            <div class="set-row"><div class="set-l">Capture</div>
              <div><label class="chk" [title]="state.redisTitle(p.project, p.inboundLogging)">
                <input type="checkbox" [checked]="state.redisOn(p.project, p.inboundLogging)" [disabled]="!p.inboundLogging"
                       (change)="state.toggleRedis(p.project, p.inboundLogging)"> on</label>
                <span class="dimtxt"> same as the ⬢ switch</span></div></div>
            <div class="set-row"><div class="set-l">Clients found</div>
              <div class="dimtxt">
                @for (c of p.redisClients ?? []; track c.client) {
                  <div><span style="color:var(--redis)">●</span> {{ c.client }}@if (c.version) { {{ c.version }}} · {{ c.connections }}
                    {{ c.connections === 1 ? 'connection' : 'connections' }}@if (c.servers.length) { · {{ c.servers.join(', ') }}}@if (c.dbs.length) { db {{ c.dbs.join(', ') }}}</div>
                } @empty {
                  None seen yet - the agent reports a client once the app sends its first command during a call.
                }
              </div></div>
            <div class="set-row"><div class="set-l">Stored</div>
              <div class="dimtxt">Every command and its full reply, as sent and received - nothing shortened. All projects' Redis commands
                share a 2 GB budget; past it the oldest calls' commands go first, calls in a session cycle are kept.</div></div>
            <div class="set-row"><div class="set-l">Mask on screen</div>
              <div>
                @for (m of redisOf(s).maskPatterns; track m) {<span class="tchip">{{ m }} <a (click)="removeMask(p.project, m)">✕</a></span>}
                <input class="mini wide" placeholder="+ key pattern (e.g. session:*)" (keydown.enter)="addMask(p.project, $event)">
                <div class="dimtxt" style="margin-top:.3rem">Values of these keys are stored in full; they are masked in the window, exports and Claude
                  (‹masked · 1,412 B›). None by default.</div>
              </div></div>
            <div class="set-row"><div class="set-l">Show values as</div>
              <div><label class="chk"><input type="radio" [name]="'rv-' + p.project" [checked]="redisOf(s).showValues === 'DECODED'"
                                             (change)="setRedis(p.project, { showValues: 'DECODED' })"> Decoded - auto (JDK · Kryo · Jackson · gzip · Snappy)</label>&nbsp;
                <label class="chk"><input type="radio" [name]="'rv-' + p.project" [checked]="redisOf(s).showValues === 'RAW'"
                                          (change)="setRedis(p.project, { showValues: 'RAW' })"> Raw bytes</label>
                <span class="dimtxt"> display only - the raw bytes are always stored</span></div></div>
            <div class="set-row"><div class="set-l">Spring Cache names</div>
              <div class="dimtxt">@if (p.springCaches?.length) {{{ p.springCaches!.length }} found · {{ p.springCaches!.join(', ') }}} @else {None seen yet}</div></div>
            <div class="set-row"><div class="set-l">Value before a write</div>
              <div><label class="chk"><input type="checkbox" [checked]="redisOf(s).beforeImage" (change)="setRedis(p.project, { beforeImage: !redisOf(s).beforeImage })">
                read it first</label><span class="dimtxt"> · one extra TYPE / read / TTL per write, sent by the agent - off by default, like the database before-image</span></div></div>
            <div class="set-row"><div class="set-l">Slow command</div>
              <div class="dimtxt">over <input class="mini" type="number" min="1" [value]="redisOf(s).slowMillis" (change)="setRedisSlow(p.project, $event)"> ms
                shown amber, counted in Findings</div></div>
            <div class="set-row"><div class="set-l">Housekeeping</div>
              <div><label class="chk"><input type="checkbox" [checked]="redisOf(s).housekeeping" (change)="setRedis(p.project, { housekeeping: !redisOf(s).housekeeping })">
                Also record PING / AUTH / CLIENT / HELLO</label></div></div>
            @if (errors().get(p.project); as err) {<div class="db-err">{{ err }}</div>}
          </div>
        }
      }
    </section>
  `,
})
export class DbCaptureSettingsComponent implements OnInit {
  private readonly api = inject(DbCaptureApiService);
  protected readonly state = inject(DbCaptureStateService);
  protected readonly redactions = inject(RedactionsStore);

  private readonly server = inject(ServerSettingsService);
  private readonly settings = signal<ReadonlyMap<string, DbCaptureSettings>>(new Map());
  readonly errors = signal<ReadonlyMap<string, string>>(new Map());
  /** What the last "attach now" came to, per project (the Server card has the supervisor's full account). */
  private readonly attachNotes = signal<ReadonlyMap<string, string>>(new Map());
  protected readonly levelChoices = LOG_LEVEL_CHOICES;
  protected readonly attachModeChoices = ATTACH_MODE_CHOICES;
  readonly hiddenColumns = computed(() => this.redactions.all().filter((r) => r.kind === 'db-column'));

  constructor() {
    // A project appearing (or settings changed elsewhere - the socket refreshes the list) loads its settings.
    effect(() => {
      const projects = this.state.projects();
      untracked(() => projects.forEach((p) => this.load(p.project)));
    });
  }

  ngOnInit(): void {
    this.state.refreshProjects();
  }

  settingsOf(project: string): DbCaptureSettings | undefined {
    return this.settings().get(project);
  }

  agentText(p: ProjectCaptureStatus): string {
    if (!p.attached || !p.agent) return `${p.project} - agent not attached`;
    const seen = p.agent.lastSeen ? Math.max(0, Math.round((Date.now() - Date.parse(p.agent.lastSeen)) / 1000)) : null;
    return `agent attached to ${p.project} (${[p.agent.appServer, p.agent.jvm].filter(Boolean).join(' · ')})${seen != null ? ` - seen ${seen} s ago` : ''}`;
  }

  attachNote(project: string): string {
    return this.attachNotes().get(project) ?? '';
  }

  /** A mode other than OFF asks the supervisor right away, so the switch has an effect the user can see on the Server card. */
  setAttachMode(project: string, mode: string): void {
    const s = this.settingsOf(project);
    if (!s) return;
    const attachMode = mode as AttachMode;
    this.save(project, { ...s, attachMode }, attachMode !== 'OFF' ? () => this.attachNow(project) : undefined);
  }

  toggleAttachProxy(project: string): void {
    const s = this.settingsOf(project);
    if (!s) return;
    this.save(project, { ...s, attachProxy: s.attachProxy === false }, () => this.attachNow(project));
  }

  /** Asks the supervisor now, with the features the settings say - the answer is only "asked"; the Server card shows the outcome. */
  attachNow(project: string): void {
    const s = this.settingsOf(project);
    const features = s?.attachProxy === false ? ['db', 'logs', 'redis'] : ['proxy', 'db', 'logs', 'redis'];
    this.attachNotes.set(new Map(this.attachNotes()).set(project, 'asking the supervisor…'));
    this.server.attachAgent(project, features).subscribe({
      next: () => this.attachNotes.set(new Map(this.attachNotes()).set(project, 'asked - see Settings → Server for the outcome')),
      error: (e) => this.attachNotes.set(new Map(this.attachNotes()).set(project, e?.error?.message ?? 'Could not ask the supervisor.')),
    });
  }

  private load(project: string): void {
    this.api.settings(project).subscribe({ next: (s) => this.put(project, s), error: () => undefined });
  }

  private put(project: string, s: DbCaptureSettings): void {
    this.settings.set(new Map(this.settings()).set(project, s));
  }

  private save(project: string, next: DbCaptureSettings, then?: () => void): void {
    const errors = new Map(this.errors());
    errors.delete(project);
    this.errors.set(errors);
    this.api.saveSettings(project, next).subscribe({
      next: (s) => {
        this.put(project, s);
        then?.();
      },
      error: (e) => this.errors.set(new Map(this.errors()).set(project, e?.error?.error ?? 'Could not save.')),
    });
  }

  setNumber(project: string, key: 'rowsPerResult' | 'callerFrames', event: Event): void {
    const s = this.settingsOf(project);
    const value = Math.round(Number((event.target as HTMLInputElement).value));
    if (s && value > 0) this.save(project, { ...s, [key]: value });
  }

  setThreshold(project: string, key: keyof DbThresholds, event: Event): void {
    const s = this.settingsOf(project);
    const value = Math.round(Number((event.target as HTMLInputElement).value));
    if (s && value > 0) this.save(project, { ...s, thresholds: { ...s.thresholds, [key]: value } });
  }

  addTo(project: string, key: ListKey, event: Event): void {
    const input = event.target as HTMLInputElement;
    const value = input.value.trim();
    const s = this.settingsOf(project);
    if (!s || !value) return;
    input.value = '';
    this.save(project, { ...s, [key]: [...(s[key] ?? []), value] });
  }

  removeFrom(project: string, key: ListKey, value: string): void {
    const s = this.settingsOf(project);
    if (s) this.save(project, { ...s, [key]: (s[key] ?? []).filter((v) => v !== value) });
  }

  setLogLevel(project: string, value: string): void {
    const s = this.settingsOf(project);
    const level = value as LogLevelSetting;
    if (s && level !== (s.logLevel ?? 'ERROR')) this.save(project, { ...s, logLevel: level });
  }

  redisOf(s: DbCaptureSettings): RedisSettings {
    return s.redis ?? DEFAULT_REDIS_SETTINGS;
  }

  setRedis(project: string, change: Partial<RedisSettings>): void {
    const s = this.settingsOf(project);
    if (s) this.save(project, { ...s, redis: { ...this.redisOf(s), ...change } });
  }

  setRedisSlow(project: string, event: Event): void {
    const value = Math.round(Number((event.target as HTMLInputElement).value));
    if (value > 0) this.setRedis(project, { slowMillis: value });
  }

  addMask(project: string, event: Event): void {
    const input = event.target as HTMLInputElement;
    const value = input.value.trim();
    const s = this.settingsOf(project);
    if (!s || !value) return;
    input.value = '';
    const masks = this.redisOf(s).maskPatterns;
    if (!masks.includes(value)) this.setRedis(project, { maskPatterns: [...masks, value] });
  }

  removeMask(project: string, value: string): void {
    const s = this.settingsOf(project);
    if (s) this.setRedis(project, { maskPatterns: this.redisOf(s).maskPatterns.filter((m) => m !== value) });
  }

  toggleIndexInfo(project: string): void {
    const s = this.settingsOf(project);
    if (s) this.save(project, { ...s, indexInfo: !s.indexInfo });
  }

  toggleOutside(project: string): void {
    const s = this.settingsOf(project);
    if (s) this.save(project, { ...s, outsideCallCapture: !s.outsideCallCapture });
  }
}
