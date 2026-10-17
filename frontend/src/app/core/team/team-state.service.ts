import { DestroyRef, Injectable, computed, inject, signal } from '@angular/core';
import { TEAM_CONNECTORS, connectorUi } from './connector-ui';
import { TeamApiService } from './team-api.service';
import { TeamTokenStore } from './team-token.store';
import { ConnectorInfo, TeamConnection } from './team.models';

/** What every Team view shares: the connectors, the connections, the one picked, and its token state. */
@Injectable({ providedIn: 'root' })
export class TeamStateService {
  private readonly api = inject(TeamApiService);
  readonly tokens = inject(TeamTokenStore);
  private readonly uis = inject(TEAM_CONNECTORS, { optional: true });

  readonly connectors = signal<ConnectorInfo[]>([]);
  readonly connections = signal<TeamConnection[]>([]);
  readonly pickedId = signal<string | null>(null);
  readonly loaded = signal(false);
  readonly error = signal<string | null>(null);
  /** Bumped on each /ws/teamboards signal for the picked connection, by what changed. */
  readonly itemsVersion = signal(0);
  readonly changesVersion = signal(0);
  readonly squadsVersion = signal(0);
  /** Bumped when a start, cancel, link or seen changed an item's board state. */
  readonly startVersion = signal(0);

  readonly picked = computed<TeamConnection | null>(() => this.connections().find((c) => c.id === this.pickedId()) ?? this.connections()[0] ?? null);
  readonly ui = computed(() => connectorUi(this.uis, this.picked()?.kind ?? ''));
  readonly hasToken = computed(() => {
    const c = this.picked();
    return !!c && this.tokens.has(c.id);
  });

  constructor() {
    const sub = this.api.events$.subscribe((e) => {
      if (e.what === 'connections') return this.load();
      if (e.conn && e.conn !== this.picked()?.id) return;
      if (e.what === 'items') {
        this.itemsVersion.update((v) => v + 1);
        this.load();
      }
      if (e.what === 'changes') {
        this.changesVersion.update((v) => v + 1);
        this.load();
      }
      if (e.what === 'squads' || e.what === 'mappings') this.squadsVersion.update((v) => v + 1);
      if (e.what === 'start') this.startVersion.update((v) => v + 1);
    });
    const again = this.api.reconnected$.subscribe(() => {
      this.load();
      this.itemsVersion.update((v) => v + 1);
      this.changesVersion.update((v) => v + 1);
    });
    inject(DestroyRef).onDestroy(() => {
      sub.unsubscribe();
      again.unsubscribe();
    });
  }

  uiOf(kind: string) {
    return connectorUi(this.uis, kind);
  }

  load(): void {
    this.api.connectors().subscribe({ next: (c) => this.connectors.set(c), error: () => undefined });
    this.api.connections().subscribe({
      next: (c) => {
        this.connections.set(c);
        this.loaded.set(true);
        this.error.set(null);
      },
      error: (e) => {
        this.loaded.set(true);
        this.error.set(e?.error?.message || 'Could not read the connections');
      },
    });
  }

  pick(id: string): void {
    this.pickedId.set(id);
  }
}
