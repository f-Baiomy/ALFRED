import { DestroyRef, Injectable, computed, inject, signal } from '@angular/core';
import { TEAM_CONNECTORS, connectorUi } from './connector-ui';
import { TeamApiService } from './team-api.service';
import { ConnectorInfo, TeamConnection, TeamLists, TeamMe, TeamPerson, TeamSocketEvent, TokenStatus } from './team.models';

/**
 * What every Team view shares (specs/028): the connectors, the connections, the one picked, its token (live in the
 * backend's memory, never here), who "me" is, and the filter lists. Bumped versions tell views to fetch again on a
 * /ws/teamboards signal - nothing polls.
 */
@Injectable({ providedIn: 'root' })
export class TeamStateService {
  private readonly api = inject(TeamApiService);
  private readonly uis = inject(TEAM_CONNECTORS, { optional: true });

  readonly connectors = signal<ConnectorInfo[]>([]);
  readonly connections = signal<TeamConnection[]>([]);
  readonly pickedId = signal<string | null>(null);
  readonly loaded = signal(false);
  readonly error = signal<string | null>(null);
  readonly token = signal<TokenStatus | null>(null);
  readonly me = signal<TeamMe | null>(null);
  readonly lists = signal<TeamLists | null>(null);
  readonly upgradeNotice = signal(false);
  /** Bumped on each /ws/teamboards signal, by what changed. */
  readonly listsVersion = signal(0);
  readonly mappingsVersion = signal(0);
  readonly startVersion = signal(0);
  /** Every board-side change (items, sync, cards, incoming, write, rules) - the event itself for who wants its board. */
  readonly boardEvent = signal<TeamSocketEvent | null>(null);
  readonly hookVersion = signal(0);

  readonly picked = computed<TeamConnection | null>(() => this.connections().find((c) => c.id === this.pickedId()) ?? this.connections()[0] ?? null);
  readonly ui = computed(() => connectorUi(this.uis, this.picked()?.kind ?? ''));
  readonly hasToken = computed(() => !!this.token()?.live);

  constructor() {
    const sub = this.api.events$.subscribe((e) => this.on(e));
    const again = this.api.reconnected$.subscribe(() => {
      this.load();
      this.listsVersion.update((v) => v + 1);
    });
    inject(DestroyRef).onDestroy(() => {
      sub.unsubscribe();
      again.unsubscribe();
    });
  }

  private on(e: TeamSocketEvent): void {
    if (e.what === 'connections') return this.load();
    if (e.board || ['items', 'sync', 'cards', 'incoming', 'write', 'rules'].includes(e.what)) {
      this.boardEvent.set(e);
    }
    if (e.conn && e.conn !== this.picked()?.id) return;
    switch (e.what) {
      case 'token':
        this.readToken();
        break;
      case 'me':
        this.readMe();
        break;
      case 'lists':
        this.readLists(false);
        this.listsVersion.update((v) => v + 1);
        break;
      case 'mappings':
        this.mappingsVersion.update((v) => v + 1);
        break;
      case 'start':
        this.startVersion.update((v) => v + 1);
        break;
      case 'hook':
        this.hookVersion.update((v) => v + 1);
        break;
    }
  }

  uiOf(kind: string) {
    return connectorUi(this.uis, kind);
  }

  load(): void {
    this.api.connectors().subscribe({ next: (c) => this.connectors.set(c), error: () => undefined });
    this.api.upgradeNotice().subscribe({ next: (n) => this.upgradeNotice.set(n.show), error: () => undefined });
    this.api.connections().subscribe({
      next: (c) => {
        this.connections.set(c);
        this.loaded.set(true);
        this.error.set(null);
        this.readToken();
        this.readMe();
        this.readLists(true);
      },
      error: (err) => {
        this.loaded.set(true);
        this.error.set(err?.error?.message || 'Could not read the connections');
      },
    });
  }

  pick(id: string): void {
    this.pickedId.set(id);
    this.token.set(null);
    this.me.set(null);
    this.lists.set(null);
    this.readToken();
    this.readMe();
    this.readLists(true);
  }

  readToken(): void {
    const c = this.picked();
    if (!c) return;
    this.api.tokenStatus(c.id).subscribe({ next: (t) => this.picked()?.id === c.id && this.token.set(t), error: () => this.token.set(null) });
  }

  readMe(): void {
    const c = this.picked();
    if (!c) return;
    this.api.me(c.id).subscribe({ next: (m) => this.picked()?.id === c.id && this.me.set(m), error: () => this.me.set(null) });
  }

  /** The cached lists; {@code fresh}: ask for a background read when they are older than 10 minutes (the tab opening). */
  readLists(fresh: boolean): void {
    const c = this.picked();
    if (!c) return;
    this.api.lists(c.id, fresh ? 10 : 100000).subscribe({ next: (l) => this.picked()?.id === c.id && this.lists.set(l), error: () => undefined });
  }

  /** A person by id or unique name from the lists (a pill names them without a lookup). */
  personOf(idOrEmail: string | null | undefined): TeamPerson | null {
    if (!idOrEmail) return null;
    const all = this.lists()?.people ?? [];
    const k = idOrEmail.toLowerCase();
    return all.find((p) => p.extId === idOrEmail || (p.email ?? '').toLowerCase() === k) ?? null;
  }

  dismissUpgrade(): void {
    this.upgradeNotice.set(false);
    this.api.dismissUpgradeNotice().subscribe({ error: () => undefined });
  }
}
