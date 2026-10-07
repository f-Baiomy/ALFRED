import { Component, DestroyRef, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { HttpErrorResponse } from '@angular/common/http';
import { ServerSettingsService } from '../../../core/services/server-settings.service';
import { ServerSocketService } from '../../../core/services/server-socket.service';
import {
  EditAccess,
  FolderRow,
  HistoryEntry,
  ProjectRow,
  ServerSetting,
  ServerSettingsResponse,
  SettingEdit,
  SettingGroup,
  SettingsConflict,
  SettingsPreview,
  SettingsSaved,
  ValidationResult,
} from '../../../core/models/server-settings.model';
import {
  GROUP_ORDER,
  GROUP_TITLES,
  applyLabel,
  buildEdits,
  displayValue,
  filterSettings,
  keepEdits,
  parseFolders,
  parseProjects,
  retentionText,
  sameValue,
  serializeFolders,
  serializeProjects,
  usageText,
} from '../../../shared/utils/server-settings';

interface ProjectHealth {
  answering: boolean;
  statusCode?: number;
  latencyMs?: number;
  reason?: string;
}
import { ServerCardComponent } from './server-card.component';

/**
 * The Settings tab's Server section (specs/012-server-program US3, mock v5): every deploy-time setting of .env, edited
 * in the units a person reads, reviewed as the exact .env lines that change, then saved. Writes are allowed only
 * where GET /server/access says so (the server enforces it too); everyone else sees the same page read-only.
 */
@Component({
  selector: 'app-server-settings',
  standalone: true,
  imports: [ServerCardComponent],
  templateUrl: './server-settings.component.html',
})
export class ServerSettingsComponent {
  private readonly api = inject(ServerSettingsService);
  private readonly socket = inject(ServerSocketService);
  private readonly destroyRef = inject(DestroyRef);

  readonly groupTitles = GROUP_TITLES;
  readonly applyLabel = applyLabel;
  readonly displayValue = displayValue;

  readonly access = signal<EditAccess | null>(null);
  readonly data = signal<ServerSettingsResponse | null>(null);
  readonly loading = signal(true);
  readonly error = signal<string | null>(null);

  /** Field text by key (lists are kept in the row signals below). */
  readonly form = signal<Record<string, string>>({});
  private serverForm: Record<string, string> = {};
  readonly projects = signal<ProjectRow[]>([]);
  readonly folders = signal<FolderRow[]>([]);
  readonly resets = signal<Set<string>>(new Set());

  readonly query = signal('');
  readonly changedOnly = signal(false);

  readonly review = signal<SettingsPreview | null>(null);
  readonly saving = signal(false);
  readonly saved = signal<SettingsSaved | null>(null);
  readonly conflict = signal<SettingsConflict['conflict'] | null>(null);
  readonly fieldErrors = signal<Record<string, string>>({});
  /** Results of the last check per key: problems, warnings, and the probe facts the hints show. */
  readonly checks = signal<Record<string, ValidationResult[]>>({});
  readonly checking = signal(false);
  readonly checkSummary = signal<string | null>(null);
  readonly historyEntries = signal<HistoryEntry[] | null>(null);
  private readonly pendingChecks = new Map<string, ReturnType<typeof setTimeout>>();

  readonly editable = computed(() => !!this.access()?.allowed && this.data()?.mode === 'NATIVE');

  readonly edits = computed<SettingEdit[]>(() => {
    const data = this.data();
    if (!data) {
      return [];
    }
    const form = { ...this.form() };
    form['INTERNAL_CALL_SERVICES'] = serializeProjects(this.projects());
    form['ALFRED_LOGS_WATCH_DIRS'] = serializeFolders(this.folders());
    return buildEdits(data.settings, form, this.resets());
  });

  readonly needsRestart = computed(() => {
    const byKey = new Map((this.data()?.settings ?? []).map(s => [s.key, s]));
    return this.edits().some(e => byKey.get(e.key)?.applies === 'RESTART');
  });

  readonly groups = computed(() => {
    const data = this.data();
    if (!data) {
      return [];
    }
    const visible = filterSettings(data.settings, this.query(), this.changedOnly(), this.form());
    return GROUP_ORDER
      .map(group => ({ group, settings: visible.filter(s => s.group === group) }))
      .filter(g => g.settings.length > 0);
  });

  constructor() {
    this.reload();
    this.destroyRef.onDestroy(() => this.pendingChecks.forEach(t => clearTimeout(t)));
    this.socket.events$.pipe(takeUntilDestroyed(this.destroyRef)).subscribe(event => {
      if (event.what === 'settings') {
        this.onServerChanged();
      }
    });
    this.socket.reconnected$.pipe(takeUntilDestroyed(this.destroyRef)).subscribe(() => this.onServerChanged());
  }

  reload(): void {
    this.loading.set(true);
    this.api.access().subscribe({ next: a => this.access.set(a), error: () => this.access.set(null) });
    this.api.settings().subscribe({
      next: data => {
        this.apply(data);
        this.loading.set(false);
      },
      error: (e: HttpErrorResponse) => {
        this.error.set(`Could not load the server settings (${e.status || 'no answer'}).`);
        this.loading.set(false);
      },
    });
  }

  private apply(data: ServerSettingsResponse, keepUserEdits = false): void {
    const fresh: Record<string, string> = {};
    for (const s of data.settings) {
      fresh[s.key] = displayValue(s);
    }
    const current = this.currentForm();
    this.data.set(data);
    if (keepUserEdits) {
      const merged = keepEdits(fresh, this.serverForm, current);
      this.form.set(merged);
      this.projects.set(parseProjects(merged['INTERNAL_CALL_SERVICES']));
      this.folders.set(parseFolders(merged['ALFRED_LOGS_WATCH_DIRS']));
    } else {
      this.form.set(fresh);
      this.projects.set(parseProjects(fresh['INTERNAL_CALL_SERVICES']));
      this.folders.set(parseFolders(fresh['ALFRED_LOGS_WATCH_DIRS']));
      this.resets.set(new Set());
    }
    this.serverForm = fresh;
  }

  private currentForm(): Record<string, string> {
    return {
      ...this.form(),
      INTERNAL_CALL_SERVICES: serializeProjects(this.projects()),
      ALFRED_LOGS_WATCH_DIRS: serializeFolders(this.folders()),
    };
  }

  /** .env changed (a save here or elsewhere, or a hand edit): refresh, unless that would throw away unsaved edits. */
  private onServerChanged(): void {
    this.api.settings().subscribe(data => {
      const before = this.data();
      if (this.edits().length === 0) {
        this.apply(data);
      } else if (before && before.envHash !== data.envHash) {
        this.conflict.set({ changedKeys: [], currentHash: data.envHash });
      }
    });
  }

  // ---- editing ---------------------------------------------------------------------------------------------------

  setField(key: string, value: string): void {
    this.form.update(f => ({ ...f, [key]: value }));
    this.unreset(key);
    this.checkSoon(key);
  }

  // ---- checks (FR-030..033) --------------------------------------------------------------------------------------

  /** Checks one field a moment after the last keystroke - one request per pause in typing, never on a timer. */
  checkSoon(key: string): void {
    clearTimeout(this.pendingChecks.get(key));
    this.pendingChecks.set(key, setTimeout(() => {
      this.pendingChecks.delete(key);
      const edit = this.edits().find(e => e.key === key);
      const value = key === 'INTERNAL_CALL_SERVICES' ? serializeProjects(this.projects())
        : key === 'ALFRED_LOGS_WATCH_DIRS' ? serializeFolders(this.folders()) : this.form()[key];
      this.api.check([edit ?? { key, value }]).subscribe(r => this.storeChecks([key], r.results));
    }, 400));
  }

  checkEverything(): void {
    this.checking.set(true);
    this.api.check(this.edits(), true).subscribe({
      next: r => {
        this.checking.set(false);
        this.storeChecks((this.data()?.settings ?? []).map(s => s.key), r.results);
        const errors = r.results.filter(x => x.level === 'ERROR').length;
        const warnings = r.results.filter(x => x.level === 'WARNING').length;
        this.checkSummary.set(errors + warnings === 0
          ? '✓ Every setting checked - no problems.'
          : 'Checked every setting: ' + errors + (errors === 1 ? ' problem, ' : ' problems, ') + warnings
            + (warnings === 1 ? ' warning' : ' warnings') + ' (shown next to each setting).');
      },
      error: () => this.checking.set(false),
    });
  }

  private storeChecks(keys: string[], results: ValidationResult[]): void {
    this.checks.update(current => {
      const next = { ...current };
      for (const key of keys) {
        next[key] = results.filter(r => r.key === key);
      }
      return next;
    });
  }

  hints(key: string): ValidationResult[] {
    return (this.checks()[key] ?? []).filter(r => r.message);
  }

  extraHint(setting: ServerSetting): string {
    const detail = (this.checks()[setting.key] ?? []).find(r => r.level === 'OK')?.detail ?? {};
    if (setting.key === 'INTERNAL_CALLS_RETENTION_ROWS') {
      return retentionText(detail);
    }
    if (setting.kind === 'SIZE_BYTES') {
      return usageText(detail, this.form()[setting.key] ?? '');
    }
    return '';
  }

  projectHealth(name: string): ProjectHealth | null {
    const detail = (this.checks()['INTERNAL_CALL_SERVICES'] ?? []).find(r => r.level === 'OK')?.detail ?? {};
    const health = detail['health'] as Record<string, ProjectHealth> | undefined;
    return health?.[name] ?? null;
  }

  // ---- history (FR-034/035) --------------------------------------------------------------------------------------

  openHistory(): void {
    this.api.history().subscribe(entries => this.historyEntries.set(entries));
  }

  /** Puts the values from before that entry into the form, unsaved - reviewed and saved like any edit. */
  revert(entry: HistoryEntry): void {
    this.api.revert(entry.id).subscribe(r => {
      this.historyEntries.set(null);
      for (const edit of r.edits) {
        const setting = this.setting(edit.key);
        if (!setting) {
          continue;
        }
        if (edit.reset) {
          this.resetToDefault(setting);
        } else if (setting.kind === 'PROJECT_LIST') {
          this.projects.set(parseProjects(edit.value ?? ''));
        } else if (setting.kind === 'FOLDER_LIST') {
          this.folders.set(parseFolders(edit.value ?? ''));
        } else {
          this.setField(edit.key, setting.kind === 'SIZE_BYTES' ? displayValue({ ...setting, value: edit.value ?? '' }) : edit.value ?? '');
        }
      }
    });
  }

  sourceText(entry: HistoryEntry): string {
    switch (entry.source) {
      case 'UI':
        return 'Settings tab, from ' + entry.sourceDetail;
      case 'CLI':
        return 'alfred config (' + entry.sourceDetail + ')';
      case 'HAND_EDIT':
        return 'edited by hand on the server';
      case 'INSTALL':
        return 'first start';
      case 'IMPORT':
        return 'imported from ' + entry.sourceDetail;
      default:
        return entry.source.toLowerCase();
    }
  }

  toggle(key: string): void {
    this.setField(key, this.form()[key] === 'true' ? 'false' : 'true');
  }

  changed(setting: ServerSetting): boolean {
    if (this.resets().has(setting.key)) {
      return true;
    }
    if (setting.kind === 'PROJECT_LIST') {
      return serializeProjects(this.projects()) !== (setting.value ?? '');
    }
    if (setting.kind === 'FOLDER_LIST') {
      return serializeFolders(this.folders()) !== (setting.value ?? '');
    }
    const text = this.form()[setting.key];
    return text !== undefined && !sameValue(setting, text);
  }

  resetToDefault(setting: ServerSetting): void {
    this.resets.update(r => new Set(r).add(setting.key));
    const value = setting.kind === 'SIZE_BYTES' ? displayValue({ ...setting, value: setting.defaultValue }) : setting.defaultValue ?? '';
    this.form.update(f => ({ ...f, [setting.key]: value }));
    if (setting.kind === 'PROJECT_LIST') {
      this.projects.set(parseProjects(setting.defaultValue));
    }
    if (setting.kind === 'FOLDER_LIST') {
      this.folders.set(parseFolders(setting.defaultValue));
    }
  }

  private unreset(key: string): void {
    if (this.resets().has(key)) {
      this.resets.update(r => {
        const next = new Set(r);
        next.delete(key);
        return next;
      });
    }
  }

  setProject(index: number, field: keyof ProjectRow, value: string): void {
    this.projects.update(rows => rows.map((r, i) => (i === index ? { ...r, [field]: value } : r)));
    this.unreset('INTERNAL_CALL_SERVICES');
    this.checkSoon('INTERNAL_CALL_SERVICES');
  }

  addProject(): void {
    const used = this.projects().map(p => Number(p.listenPort)).filter(Number.isFinite);
    const next = used.length ? Math.max(...used) + 1 : 9001;
    this.projects.update(rows => [...rows, { name: '', listenPort: String(next), upstreamPort: '', outbound: '' }]);
  }

  removeProject(index: number): void {
    this.projects.update(rows => rows.filter((_, i) => i !== index));
    this.unreset('INTERNAL_CALL_SERVICES');
  }

  setFolder(index: number, field: keyof FolderRow, value: string): void {
    this.folders.update(rows => rows.map((r, i) => (i === index ? { ...r, [field]: value } : r)));
    this.unreset('ALFRED_LOGS_WATCH_DIRS');
    this.checkSoon('ALFRED_LOGS_WATCH_DIRS');
  }

  addFolder(): void {
    this.folders.update(rows => [...rows, { name: '', path: '' }]);
  }

  removeFolder(index: number): void {
    this.folders.update(rows => rows.filter((_, i) => i !== index));
    this.unreset('ALFRED_LOGS_WATCH_DIRS');
  }

  discard(): void {
    const data = this.data();
    if (data) {
      this.apply(data);
    }
    this.fieldErrors.set({});
  }

  // ---- review and save -------------------------------------------------------------------------------------------

  openReview(): void {
    const data = this.data();
    if (!data) {
      return;
    }
    this.api.preview(data.envHash, this.edits()).subscribe(preview => {
      this.review.set(preview);
      this.fieldErrors.set(errorsByKey(preview.results));
    });
  }

  reviewErrors(): ValidationResult[] {
    return (this.review()?.results ?? []).filter(r => r.level === 'ERROR');
  }

  reviewWarnings(): ValidationResult[] {
    return (this.review()?.results ?? []).filter(r => r.level === 'WARNING');
  }

  save(): void {
    const data = this.data();
    if (!data) {
      return;
    }
    this.saving.set(true);
    this.api.save(data.envHash, this.edits()).subscribe({
      next: saved => {
        this.saving.set(false);
        this.review.set(null);
        this.saved.set(saved);
        this.fieldErrors.set({});
        this.api.settings().subscribe(fresh => this.apply(fresh));
      },
      error: (e: HttpErrorResponse) => {
        this.saving.set(false);
        this.review.set(null);
        if (e.status === 409 && e.error?.conflict) {
          this.conflict.set(e.error.conflict);
        } else if (e.status === 422 && e.error?.results) {
          this.fieldErrors.set(errorsByKey(e.error.results));
        } else if (e.status === 403) {
          this.error.set(e.error?.howToEdit ?? 'Server settings cannot be changed from here.');
        } else {
          this.error.set(`Saving failed (${e.status || 'no answer'}).`);
        }
      },
    });
  }

  loadServerValuesKeepMine(): void {
    this.api.settings().subscribe(data => {
      this.apply(data, true);
      this.conflict.set(null);
    });
  }

  addMissing(): void {
    this.api.addMissing().subscribe(() => this.api.settings().subscribe(fresh => this.apply(fresh)));
  }

  defaultText(setting: ServerSetting): string {
    return displayValue({ ...setting, value: setting.defaultValue });
  }

  setting(key: string): ServerSetting | undefined {
    return this.data()?.settings.find(s => s.key === key);
  }

  outcomeText(outcome: string, detail: string): string {
    switch (outcome) {
      case 'APPLIED':
        return 'applied live';
      case 'PROXIES_RESTARTED':
        return 'proxies restarted';
      case 'PENDING_RESTART':
        return 'takes effect after a restart';
      default:
        return detail || 'saved';
    }
  }

  trackGroup = (_: number, g: { group: SettingGroup }) => g.group;
}

function errorsByKey(results: ValidationResult[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const r of results) {
    if (r.level === 'ERROR') {
      out[r.key] = out[r.key] ? `${out[r.key]}; ${r.message}` : r.message;
    }
  }
  return out;
}
