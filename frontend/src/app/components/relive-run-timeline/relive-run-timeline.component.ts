import { DestroyRef, Component, computed, inject, input, output, signal } from '@angular/core';
import { toBlocks } from '../relive-step-tree/relive-step-tree.component';
import { UnexpectedRunCall } from '../../core/state/relive-run.service';
import { PausedCall } from '../../core/models/interception.model';
import { CycleVariable, Run, Step, StepResult, StepState } from '../../shared/utils/relive-types';

type Filter = 'all' | 'running' | 'diff' | 'failed' | 'live' | 'replayed';

export interface TimelineRow {
  readonly step: Step;
  readonly result: StepResult;
  readonly isChild: boolean;
}

const STATE_ICON: Readonly<Record<StepState, readonly [string, string]>> = {
  PENDING: ['rl-pending', ''],
  WAITING: ['rl-waiting', '…'],
  PAUSED: ['rl-paused', '⏸'],
  RUNNING: ['rl-running', '●'],
  REPLAYED: ['rl-running', '●'],
  LIVE: ['rl-running', '●'],
  INTERCEPTED: ['rl-running', '●'],
  COMPLETED: ['rl-ok', '✓'],
  COMPLETED_WITH_DIFFERENCES: ['rl-diff', '!'],
  FAILED: ['rl-fail', '✕'],
  SKIPPED: ['rl-skip', '–'],
  NOT_CALLED: ['rl-notcalled', '·'],
  CANCELLED: ['rl-cancel', '–'],
};

const STATE_PILL: Readonly<Record<StepState, readonly [string, string]>> = {
  PENDING: ['rl-p-wait', 'Pending'],
  WAITING: ['rl-p-wait', 'Waiting'],
  PAUSED: ['rl-p-pause', '⏸ Paused'],
  RUNNING: ['rl-p-cycle', 'Running'],
  REPLAYED: ['rl-p-replay', 'Replaying…'],
  LIVE: ['rl-p-live', 'Live…'],
  INTERCEPTED: ['rl-p-pause', 'Intercepted'],
  COMPLETED: ['rl-p-ok', '✓ Completed'],
  COMPLETED_WITH_DIFFERENCES: ['rl-p-diff', '⚠ Differences'],
  FAILED: ['rl-p-fail', '✕ Failed'],
  SKIPPED: ['rl-p-wait', 'Skipped'],
  NOT_CALLED: ['rl-p-wait', 'Not called'],
  CANCELLED: ['rl-p-wait', 'Cancelled'],
};

const RUNNING_STATES: readonly StepState[] = ['RUNNING', 'REPLAYED', 'LIVE', 'WAITING', 'INTERCEPTED'];
const DONE_STATES: readonly StepState[] = ['COMPLETED', 'COMPLETED_WITH_DIFFERENCES', 'FAILED'];

const RUN_TITLE: Readonly<Record<Run['status'], readonly [string, string]>> = {
  RUNNING: ['rl-p-cycle', '● running'],
  COMPLETED: ['rl-p-ok', '✓ completed'],
  COMPLETED_WITH_DIFFERENCES: ['rl-p-diff', '⚠ completed with differences'],
  FAILED: ['rl-p-fail', '✕ failed'],
  STOPPED: ['rl-p-wait', '■ stopped'],
  INTERRUPTED: ['rl-p-wait', '■ interrupted'],
};

function emptyResult(): StepResult {
  return {
    runId: '',
    stepKey: '',
    attempt: 0,
    state: 'PENDING',
    mode: 'REPLAY',
    attribution: 'UNATTRIBUTED',
    differences: [],
    rulesApplied: [],
    variablesUsed: [],
    variablesProduced: [],
    unexpectedCalls: [],
    pauses: [],
  };
}

/**
 * The run view (FR-030-034; mock.html `runPanel()`/`statePill()`/`stIcon()`/`haltBox()`): header,
 * hold box, filterable step timeline and the run's own variables panel. Pure input/output like
 * `relive-prerun-summary` - it never talks to `ReliveRunService` itself, so the host page owns
 * when to call `continueRun()`/`retryStep()`/`endRun()`/`resume()`.
 */
@Component({
  selector: 'app-relive-run-timeline',
  standalone: true,
  templateUrl: './relive-run-timeline.component.html',
})
export class ReliveRunTimelineComponent {
  private readonly destroyRef = inject(DestroyRef);

