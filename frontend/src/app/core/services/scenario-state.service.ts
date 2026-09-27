import { Injectable, inject, signal } from '@angular/core';
import { AppConfigService } from './app-config.service';
import { ScenarioApiService } from './scenario-api.service';
import { reconnectingSocket } from '../state/reconnecting-socket';
import { Scenario } from '../../shared/utils/scenario-types';

/**
 * The scenario library's list state: fetched on demand (load()), refetched whenever
 * `/ws/scenarios` says "scenarios-changed" - no polling anywhere in this app, see
 * docs/frontend-architecture.md. Root-provided so the toolbar (inside the resend dialog) and the
 * library component (wherever it's opened from) share one fetch.
 */
@Injectable({ providedIn: 'root' })
export class ScenarioStateService {
  private readonly api = inject(ScenarioApiService);
  private readonly config = inject(AppConfigService);

  readonly scenarios = signal<readonly Scenario[]>([]);
  readonly loaded = signal(false);
  readonly loading = signal(false);
  readonly error = signal('');

  private watched = false;

  load(): void {
    if (this.loaded() || this.loading()) return;
    this.fetch();
  }

  refresh(): void {
    this.fetch();
  }

  private fetch(): void {
    this.loading.set(true);
    this.api.list().subscribe({
      next: (scenarios) => {
        this.scenarios.set(scenarios);
        this.loaded.set(true);
        this.loading.set(false);
        this.error.set('');
      },
      error: () => {
        this.loading.set(false);
        this.error.set('Could not load scenarios.');
      },
    });
  }

  /** One subscription for the app's lifetime - see GlobalVariablesService.watchForChanges for the same pattern. */
  watchForChanges(): void {
    if (this.watched) return;
    this.watched = true;
    reconnectingSocket<{ type: string }>(`${this.config.backendUrl.replace(/^http/, 'ws')}/ws/scenarios`).subscribe((msg) => {
      if (msg?.type === 'scenarios-changed') this.refresh();
    });
  }

  remove(id: string): void {
    this.api.delete(id).subscribe(() => this.refresh());
  }
}
