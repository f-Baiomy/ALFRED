import { Component, DestroyRef, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { HttpErrorResponse } from '@angular/common/http';
import { ServerSettingsService } from '../../../core/services/server-settings.service';
import { ServerSocketService } from '../../../core/services/server-socket.service';
import {
  EditAccess,
  FolderRow,
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
  sameValue,
  serializeFolders,
  serializeProjects,
} from '../../../shared/utils/server-settings';
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
