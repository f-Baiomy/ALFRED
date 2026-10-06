import { ChangeDetectionStrategy, Component, OnInit, computed, inject, input, signal } from '@angular/core';
import { forkJoin, of } from 'rxjs';
import { catchError } from 'rxjs/operators';
import { ProjectLogsView } from '../../core/models/call-logs.model';
import { LogStructure, SourceView } from '../../core/models/logs.model';
import { CallLogsApiService } from '../../core/services/call-logs-api.service';
import { LogsApiService } from '../../core/services/logs-api.service';
import { DbCaptureStateService } from '../../core/state/db-capture-state.service';

/**
 * The "▤ Logs" section of a project's database-capture settings (specs/008-logs-call-link, walkthrough step 1): the
 * ▤ switch again, which loaded log sources belong to the project, the thread / time / call-id fields and the allowed
 * clock difference. Shared by the Sources-bar popover and Settings, so they cannot drift apart.
 */
@Component({
  standalone: true,
  selector: 'app-project-logs-settings',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="pls">
      <div class="pr"><span class="pl">▤ Logs</span>
        <span>
          <button type="button" class="cw-switch log" role="switch" [class.on]="state.logsOn(project(), inboundOn())" [class.blocked]="!inboundOn()"
                  [attr.aria-checked]="state.logsOn(project(), inboundOn())" [attr.aria-label]="'Logs linked for ' + project()"
                  [title]="state.logsTitle(project(), inboundOn())" (click)="state.toggleLogs(project(), inboundOn())"></button>
          <span class="dimtxt">{{ state.logsOn(project(), inboundOn()) ? 'linked - the agent tags each request’s lines (exact)' : 'off - Alfred reads none of its logs' }}</span>
        </span>
      </div>
      @if (loaded()) {
        <div class="pr"><span class="pl">Log sources</span>
          <span>
            @for (s of sources(); track s.source.id) {
              <label class="chk"><input type="checkbox" [checked]="sourceIds().includes(s.source.id)" (change)="toggleSource(s.source.id)">
                {{ s.source.name }} <span class="dimtxt">({{ s.source.lineCount.toLocaleString() }} lines)</span></label>
            } @empty {
              <span class="dimtxt">no log source loaded yet - load the application's log in the Logs tab first</span>
            }
          </span>
        </div>
        @if (sourceIds().length) {
          <div class="pr"><span class="pl">Thread field</span>
            <select class="mini wide" [value]="threadField() ?? ''" (change)="threadField.set(value($event))">
              <option value="">- none -</option>
              @for (f of fields(); track f) {<option [value]="f">{{ f }}</option>}
            </select>
          </div>
          <div class="pr"><span class="pl">Time field</span>
            <select class="mini wide" [value]="timeField() ?? ''" (change)="timeField.set(value($event))">
              <option value="">the source's time field</option>
              @for (f of fields(); track f) {<option [value]="f">{{ f }}</option>}
            </select>
          </div>
          <div class="pr"><span class="pl">Call id field</span>
            <span><input class="mini wide" [value]="callIdField()" (change)="callIdField.set(value($event) || 'mdc.alfred.call')">
              @for (s of sourceIds(); track s) {
                <span class="dimtxt" [class.warnt]="!(found()[s] ?? 0)"> · {{ nameOf(s) }}: found in {{ (found()[s] ?? 0).toLocaleString() }} lines</span>
              }
            </span>
          </div>
          <div class="pr"><span class="pl">Clock difference</span>
            <span><input class="mini" type="number" min="0" max="5000" [value]="clockSkewMs()" (change)="clockSkewMs.set(+value($event))"> ms
              <span class="dimtxt">log clock vs Alfred</span></span>
          </div>
          <div class="dimtxt pls-note">The thread and call id fields become exact-searchable in the Logs tab, so a call's lines are found by an index.</div>
        }
        <div class="pr"><span class="pl"></span>
          <span><button type="button" class="action-btn" [disabled]="saving()" (click)="save()">Save logs settings</button>
            @if (saved()) {<span class="dimtxt"> saved</span>}
            @if (error(); as e) {<span class="db-pop-err"> {{ e }}</span>}
          </span>
        </div>
      }
    </div>
  `,
})
export class ProjectLogsSettingsComponent implements OnInit {
  private readonly api = inject(CallLogsApiService);
  private readonly logs = inject(LogsApiService);
  protected readonly state = inject(DbCaptureStateService);

  readonly project = input.required<string>();
  readonly inboundOn = input(true);

  readonly loaded = signal(false);
  readonly sources = signal<readonly SourceView[]>([]);
  private readonly structures = signal<ReadonlyMap<string, LogStructure>>(new Map());
  readonly sourceIds = signal<readonly string[]>([]);
  readonly threadField = signal<string | null>(null);
  readonly timeField = signal<string | null>(null);
  readonly callIdField = signal('mdc.alfred.call');
  readonly clockSkewMs = signal(200);
  readonly found = signal<Readonly<Record<string, number>>>({});
  readonly saving = signal(false);
  readonly saved = signal(false);
  readonly error = signal<string | null>(null);

  /** Field labels of the chosen sources, for the thread and time pickers. */
  readonly fields = computed(() => {
    const labels = new Set<string>();
    for (const id of this.sourceIds()) {
      // by path: the label is only the last segment ("name" for process.thread.name); the backend takes either
      for (const f of this.structures().get(id)?.fields ?? []) if (!f.duplicateOf) labels.add(f.path || f.label);
    }
    return [...labels].sort();
  });

  ngOnInit(): void {
    forkJoin({ view: this.api.settings(this.project()), sources: this.logs.sources().pipe(catchError(() => of([] as SourceView[]))) })
      .subscribe({
        next: ({ view, sources }) => {
          this.sources.set(sources);
          this.apply(view);
          this.loadStructures(view.settings.sourceIds);
          this.loaded.set(true);
        },
        error: () => {
          this.error.set('Could not load the logs settings.');
          this.loaded.set(true);
        },
      });
  }

  toggleSource(id: string): void {
    const ids = this.sourceIds().includes(id) ? this.sourceIds().filter((s) => s !== id) : [...this.sourceIds(), id];
    this.sourceIds.set(ids);
    this.loadStructures(ids);
  }

  save(): void {
    this.saving.set(true);
    this.saved.set(false);
    this.error.set(null);
    this.api.saveSettings(this.project(), {
      sourceIds: this.sourceIds(), threadField: this.threadField(), timeField: this.timeField(),
      callIdField: this.callIdField(), clockSkewMs: this.clockSkewMs(),
    }).subscribe({
      next: (view) => {
        this.apply(view);
        this.saving.set(false);
        this.saved.set(true);
      },
      error: (e) => {
        this.saving.set(false);
        this.error.set(e?.error?.error ?? 'Could not save the logs settings.');
      },
    });
  }

  nameOf(id: string): string {
    return this.sources().find((s) => s.source.id === id)?.source.name ?? id;
  }

  value(event: Event): string {
    return (event.target as HTMLInputElement | HTMLSelectElement).value;
  }

  private apply(view: ProjectLogsView): void {
    const s = view.settings;
    this.sourceIds.set(s.sourceIds);
    this.threadField.set(s.threadField);
    this.timeField.set(s.timeField);
    this.callIdField.set(s.callIdField);
    this.clockSkewMs.set(s.clockSkewMs);
    this.found.set(view.callIdFoundLines);
  }

  private loadStructures(ids: readonly string[]): void {
    const missing = ids.filter((id) => !this.structures().has(id));
    if (!missing.length) return;
    forkJoin(missing.map((id) => this.logs.structure(id).pipe(catchError(() => of(null))))).subscribe((list) => {
      const next = new Map(this.structures());
      list.forEach((st, i) => st && next.set(missing[i], st));
      this.structures.set(next);
      if (!this.threadField()) {
        const thread = this.fields().find((f) => /(^|[._])thread([._]?name)?$/i.test(f)) ?? this.fields().find((f) => /thread/i.test(f));
        if (thread) this.threadField.set(thread);
      }
    });
  }
}
