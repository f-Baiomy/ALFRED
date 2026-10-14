import { DestroyRef, Injectable, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { Observable, Subject, auditTime, tap } from 'rxjs';
import { CycleChatInfo, SkillRun, SkillRunRequest } from '../models/board.models';
import { BoardApiService } from '../services/board-api.service';
import { BoardSocketService } from '../services/board-socket.service';

/** How long a finished run's line stays under its button. */
export const RUN_DONE_SHOWN_MS = 30_000;
/** A run in the chat's watch this long without being taken: the chat is busy with another turn. */
export const CHAT_BUSY_AFTER_MS = 10_000;
const NOTIFY_KEY = 'alfred.board.runNotify';

interface ProjectRuns {
  readonly runs: readonly SkillRun[];
  readonly usualMs: Readonly<Record<string, number>>;
}

/** Waiting for the chat: not yet taken by it. */
export function waiting(r: SkillRun): boolean {
  return r.state === 'QUEUED' || r.state === 'SENT';
}

export function active(r: SkillRun): boolean {
  return waiting(r) || r.state === 'RUNNING';
}

/**
 * Skills run from the board with ▶ (docs/board.md "Run from the board"), shared by every button, the card drawer's run
 * history and the live strip: per cycle, the Claude Code chat that handles it (every ▶ goes into that chat); per
 * project, the runs and how long each skill usually takes. Read when first watched, then on each /ws/board `skill-run`
 * / `cycle-chat` signal and after the socket was away. No polling.
 */
@Injectable({ providedIn: 'root' })
export class SkillRunsStateService {
  private readonly api = inject(BoardApiService);
  private readonly byProject = signal<ReadonlyMap<string, ProjectRuns>>(new Map());
  private readonly byCycle = signal<ReadonlyMap<string, CycleChatInfo & { readonly project: string }>>(new Map());
  private readonly reload$ = new Subject<string>();
  private readonly reloadCycle$ = new Subject<string>();
  private readonly mine = new Set<string>();
  /** Runs this tab started that ended while it was in the background - the title badge. */
  readonly unseen = signal(0);
  readonly notify = signal(read(NOTIFY_KEY) === '1');
  private readonly baseTitle = typeof document === 'undefined' ? '' : document.title;

  readonly projects = computed(() => this.byProject());
  readonly cycles = computed(() => this.byCycle());

  constructor() {
    const socket = inject(BoardSocketService);
    const destroyRef = inject(DestroyRef);
    const debounced = (source: Subject<string>, load: (key: string) => void) => {
      const loaders = new Map<string, Subject<void>>();
      source.pipe(takeUntilDestroyed(destroyRef)).subscribe((key) => {
        let s = loaders.get(key);
        if (!s) {
          s = new Subject<void>();
          loaders.set(key, s);
          s.pipe(auditTime(150), takeUntilDestroyed(destroyRef)).subscribe(() => load(key));
        }
        s.next();
      });
    };
    debounced(this.reload$, (p) => this.load(p));
    debounced(this.reloadCycle$, (c) => this.loadCycle(c));
    socket.events$.pipe(takeUntilDestroyed(destroyRef)).subscribe((e) => {
      if (e.type === 'skill-run' && this.byProject().has(e.project)) this.reload$.next(e.project);
      if (e.type === 'cycle-chat' && this.byCycle().has(e.cycleId)) {
        this.reloadCycle$.next(e.cycleId);
        if (this.byProject().has(e.project)) this.reload$.next(e.project); // runs of a stopped chat read as lost
      }
    });
    socket.reconnected$.pipe(takeUntilDestroyed(destroyRef)).subscribe(() => {
      for (const p of this.byProject().keys()) this.reload$.next(p);
      for (const c of this.byCycle().keys()) this.reloadCycle$.next(c);
    });
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', () => { if (!document.hidden) this.clearBadge(); });
    }
  }

  /** Starts keeping a project's runs current (idempotent). */
  watch(project: string): void {
    if (this.byProject().has(project)) return;
    this.set(project, { runs: [], usualMs: {} });
    this.load(project);
  }

  /** Starts keeping a cycle's chat current (idempotent). */
  watchCycle(project: string, cycleId: string | null): void {
    if (!cycleId || this.byCycle().has(cycleId)) return;
    this.setCycle(cycleId, { project, chat: null, lastCwd: null });
    this.loadCycle(cycleId);
  }

  private load(project: string): void {
    const before = this.byProject().get(project);
    this.api.skillRuns(project).subscribe({
      next: (page) => {
        this.set(project, { runs: page.runs, usualMs: page.usualMs ?? {} });
        this.noticeEnded(before?.runs ?? [], page.runs);
      },
      error: () => undefined,
    });
  }

  private loadCycle(cycleId: string): void {
    const project = this.byCycle().get(cycleId)?.project ?? '';
    this.api.cycleChat(cycleId, project).subscribe({
      next: (info) => this.setCycle(cycleId, { project, chat: info?.chat ?? null, lastCwd: info?.lastCwd ?? null }),
      error: () => this.setCycle(cycleId, { project, chat: null, lastCwd: null }),
    });
  }

  private set(project: string, v: ProjectRuns): void {
    const next = new Map(this.byProject());
    next.set(project, v);
    this.byProject.set(next);
  }

  private setCycle(cycleId: string, v: CycleChatInfo & { readonly project: string }): void {
    const next = new Map(this.byCycle());
    next.set(cycleId, v);
    this.byCycle.set(next);
  }

  /** The chat that handles this cycle, or null. */
  chat(cycleId: string | null): CycleChatInfo['chat'] {
    return cycleId ? this.byCycle().get(cycleId)?.chat ?? null : null;
  }

  /** Where the project's last chat ran - the "cd" of the start steps. */
  lastCwd(cycleId: string | null): string | null {
    return cycleId ? this.byCycle().get(cycleId)?.lastCwd ?? null : null;
  }

  usual(project: string, skill: string): number | null {
    return this.byProject().get(project)?.usualMs[skill] ?? null;
  }

  runs(project: string): readonly SkillRun[] {
    return this.byProject().get(project)?.runs ?? [];
  }

  /** Waiting and running runs of a project (one cycle's, when given), oldest first - the live strip's line and a run's place. */
  active(project: string, cycleId?: string | null): SkillRun[] {
    return this.runs(project).filter((r) => active(r) && (cycleId == null || r.cycleId === cycleId))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  /** A waiting run's place among the runs waiting for the same chat (1 = next). */
  place(r: SkillRun): number {
    return this.active(r.project, r.cycleId).filter(waiting).findIndex((x) => x.id === r.id) + 1;
  }

  /** The run a button shows: the active one for this card (or this command, for a card-less button), else the latest. */
  latest(project: string, cardNumber: number | null, command: string): SkillRun | null {
    const mine = this.runs(project).filter((r) => (cardNumber != null ? r.cardNumber === cardNumber : r.cardNumber == null && r.command === command));
    return mine.find(active) ?? mine[0] ?? null;
  }

  /** One card's run history, newest first. */
  history(project: string, cardNumber: number): SkillRun[] {
    return this.runs(project).filter((r) => r.cardNumber === cardNumber);
  }

  run(request: SkillRunRequest): Observable<SkillRun> {
    this.watch(request.project);
    return this.api.requestSkillRun(request).pipe(tap((r) => {
      this.mine.add(r.id);
      this.put(r);
      if (this.notify() && typeof Notification !== 'undefined' && Notification.permission === 'default') Notification.requestPermission().catch(() => undefined);
    }));
  }

  /** Cancels a run the chat has not taken yet. */
  stop(r: SkillRun): void {
    this.api.stopSkillRun(r.id).subscribe({ next: (x) => this.put(x), error: () => this.reload$.next(r.project) });
  }

  /** Cancels every run of the project the chat has not taken yet. */
  stopAll(project: string): void {
    this.api.stopAllSkillRuns(project).subscribe({ next: () => this.reload$.next(project), error: () => this.reload$.next(project) });
  }

  private put(r: SkillRun): void {
    const now = this.byProject().get(r.project) ?? { runs: [], usualMs: {} };
    this.set(r.project, { ...now, runs: [r, ...now.runs.filter((x) => x.id !== r.id)] });
  }

  setNotify(on: boolean): void {
    this.notify.set(on);
    write(NOTIFY_KEY, on ? '1' : '0');
    if (on && typeof Notification !== 'undefined' && Notification.permission === 'default') Notification.requestPermission().catch(() => undefined);
  }

  /** A run this tab started ended while the tab is in the background: a badge in the title, and a notice when allowed. */
  private noticeEnded(before: readonly SkillRun[], after: readonly SkillRun[]): void {
    if (typeof document === 'undefined') return;
    for (const r of after) {
      const was = before.find((x) => x.id === r.id);
      if (!this.mine.has(r.id) || !was || !active(was) || active(r)) continue;
      this.mine.delete(r.id);
      if (!document.hidden) continue;
      this.unseen.update((n) => n + 1);
      document.title = `(${r.state === 'DONE' ? '✓' : '✕'}${this.unseen()}) ${this.baseTitle}`;
      if (this.notify() && typeof Notification !== 'undefined' && Notification.permission === 'granted') {
        try {
          new Notification(`✦ ${r.command} ${r.state === 'DONE' ? 'done' : r.state.toLowerCase()}`, { body: r.outcome ?? '', tag: r.id });
        } catch { /* not allowed here */ }
      }
    }
  }

  private clearBadge(): void {
    if (!this.unseen()) return;
    this.unseen.set(0);
    document.title = this.baseTitle;
  }
}

function read(key: string): string | null {
  try { return localStorage.getItem(key); } catch { return null; }
}

function write(key: string, value: string): void {
  try { localStorage.setItem(key, value); } catch { /* private mode */ }
}

/** For specs that render a board card, the drawer or the strip without a backend: no chat, no runs - the buttons copy. */
export const NO_SKILL_RUNS = {
  provide: SkillRunsStateService,
  useValue: {
    projects: signal(new Map()), cycles: signal(new Map()), unseen: signal(0), notify: signal(false),
    watch: () => undefined, watchCycle: () => undefined, chat: () => null, lastCwd: () => null, usual: () => null, runs: () => [],
    active: () => [], place: () => 0, latest: () => null, history: () => [], stop: () => undefined, stopAll: () => undefined, setNotify: () => undefined,
  } as unknown as SkillRunsStateService,
};
