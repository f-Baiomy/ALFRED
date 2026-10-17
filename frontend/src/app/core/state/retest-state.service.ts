import { DestroyRef, Injectable, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { Subject, auditTime, catchError, filter, forkJoin, of } from 'rxjs';
import { RetestCheck, RetestReport } from '../models/board.models';
import { BoardApiService } from '../services/board-api.service';
import { BoardNotifyService } from '../services/board-notify.service';
import { BoardSocketService } from '../services/board-socket.service';
import { SessionCyclesApiService } from '../services/session-cycles-api.service';
import { messageOf } from './board-state.service';

/** A one-click re-test recording (specs/016 FR-5): the cycle it records into and the cards it is for. */
export interface RetestRecording {
  readonly project: string;
  readonly cycleId: string;
  readonly name: string;
  readonly numbers: readonly number[];
  readonly startedAt: string;
}

/** One line of the recording strip: a step (shared by one or more cards) and whether its call was seen. */
export interface RecordingStep {
  readonly text: string;
  readonly numbers: readonly number[];
  readonly seen: boolean;
  readonly calls: number;
}

const RECORDING_KEY = 'alfred.board.retest-recording';
const LATER_KEY = 'alfred.board.retest-later';

/**
 * One board's re-test state (specs/016): each Fixed card's check against the live calls since its fix, the guards on
 * Verified / Done cards, when the app last started, the one-click re-test recording and the last report. Provided per
 * board view. Fetch-on-demand: re-read on a /ws/board "retest" or card signal for this project - the backend signals a
 * card when a call to its endpoint finishes - never on a timer.
 */
@Injectable()
export class RetestStateService {
  private readonly api = inject(BoardApiService);
  private readonly cycles = inject(SessionCyclesApiService);
  private readonly socket = inject(BoardSocketService);
  private readonly notify = inject(BoardNotifyService);
  private readonly refresh$ = new Subject<void>();

  readonly project = signal<string | null>(null);
  readonly checks = signal<readonly RetestCheck[]>([]);
  readonly guards = signal<readonly RetestCheck[]>([]);
  readonly lastStart = signal<string | null>(null);
  readonly recording = signal<RetestRecording | null>(null);
  /** The recording's checks (its calls only), for the steps on the strip. */
  readonly recordingChecks = signal<readonly RetestCheck[]>([]);
  readonly report = signal<RetestReport | null>(null);
  readonly busy = signal(false);
  readonly error = signal<string | null>(null);
  /** The new-build banner was put off for this app start. */
  readonly laterFor = signal<string | null>(readLater());

  /** Each card's chip, by number: its Fixed check or its guard. */
  readonly byNumber = computed(() => {
    const map = new Map<number, RetestCheck>();
    for (const g of this.guards()) map.set(g.number, g);
    for (const c of this.checks()) map.set(c.number, c);
    return map;
  });
  readonly newBuildCards = computed(() => this.checks().filter((c) => c.newBuild));
  readonly showNewBuild = computed(() => this.newBuildCards().length > 0 && !!this.lastStart() && this.laterFor() !== this.lastStart());
  /** The steps of the recording's cards, merged (a step two cards share shows once), each with whether it was seen. */
  readonly recordingSteps = computed<readonly RecordingStep[]>(() => {
    const steps = new Map<string, { text: string; numbers: number[]; seen: boolean; calls: number }>();
    for (const c of this.recordingChecks()) {
      for (const s of c.steps) {
        const key = `${s.text.toLowerCase()}|${s.endpoint ?? ''}`;
        const at = steps.get(key);
        if (at) {
          at.numbers.push(c.number);
          at.seen = at.seen && s.seen;
        } else {
          steps.set(key, { text: s.text, numbers: [c.number], seen: s.seen, calls: s.calls });
        }
      }
      if (!c.steps.length) {
        steps.set(`#${c.number}`, { text: `Make the call of #${c.number} - ${c.title}`, numbers: [c.number], seen: c.calls.length > 0, calls: c.calls.length });
      }
    }
    return [...steps.values()];
  });

  constructor() {
    const destroyRef = inject(DestroyRef);
    this.refresh$.pipe(auditTime(400), takeUntilDestroyed(destroyRef)).subscribe(() => this.load());
    this.socket.events$.pipe(
      filter((e) => e.type === 'board-changed' && (e.what === 'retest' || e.what === 'card')
        && (e.project === undefined || e.project === null || e.project === this.project())),
      takeUntilDestroyed(destroyRef),
    ).subscribe(() => this.refresh$.next());
    this.socket.reconnected$.pipe(takeUntilDestroyed(destroyRef)).subscribe(() => this.refresh$.next());
  }

  show(project: string): void {
    this.project.set(project);
    const rec = readRecording();
    this.recording.set(rec && rec.project === project ? rec : null);
    this.refresh$.next();
  }

  refresh(): void {
    this.refresh$.next();
  }

  private load(): void {
    const project = this.project();
    if (project === null) return;
    const rec = this.recording();
    const none = { checks: [] as RetestCheck[], lastStart: null as string | null };
    forkJoin({
      fixed: this.api.retestChecks(project).pipe(catchError(() => of(none))),
      guards: this.api.retestGuards(project).pipe(catchError(() => of([] as RetestCheck[]))),
      recorded: rec ? this.api.retestChecks(project, rec.numbers, rec.cycleId).pipe(catchError(() => of(none))) : of(null),
    }).subscribe(({ fixed, guards, recorded }) => {
      const before = this.lastStart();
      this.checks.set(fixed.checks);
      this.guards.set(guards);
      this.lastStart.set(fixed.lastStart);
      if (recorded) this.recordingChecks.set(recorded.checks);
      const ready = fixed.checks.filter((c) => c.newBuild);
      if (fixed.lastStart && before && fixed.lastStart !== before && ready.length) {
        this.notify.notifyText(`Alfred · new build of ${project || 'the app'}`,
          `${ready.length} Fixed ${ready.length === 1 ? 'card is' : 'cards are'} ready to re-test`, `alfred-build-${project}`);
      }
    });
  }

  /** ▶ Re-test: records a cycle named after the cards, so the steps tick as their calls arrive (FR-5). */
  start(numbers: readonly number[]): void {
    const project = this.project();
    if (project === null || !numbers.length || this.busy()) return;
    const name = `Re-test ${numbers.map((n) => `#${n}`).join(' ')}`;
    this.busy.set(true);
    this.error.set(null);
    this.cycles.create({ name }).subscribe({
      next: (cycle) => this.cycles.startRecording(cycle.id).subscribe({
        next: () => {
          const rec: RetestRecording = { project, cycleId: cycle.id, name, numbers: [...numbers], startedAt: new Date().toISOString() };
          this.recording.set(rec);
          writeRecording(rec);
          this.recordingChecks.set([]);
          this.busy.set(false);
          this.refresh$.next();
        },
        complete: () => this.busy.set(false),
        error: (e) => this.failed(e),
      }),
      error: (e) => this.failed(e),
    });
  }

  /** ■ Stop and check: the recording stops and its cards are re-tested against what it captured, kept in their history. */
  stopAndCheck(): void {
    const rec = this.recording();
    if (!rec || this.busy()) return;
    this.busy.set(true);
    this.cycles.pauseRecording(rec.cycleId).pipe(catchError(() => of(null))).subscribe(() => {
      this.api.retestRun(rec.project, rec.numbers, rec.cycleId).subscribe({
        next: (report) => {
          this.report.set(report);
          this.recording.set(null);
          writeRecording(null);
          this.busy.set(false);
          this.refresh$.next();
        },
        error: (e) => this.failed(e),
      });
    });
  }

  /** Cancel: the recording stops; nothing is checked. */
  cancel(): void {
    const rec = this.recording();
    if (!rec) return;
    this.cycles.pauseRecording(rec.cycleId).pipe(catchError(() => of(null))).subscribe();
    this.recording.set(null);
    writeRecording(null);
  }

  /** Re-tests now from the live calls (no recording) and keeps it in each card's history; the report opens. */
  checkNow(numbers: readonly number[]): void {
    const project = this.project();
    if (project === null || this.busy()) return;
    this.busy.set(true);
    this.api.retestRun(project, numbers, null).subscribe({
      next: (report) => {
        this.report.set(report);
        this.busy.set(false);
      },
      error: (e) => this.failed(e),
    });
  }

  later(): void {
    const at = this.lastStart();
    this.laterFor.set(at);
    try {
      if (at) localStorage.setItem(LATER_KEY, at);
    } catch {
      // per-viewer convenience only
    }
  }

  private failed(e: unknown): void {
    this.busy.set(false);
    this.error.set(messageOf(e));
  }
}

function readRecording(): RetestRecording | null {
  try {
    const raw = localStorage.getItem(RECORDING_KEY);
    return raw ? (JSON.parse(raw) as RetestRecording) : null;
  } catch {
    return null;
  }
}

function writeRecording(rec: RetestRecording | null): void {
  try {
    if (rec) localStorage.setItem(RECORDING_KEY, JSON.stringify(rec));
    else localStorage.removeItem(RECORDING_KEY);
  } catch {
    // per-viewer convenience only: the cycle itself is recorded either way
  }
}

function readLater(): string | null {
  try {
    return localStorage.getItem(LATER_KEY);
  } catch {
    return null;
  }
}