  readonly run = input<Run | null>(null);
  readonly steps = input<readonly Step[]>([]);
  readonly results = input<Readonly<Record<string, StepResult>>>({});
  readonly variableDefs = input<readonly CycleVariable[]>([]);
  readonly variables = input<Readonly<Record<string, string>>>({});
  readonly selectedKey = input<string | null>(null);
  readonly unexpectedCalls = input<readonly UnexpectedRunCall[]>([]);
  /** Paused calls the host page already filtered to this run's own request-changed holds
   *  (`relive.runId === run.id && relive.at === 'CHANGED'`) - deciding one is the existing Paused
   *  Calls inspector's job (its release/abort/edit paths are the ones with the actual safety
   *  guarantees), not reimplemented here; this only surfaces that they exist and links out. */
  readonly changedPauses = input<readonly PausedCall[]>([]);

  readonly openPausedCall = output<string>();

  readonly selectStep = output<string>();
  readonly continueRun = output<void>();
  readonly retryHeld = output<void>();
  readonly endRun = output<void>();
  readonly resumeFromStep = output<string>();
  readonly runFromStep = output<string>();
  readonly retryFailedStep = output<string>();

  readonly filter = signal<Filter>('all');
  private readonly revealed = signal<ReadonlySet<string>>(new Set());
  private readonly now = signal(Date.now());

  constructor() {
    const id = setInterval(() => {
      if (this.run()?.status === 'RUNNING') this.now.set(Date.now());
    }, 500);
    this.destroyRef.onDestroy(() => clearInterval(id));
  }

  readonly blocks = computed(() => toBlocks(this.steps()));

  readonly rows = computed<readonly TimelineRow[]>(() => {
    const results = this.results();
    return this.blocks().flatMap((block) => [
      { step: block.parent, result: results[block.parent.key] ?? emptyResult(), isChild: false },
      ...block.children.map((child) => ({ step: child, result: results[child.key] ?? emptyResult(), isChild: true })),
    ]);
  });

  readonly filteredRows = computed<readonly TimelineRow[]>(() => {
    const f = this.filter();
    if (f === 'all') return this.rows();
    if (f === 'running') return this.rows().filter((r) => RUNNING_STATES.includes(r.result.state));
    if (f === 'diff') return this.rows().filter((r) => r.result.state === 'COMPLETED_WITH_DIFFERENCES');
    if (f === 'failed') return this.rows().filter((r) => r.result.state === 'FAILED');
    if (f === 'live') return this.rows().filter((r) => r.isChild && r.result.mode === 'LIVE');
    return this.rows().filter((r) => r.isChild && r.result.mode === 'REPLAY');
  });

  readonly doneCount = computed(() => this.rows().filter((r) => DONE_STATES.includes(r.result.state)).length);
  readonly countedCount = computed(() => this.rows().filter((r) => r.result.state !== 'SKIPPED').length);
  readonly progressPct = computed(() => {
    const counted = this.countedCount();
    return counted ? Math.round((this.doneCount() / counted) * 100) : 0;
  });

  readonly elapsedSeconds = computed(() => {
    const run = this.run();
    if (!run) return 0;
    const started = Date.parse(run.startedAt);
    const end = run.finishedAt ? Date.parse(run.finishedAt) : this.now();
    return Math.max(0, Math.round((end - started) / 1000));
  });

  readonly titlePill = computed<readonly [string, string]>(() => {
    const run = this.run();
    if (!run) return ['rl-p-wait', ''];
    if (run.status === 'RUNNING' && run.hold) return ['rl-p-fail', '■ holding - your call'];
    return RUN_TITLE[run.status];
  });

  setFilter(filter: Filter): void {
    this.filter.set(filter);
  }

  stateIcon(state: StepState): readonly [string, string] {
    return STATE_ICON[state] ?? STATE_ICON.PENDING;
  }

  statePill(state: StepState): readonly [string, string] {
    return STATE_PILL[state] ?? STATE_PILL.PENDING;
  }

  isGlobalRule(row: TimelineRow): boolean {
    return row.result.rulesApplied.some((r) => r.tier === 'GLOBAL');
  }

  unexpectedDifferenceCount(row: TimelineRow): number {
    return row.result.differences.filter((d) => d.kind === 'UNEXPECTED').length;
  }

  /** Whether the run has already ended (a failed row's row-actions only show once it's not still running). */
  isEnded(): boolean {
    const status = this.run()?.status;
    return !!status && status !== 'RUNNING';
  }

  hasLaterRunnableStep(stepKey: string): boolean {
    const rows = this.rows();
    const index = rows.findIndex((r) => r.step.key === stepKey);
    if (index < 0) return false;
    return rows.slice(index + 1).some((r) => !r.isChild && r.step.enabled && ['CANCELLED', 'PENDING'].includes(r.result.state));
  }

  isRevealed(name: string): boolean {
    return this.revealed().has(name);
  }

  reveal(name: string): void {
    this.revealed.set(new Set([...this.revealed(), name]));
  }

  select(key: string): void {
    this.selectStep.emit(key);
  }
}
