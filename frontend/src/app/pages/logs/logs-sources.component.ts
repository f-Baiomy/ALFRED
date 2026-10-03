import { Component, DestroyRef, OnInit, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { Router, RouterLink } from '@angular/router';
import { DecimalPipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { LogsApiService } from '../../core/services/logs-api.service';
import { LogsSocketService } from '../../core/services/logs-socket.service';
import { ConfirmDialogService } from '../../core/services/confirm-dialog.service';
import { ConfirmDialogComponent } from '../../components/confirm-dialog/confirm-dialog.component';
import { InputStatus, LogInput, SourceView } from '../../core/models/logs.model';

const GB = 1024 ** 3;

/** Log sources and their inputs (FR-001, FR-004, FR-009, FR-045..047; mock.html `renderSources()`). */
@Component({
  selector: 'app-logs-sources',
  standalone: true,
  imports: [RouterLink, DecimalPipe, FormsModule, ConfirmDialogComponent],
  templateUrl: './logs-sources.component.html',
})
export class LogsSourcesComponent implements OnInit {
  private readonly api = inject(LogsApiService);
  private readonly socket = inject(LogsSocketService);
  private readonly confirm = inject(ConfirmDialogService);
  private readonly router = inject(Router);
  private readonly destroyRef = inject(DestroyRef);

  readonly sources = signal<SourceView[]>([]);
  readonly loaded = signal(false);
  readonly error = signal('');
  readonly menuFor = signal<string | null>(null);
  readonly settings = signal<{ id: string; name: string; gb: number; error: string } | null>(null);
  readonly message = signal<Record<string, string>>({});

  ngOnInit(): void {
    this.refresh();
    this.socket.events$.pipe(takeUntilDestroyed(this.destroyRef)).subscribe((e) => {
      if (e.type === 'sources-changed' || e.type === 'input-progress') this.refresh();
    });
    this.socket.reconnected$.pipe(takeUntilDestroyed(this.destroyRef)).subscribe(() => this.refresh());
  }

  refresh(): void {
    this.api.sources().subscribe({
      next: (s) => {
        this.sources.set(s);
        this.loaded.set(true);
        this.error.set('');
      },
      error: () => this.error.set('Could not load log sources. Is the backend running?'),
    });
  }

  open(id: string): void {
    void this.router.navigate(['/logs', id]);
  }

  following(v: SourceView): boolean {
    return v.inputs.some((i) => i.status === 'FOLLOWING');
  }

  pillClass(s: InputStatus): string {
    return ({ DONE: 'ok', FOLLOWING: 'live', LOADING: 'live', UPLOADING: 'live', QUEUED: 'wait', WAITING: 'wait', PAUSED: 'warn', FAILED: 'fail' } as const)[s];
  }

  statusText(i: LogInput): string {
    if (i.status === 'PAUSED' && i.statusReason === 'LOW_DISK') return 'paused · low disk';
    return i.status.toLowerCase();
  }

  icon(i: LogInput): string {
    return ({ UPLOAD: '⇪', SERVER_FILE: '⧉', FOLLOW: '↻', PUSH: '⇢', OPENSEARCH: '☁' } as const)[i.kind];
  }

  progressText(i: LogInput): string {
    if (i.status === 'PAUSED' && i.statusReason === 'LOW_DISK') return 'Paused: low disk space';
    if (i.statusReason) return i.statusReason;
    const pct = i.totalBytes > 0 && i.status === 'LOADING' ? ` · ${Math.min(100, Math.round(((i.position % 2 ** 40) / i.totalBytes) * 100))}%` : '';
    return `${i.linesRead.toLocaleString('en-US')} lines${pct}`;
  }

  gb(bytes: number): string {
    return (bytes / GB).toFixed(bytes < GB ? 2 : 1);
  }

  toggleMenu(id: string, ev: Event): void {
    ev.stopPropagation();
    this.menuFor.update((m) => (m === id ? null : id));
  }

  act(v: SourceView, i: LogInput, action: 'pause' | 'resume', ev: Event): void {
    ev.stopPropagation();
    this.menuFor.set(null);
    this.api.inputAction(v.source.id, i.id, action).subscribe({ next: () => this.refresh(), error: (e) => this.note(i.id, e) });
  }

  async removeInput(v: SourceView, i: LogInput, ev: Event): Promise<void> {
    ev.stopPropagation();
    this.menuFor.set(null);
    const ok = await this.confirm.confirm(`Remove "${i.fileName ?? i.kind}" and its lines from ${v.source.name}? Commented and pinned lines are kept.`, 'Remove input');
    if (ok) this.api.deleteInput(v.source.id, i.id).subscribe({ next: () => this.refresh(), error: (e) => this.note(i.id, e) });
  }

  private note(key: string, e: unknown, text?: string): void {
    const msg = text ?? ((e as { error?: { error?: string } })?.error?.error || 'That did not work');
    this.message.update((m) => ({ ...m, [key]: msg }));
  }

  openSettings(v: SourceView, ev: Event): void {
    ev.stopPropagation();
    this.settings.set({ id: v.source.id, name: v.source.name, gb: +(v.source.retentionMaxBytes / GB).toFixed(1), error: '' });
  }

  saveSettings(): void {
    const s = this.settings();
    if (!s) return;
    if (!s.name.trim() || !(s.gb === 0 || (s.gb >= 0.1 && s.gb <= 500))) {
      this.settings.set({ ...s, error: 'Name is required; the size cap is 0 (keep everything) or 0.1–500 GB.' });
      return;
    }
    this.api.updateSource(s.id, { name: s.name.trim(), retentionMaxBytes: Math.round(s.gb * GB) }).subscribe({
      next: () => {
        this.settings.set(null);
        this.refresh();
      },
      error: (e) => this.settings.set({ ...s, error: (e as { error?: { error?: string } })?.error?.error || 'Could not save' }),
    });
  }

  updateSettings(patch: Partial<{ name: string; gb: number }>): void {
    const s = this.settings();
    if (s) this.settings.set({ ...s, ...patch, error: '' });
  }

  async remove(v: SourceView, ev: Event): Promise<void> {
    ev.stopPropagation();
    this.api.deleteImpact(v.source.id).subscribe(async (impact) => {
      const ok = await this.confirm.confirm(
        `Delete ${v.source.name}? ${impact.lines.toLocaleString('en-US')} lines, ${impact.comments} comments and ${impact.pinned} pinned lines will be removed. This can't be undone.`,
        'Delete source',
      );
      if (ok) this.api.deleteSource(v.source.id).subscribe(() => this.refresh());
    });
  }
}
