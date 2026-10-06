import { DestroyRef, Injectable, Signal, computed, inject, signal } from '@angular/core';
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
const SHOW_CHIPS_KEY = 'alfred.dbCapture.showChips';

function readShowChips(): boolean {
  try {
    return localStorage.getItem(SHOW_CHIPS_KEY) !== '0';
  } catch {
    return true;
  }
}

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
  /** Calls whose summary counts a failed statement - the call lists' "DB failures" pill and filter. */
  readonly failedCallIds: Signal<ReadonlySet<string>> = computed(() =>
    new Set([...this.summariesSignal().values()].filter((s) => s.failedCount > 0).map((s) => s.callId)));

  /** This viewer's choice to show the ◆ DB chip on call cards - a per-browser convenience, not a shared setting. */
  private readonly showChipsSignal = signal(readShowChips());
  readonly showChips = this.showChipsSignal.asReadonly();
  /** The last switch the server refused (e.g. inbound logging is off), shown next to the switch. */
  readonly switchError = signal<string | null>(null);

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
    this.switchError.set(null);
    this.api.setEnabled(project, enabled).subscribe({
      next: (projects) => this.projectsSignal.set(projects),
      error: (e) => this.switchError.set(e?.error?.error ?? 'Could not change database capture.'),
    });
  }

  /** The one switch behind the Sources bar, the cycle widget and Settings. Does nothing while inbound logging is off. */
  toggle(project: string, inboundOn: boolean): void {
    if (!inboundOn) return;
    this.setEnabled(project, !this.projectStatus(project)?.enabled);
  }

  isOn(project: string, inboundOn: boolean): boolean {
    return inboundOn && !!this.projectStatus(project)?.enabled;
  }

  switchTitle(project: string, inboundOn: boolean): string {
    if (!inboundOn) return 'Turn inbound logging on first - statements are attached to inbound calls';
    const status = this.projectStatus(project);
    if (status?.enabled) return 'Database capture is on - click to turn off';
    if (!status?.attached) return `Database capture is off - turning it on waits for the agent (not attached to ${project} yet)`;
    return 'Database capture is off - click to turn on';
  }

  /**
   * The ▤ Logs switch beside ◆ (specs/008-logs-call-link): it rides in the same project list, so the Sources bar, the
   * cycle widget and Settings all read one state. While it is off ALFRED reads none of the project's logs.
   */
  setLogsOn(project: string, on: boolean): void {
    this.switchError.set(null);
    this.api.setLogsOn(project, on).subscribe({
      next: (projects) => this.projectsSignal.set(projects),
      error: (e) => this.switchError.set(e?.error?.error ?? 'Could not change log linking.'),
    });
  }

  toggleLogs(project: string, inboundOn: boolean): void {
    if (!inboundOn) return;
    this.setLogsOn(project, !this.projectStatus(project)?.logsOn);
  }

  logsOn(project: string, inboundOn: boolean): boolean {
    return inboundOn && !!this.projectStatus(project)?.logsOn;
  }

  logsTitle(project: string, inboundOn: boolean): string {
    if (!inboundOn) return 'Turn logging on first - log lines are linked to recorded calls';
    const status = this.projectStatus(project);
    // with the agent attached its lines are caught inside the application (specs/009); without, read from log files (008)
    const from = status?.attached ? 'caught by the agent' : 'from its log files';
    return status?.logsOn
      ? `Logs are linked for ${project}, ${from} - click to stop (Alfred then reads none of its logs)`
      : `Logs are not linked for ${project} - click to link its calls to its log lines (${from})`;
  }

  setShowChips(show: boolean): void {
    this.showChipsSignal.set(show);
    try {
      localStorage.setItem(SHOW_CHIPS_KEY, show ? '1' : '0');
    } catch {
      // private window / blocked storage: the choice simply lasts for this page
    }
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
