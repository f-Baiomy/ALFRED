import { DecimalPipe } from '@angular/common';
import { Component, DestroyRef, OnInit, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { ConfirmDialogComponent } from '../../components/confirm-dialog/confirm-dialog.component';
import { SessionView } from '../../core/models/logs.model';
import { ConfirmDialogService } from '../../core/services/confirm-dialog.service';
import { LogsApiService } from '../../core/services/logs-api.service';
import { LogsSocketService } from '../../core/services/logs-socket.service';
import { formatLogDateTime } from '../../shared/utils/logs-time';

/** Saved session recordings of one source (/logs/:id/sessions): open, rename, notes, delete. */
@Component({
  selector: 'app-log-sessions-page',
  standalone: true,
  imports: [RouterLink, DecimalPipe, FormsModule, ConfirmDialogComponent],
  template: `
    <div class="lg-page">
      <div class="lg-row">
        <div>
          <h1 class="lg-h1">Sessions · {{ name() }}</h1>
          <div class="lg-sub">Recorded stretches of the live log, kept with their lines, markers and notes. Opening one shows exactly its lines.</div>
        </div>
        <span class="lg-sp"></span>
        <a class="lg-btn sm rec" [routerLink]="['/logs', id]">⏺ Record new</a>
        <a class="lg-btn sm" [routerLink]="['/logs', id]">Explorer</a>
      </div>
      <div class="lg-card" style="padding: 14px 16px; margin-top: 12px">
        <div class="lg-sess lg-faint" style="font-size: 11px; border-top: none; padding-top: 0">
          <span>Name · notes</span><span>When</span><span>Length</span><span>Lines</span><span>Errors</span><span></span>
        </div>
        @for (v of sessions(); track v.session.id) {
          <div class="lg-sess">
            <span>
              @if (editing() === v.session.id) {
                <input type="text" style="width: 100%" [ngModel]="draftName()" (ngModelChange)="draftName.set($event)" aria-label="Session name" />
                <textarea rows="2" style="width: 100%; margin-top: 4px" [ngModel]="draftNotes()" (ngModelChange)="draftNotes.set($event)" placeholder="Notes" aria-label="Notes"></textarea>
              } @else {
                <b>{{ v.session.endedAt === null ? '⏺ ' : '' }}{{ v.session.name }}</b>
                <div class="lg-faint">{{ v.session.notes || describe(v) }}</div>
                @if (v.session.markers.length) {
                  <div style="margin-top: 3px">@for (m of v.session.markers; track $index) { <span class="lg-marker" style="margin: 2px 4px 0 0">⚑ {{ m.text }}</span> }</div>
                }
              }
            </span>
            <span class="lg-dim">{{ when(v.session.startedAt) }}</span>
            <span class="lg-mono">{{ v.session.endedAt === null ? 'recording' : length(v) }}</span>
            <span>{{ v.session.lineCount | number }}</span>
            <span [style.color]="v.session.errorCount ? 'var(--red)' : null">{{ v.session.errorCount | number }}</span>
            <span class="lg-row" style="justify-content: flex-end">
              @if (editing() === v.session.id) {
                <button class="lg-btn xs" (click)="editing.set(null)">Cancel</button>
                <button class="lg-btn xs primary" (click)="save(v)">Save</button>
              } @else {
                <a class="lg-btn xs primary" [routerLink]="['/logs', id]" [queryParams]="{ session: v.session.id }">Open</a>
                <button class="lg-btn xs" (click)="edit(v)">✎</button>
                <button class="lg-btn xs danger" (click)="remove(v)" aria-label="Delete session">✕</button>
              }
            </span>
          </div>
        } @empty {
          <div class="lg-hint" style="padding: 10px 0">No sessions yet. In the explorer, press ⏺ Record session while you reproduce something - reading stays live, and the session keeps its lines.</div>
        }
        @if (error()) { <div class="lg-error-text">{{ error() }}</div> }
      </div>
      <div class="lg-note">Export a session from the explorer after opening it (.json / .md / .html). Deleting a session keeps its lines.</div>
      <app-confirm-dialog />
    </div>
  `,
})
export class LogSessionsPageComponent implements OnInit {
  private readonly api = inject(LogsApiService);
  private readonly socket = inject(LogsSocketService);
  private readonly confirm = inject(ConfirmDialogService);
  private readonly destroyRef = inject(DestroyRef);
  readonly id = inject(ActivatedRoute).snapshot.paramMap.get('id') ?? '';

  readonly name = signal('');
  readonly sessions = signal<SessionView[]>([]);
  readonly editing = signal<string | null>(null);
  readonly draftName = signal('');
  readonly draftNotes = signal('');
  readonly error = signal('');
  private zone = 'UTC';

  ngOnInit(): void {
    this.api.source(this.id).subscribe({ next: (v) => this.name.set(v.source.name), error: () => this.error.set('Source not found') });
    this.api.structure(this.id).subscribe((s) => (this.zone = s.timeZone));
    this.load();
    this.socket.events$.pipe(takeUntilDestroyed(this.destroyRef)).subscribe((e) => {
      if ('sourceId' in e && e.sourceId === this.id && (e.type === 'sessions-changed' || e.type === 'lines-added')) this.load();
    });
  }

  load(): void {
    this.api.sessions(this.id).subscribe((s) => this.sessions.set(s));
  }

  when(ms: number): string {
    return formatLogDateTime(ms, this.zone);
  }

  length(v: SessionView): string {
    const s = Math.round(((v.session.endedAt ?? Date.now()) - v.session.startedAt) / 1000);
    return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
  }

  describe(v: SessionView): string {
    const s = v.session;
    return s.kind === 'ID' ? `only ${s.idField} = ${s.idValue}` : s.pills.length ? `${s.pills.length} filters` : 'every line';
  }

  edit(v: SessionView): void {
    this.editing.set(v.session.id);
    this.draftName.set(v.session.name);
    this.draftNotes.set(v.session.notes);
  }

  save(v: SessionView): void {
    this.api.updateSession(this.id, v.session.id, this.draftName().trim(), this.draftNotes()).subscribe({
      next: () => {
        this.editing.set(null);
        this.load();
      },
      error: (e) => this.error.set((e as { error?: { error?: string } })?.error?.error || 'Could not save'),
    });
  }

  async remove(v: SessionView): Promise<void> {
    const ok = await this.confirm.confirm(`Delete the session "${v.session.name}"? Its lines stay in the source.`, 'Delete session');
    if (ok) this.api.deleteSession(this.id, v.session.id).subscribe(() => this.load());
  }
}
