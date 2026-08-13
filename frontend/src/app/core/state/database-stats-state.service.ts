import { Injectable, inject, signal } from '@angular/core';
import { Observable, tap } from 'rxjs';
import { DatabaseStatsApiService } from '../services/database-stats-api.service';
import { DatabaseStatsResponse } from '../models/database-stats.model';

/**
 * Facade for the Settings page's Database tab - fetched once when the tab is first opened
 * (loadIfNeeded), and again after either clear action succeeds. No WebSocket: unlike the list
 * pages, nothing else pushes a change to these stats in real time, so a manual refresh after a
 * mutation is enough.
 */
@Injectable({ providedIn: 'root' })
export class DatabaseStatsStateService {
  private readonly api = inject(DatabaseStatsApiService);

  private readonly statsSignal = signal<DatabaseStatsResponse | null>(null);
  private readonly loadingSignal = signal(false);

  readonly stats = this.statsSignal.asReadonly();
  readonly loading = this.loadingSignal.asReadonly();

  loadIfNeeded(): void {
    if (this.statsSignal() !== null || this.loadingSignal()) return;
    this.refresh();
  }

  refresh(): void {
    this.loadingSignal.set(true);
    this.api.getStats().subscribe({
      next: (stats) => {
        this.statsSignal.set(stats);
        this.loadingSignal.set(false);
      },
      error: () => this.loadingSignal.set(false),
    });
  }

  clearCalls(): Observable<void> {
    return this.api.clearCalls().pipe(tap(() => this.refresh()));
  }

  clearCycles(): Observable<void> {
    return this.api.clearCycles().pipe(tap(() => this.refresh()));
  }
}
