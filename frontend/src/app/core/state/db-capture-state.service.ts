import { DestroyRef, Injectable, Signal, inject, signal } from '@angular/core';
import { Observable, Subject, share } from 'rxjs';
import { AppConfigService } from '../services/app-config.service';
import { DbCaptureApiService } from '../services/db-capture-api.service';
import { reconnectingSocket } from './reconnecting-socket';
import { CallDbSummary, DbCaptureSocketEvent, ProjectCaptureStatus } from '../models/db-capture.model';

/**
 * Database capture's shared state: one /ws/db-capture socket, the per-project switches and agent status (the same
 * setting shown in the Sources bar, the cycle widget and Settings), and the ◆ DB chip summaries of the calls on
 * screen. Summaries are fetched in batches: every chip asks in the same frame, one request answers them all. No
 * timers - a change on the socket is what triggers a re-fetch.
 */
@Injectable({ providedIn: 'root' })
export class DbCaptureStateService {
  private readonly api = inject(DbCaptureApiService);
  private readonly config = inject(AppConfigService);

  /** Fires after a reconnect, so open windows refetch what they missed. */
  readonly reconnected$ = new Subject<void>();
  readonly events$: Observable<DbCaptureSocketEvent> = reconnectingSocket<DbCaptureSocketEvent>(
    `${this.config.backendUrl.replace(/^http/, 'ws')}/ws/db-capture`,
    () => this.onReconnect(),
  ).pipe(share());

  private readonly projectsSignal = signal<readonly ProjectCaptureStatus[]>([]);
  readonly projects: Signal<readonly ProjectCaptureStatus[]> = this.projectsSignal.asReadonly();

  private readonly summariesSignal = signal<ReadonlyMap<string, CallDbSummary>>(new Map());
  /** Ids asked for - present in `summaries` once captured; absent there means "not captured". */
  private readonly requested = new Set<string>();
  private readonly queued = new Set<string>();
  private flushScheduled = false;
  readonly summaries: Signal<ReadonlyMap<string, CallDbSummary>> = this.summariesSignal.asReadonly();

  constructor() {
    const subscription = this.events$.subscribe((event) => this.onEvent(event));
    inject(DestroyRef).onDestroy(() => {
      subscription.unsubscribe();
      this.reconnected$.complete();
    });
    this.refreshProjects();
  }

  refreshProjects(): void {
    this.api.projects().subscribe({
      next: (projects) => this.projectsSignal.set(projects),
      // No backend slice yet, or a transient failure: the switches simply stay hidden until the next event.
      error: () => this.projectsSignal.set([]),
    });
  }

  projectStatus(project: string | null | undefined): ProjectCaptureStatus | undefined {
    return project ? this.projectsSignal().find((p) => p.project === project) : undefined;
  }

  setEnabled(project: string, enabled: boolean): void {
    this.api.setEnabled(project, enabled).subscribe((projects) => this.projectsSignal.set(projects));
  }

  /** A chip on screen wants its summary; batched into one request per frame. */
  requestSummary(callId: string): void {
    if (this.requested.has(callId)) return;
    this.requested.add(callId);
    this.enqueue(callId);
  }

  private enqueue(callId: string): void {
    this.queued.add(callId);
    if (this.flushScheduled) return;
    this.flushScheduled = true;
    queueMicrotask(() => this.flush());
  }

  private flush(): void {
    this.flushScheduled = false;
    const ids = [...this.queued];
    this.queued.clear();
    for (let i = 0; i < ids.length; i += 500) {
      const chunk = ids.slice(i, i + 500);
      this.api.summaries(chunk).subscribe({
        next: (found) => {
          const next = new Map(this.summariesSignal());
          for (const id of chunk) {
            const summary = found[id];
            if (summary) next.set(id, summary);
          }
          this.summariesSignal.set(next);
        },
        error: () => undefined,
      });
    }
  }

  private onEvent(event: DbCaptureSocketEvent): void {
    switch (event.type) {
      case 'statements-appended':
        if (event.summaryChanged && this.requested.has(event.callId)) this.enqueue(event.callId);
        break;
      case 'capture-settings-changed':
      case 'agent-status-changed':
        this.refreshProjects();
        break;
      default:
        break;
    }
  }

  private onReconnect(): void {
    this.reconnected$.next();
    this.refreshProjects();
    for (const id of this.requested) this.queued.add(id);
    if (this.queued.size) this.enqueue([...this.queued][0]);
  }
}
