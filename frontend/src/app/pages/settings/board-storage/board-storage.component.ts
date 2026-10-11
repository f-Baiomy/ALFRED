import { Component, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
import { BoardStorage } from '../../../core/models/board.models';
import { BoardApiService } from '../../../core/services/board-api.service';
import { messageOf } from '../../../core/state/board-state.service';
import { formatBytes } from '../../../shared/utils/storage-budget';

/**
 * Settings -> Storage -> Board: board.db's size, what its data uses, and the free space deleted cycles and cards left
 * inside it (SQLite reuses it but only gives it back to the disk on VACUUM), with Compact.
 */
@Component({
  selector: 'app-board-storage',
  standalone: true,
  template: `
    <section class="panel settings-panel board-storage">
      <h3>Board <span class="sub">board.db</span></h3>
      @if (s(); as st) {
        <table class="board-storage-table">
          <tr><td>File on disk</td><td><b>{{ fmt(st.fileBytes) }}</b></td></tr>
          <tr><td>Used by data</td><td>{{ fmt(st.usedBytes) }}</td></tr>
          <tr><td>Free space inside (from deleted cycles and cards)</td><td [class.warn]="st.freeBytes > 1048576">{{ fmt(st.freeBytes) }}</td></tr>
          <tr class="dim"><td>Cards · comments · spec files · briefs</td><td>{{ st.cards }} · {{ st.comments }} · {{ st.specFiles }} · {{ st.briefs }}</td></tr>
          <tr class="dim"><td>Cards whose cycle was deleted</td>
            <td>{{ st.cardsOfDeletedCycles }} @if (st.cardsOfDeletedCycles) { <button type="button" class="board-link" (click)="show()">show</button> }</td></tr>
        </table>
        <div class="board-storage-acts">
          <button type="button" class="bulk-btn" [disabled]="busy() || st.freeBytes === 0" (click)="compact()">
            {{ busy() ? 'Compacting…' : 'Compact (reclaim ' + fmt(st.freeBytes) + ')' }}</button>
          <span class="sub">rewrites board.db without its free space - a few seconds; the board waits</span>
        </div>
      } @else if (!error()) {
        <p class="sub">Measuring…</p>
      }
      @if (done()) { <p class="board-storage-done">✓ {{ done() }}</p> }
      @if (error()) { <p class="board-error">{{ error() }}</p> }
    </section>`,
})
export class BoardStorageComponent {
  private readonly api = inject(BoardApiService);
  private readonly router = inject(Router);
  readonly s = signal<BoardStorage | null>(null);
  readonly busy = signal(false);
  readonly done = signal<string | null>(null);
  readonly error = signal<string | null>(null);

  constructor() {
    this.load();
  }

  load(): void {
    this.api.storage().subscribe({ next: (s) => this.s.set(s), error: (e) => this.error.set(messageOf(e)) });
  }

  fmt(bytes: number): string {
    return formatBytes(bytes);
  }

  compact(): void {
    this.busy.set(true);
    this.done.set(null);
    this.error.set(null);
    this.api.compact().subscribe({
      next: (r) => {
        this.busy.set(false);
        this.s.set(r.after);
        this.done.set(`Compacted · ${formatBytes(r.before.fileBytes)} → ${formatBytes(r.after.fileBytes)}`);
      },
      error: (e) => {
        this.busy.set(false);
        this.error.set(messageOf(e));
      },
    });
  }

  /** The Board tab with the "cycle deleted" filter - where the leftover cards are cleaned up. */
  show(): void {
    void this.router.navigate(['/board'], { queryParams: { cycleDeleted: 1 } });
  }
}
