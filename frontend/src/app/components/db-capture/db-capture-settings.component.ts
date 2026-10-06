import { ChangeDetectionStrategy, Component, OnInit, computed, effect, inject, signal, untracked } from '@angular/core';
import { DbCaptureSettings, DbThresholds, ProjectCaptureStatus } from '../../core/models/db-capture.model';
import { DbCaptureApiService } from '../../core/services/db-capture-api.service';
import { DbCaptureStateService } from '../../core/state/db-capture-state.service';
import { RedactionsStore } from '../../core/state/redactions-store.service';

type ListKey = 'beforeImageTables' | 'expectedFingerprints' | 'ignorePatterns' | 'passThroughClasses';

/**
 * Settings → Database capture (mock: "Settings → Database capture"): the same per-project switch as the Sources bar
 * and the cycle widget, the agent's status, and each project's capture settings - rows kept per result, before-image
 * tables, flag thresholds, expected statements, ignored statements, outside-call capture - plus which database
 * columns are hidden in exports. Changes save as they are made and reach the agent on its next heartbeat.
 */
@Component({
  standalone: true,
  selector: 'app-db-capture-settings',
  changeDetection: ChangeDetectionStrategy.OnPush,
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
            <div class="set-row"><div class="set-l">Outside calls</div>
              <div><label class="chk"><input type="checkbox" [checked]="s.outsideCallCapture" (change)="toggleOutside(p.project)">
                Also record statements no inbound call caused (scheduled jobs, message listeners, startup)</label></div></div>
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

  private readonly settings = signal<ReadonlyMap<string, DbCaptureSettings>>(new Map());
  readonly errors = signal<ReadonlyMap<string, string>>(new Map());
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

  private load(project: string): void {
    this.api.settings(project).subscribe({ next: (s) => this.put(project, s), error: () => undefined });
  }

  private put(project: string, s: DbCaptureSettings): void {
    this.settings.set(new Map(this.settings()).set(project, s));
  }

  private save(project: string, next: DbCaptureSettings): void {
    const errors = new Map(this.errors());
    errors.delete(project);
    this.errors.set(errors);
    this.api.saveSettings(project, next).subscribe({
      next: (s) => this.put(project, s),
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

  toggleIndexInfo(project: string): void {
    const s = this.settingsOf(project);
    if (s) this.save(project, { ...s, indexInfo: !s.indexInfo });
  }

  toggleOutside(project: string): void {
    const s = this.settingsOf(project);
    if (s) this.save(project, { ...s, outsideCallCapture: !s.outsideCallCapture });
  }
}
