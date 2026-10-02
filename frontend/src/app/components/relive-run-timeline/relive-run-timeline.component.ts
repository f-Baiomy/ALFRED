import { DestroyRef, Component, ElementRef, computed, effect, inject, input, output, signal } from '@angular/core';
import { toBlocks } from '../relive-step-tree/relive-step-tree.component';
import { ReliveStepCallComponent } from '../relive-step-call/relive-step-call.component';
import { UnexpectedRunCall } from '../../core/state/relive-run.service';
import { PauseDecision, PausedCall } from '../../core/models/interception.model';
import { maskRelive } from '../../shared/utils/relive-mask';
import { isCollapsedResponseDifference, listResponseDifferences } from '../../shared/utils/relive-canonical-body';
import { displayedState, explainStep, formatReasonDetail, StepReason, wholeDocumentCheckNote } from '../../shared/utils/relive-outcome';
import { CycleVariable, DifferenceEntry, NoiseRule, Run, Step, StepResult, StepState } from '../../shared/utils/relive-types';

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

const PLAIN_VAR_TOKEN = /\{\{([A-Za-z_][A-Za-z0-9_]*)\}\}/g;
const DIFF_PREVIEW_LIMIT = 3;
const DIFF_VALUE_LIMIT = 72;
const DIFF_POPUP_LIMIT = 80;

interface ShownDifference {
  readonly path: string;
  readonly recorded: string | null;
  readonly actual: string | null;
  readonly part?: string;
  readonly kind?: DifferenceEntry['kind'];
  readonly cause?: string | null;
}

/** "Ignore this field" / "Count it" / "Un-ignore" from a step's differences (FR-041b/c). */
export interface NoiseChange {
  readonly stepKey: string;
  readonly rule: NoiseRule;
  readonly scope: 'STEP' | 'CYCLE';
  readonly remove: boolean;
}

interface DifferencePopup {
  readonly stepKey: string;
  readonly expected: readonly ShownDifference[];
  readonly noise: readonly ShownDifference[];
  readonly label: string;
  readonly headline: string | null;
  readonly note: string | null;
  readonly rows: readonly ShownDifference[];
  readonly more: number;
}

/** Every `{{name}}` a step's call rule actions reference - the only place a step's request/response
 *  overrides live (its frozen `recording` never contains one). */
function variableTokensIn(step: Step): string[] {
  const text = JSON.stringify(step.callRule.actions ?? []);
  return [...new Set([...text.matchAll(PLAIN_VAR_TOKEN)].map((m) => m[1]))];
}

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
  imports: [ReliveStepCallComponent],
  templateUrl: './relive-run-timeline.component.html',
})
export class ReliveRunTimelineComponent {
  private readonly destroyRef = inject(DestroyRef);
  private readonly host = inject(ElementRef<HTMLElement>);

  readonly run = input<Run | null>(null);
  readonly steps = input<readonly Step[]>([]);
  readonly results = input<Readonly<Record<string, StepResult>>>({});
  readonly variableDefs = input<readonly CycleVariable[]>([]);
  readonly variables = input<Readonly<Record<string, string>>>({});
  readonly selectedKey = input<string | null>(null);
  readonly unexpectedCalls = input<readonly UnexpectedRunCall[]>([]);
  /** Calls of this run held in the proxy (`relive.runId === run.id`): a request that changed from
   *  the recording ("Ask me", `at: 'CHANGED'`) or a child's checkpoint (`BEFORE`/`AFTER`). They are
   *  decided here (FR-035e, FR-014d); the proxy applies the choice (relive.settle_request_pause). */
  readonly changedPauses = input<readonly PausedCall[]>([]);
  readonly decidePaused = output<{ readonly callId: string; readonly decision: PauseDecision }>();
  /** The held call whose answer is being edited ("Edit answer & replay"), and the call whose
   *  "Send to real" is armed behind its second confirmation. */
  readonly editingAnswer = signal<{ readonly callId: string; readonly status: number; readonly body: string } | null>(null);
  readonly armedSendReal = signal<string | null>(null);
  /** An inbound step's own checkpoint, paused in the tab itself - not held in the proxy (research
   *  D11; see `ReliveRunService.pause`/`resolveCheckpoint`). Null when nothing is paused this way. */
  readonly pause = input<{ readonly stepKey: string; readonly at: 'BEFORE' | 'AFTER' } | null>(null);
  /** The live timeline wires Retry / Continue / End. A history snapshot does not, so it leaves this off
   *  and keeps only the banner at the top. */
  readonly pinnedDecision = input(false);

  readonly checkpointContinue = output<void>();
  readonly checkpointReplay = output<void>();
  readonly checkpointSkip = output<void>();
  /** "Edit" (before) / "Edit & replay" (after) at an inbound checkpoint (FR-035b/c). */
  readonly checkpointEdit = output<{ readonly body: string; readonly saveToCycle: boolean }>();
  readonly editingCheckpoint = signal<{ body: string; saveToCycle: boolean } | null>(null);
  readonly stopRun = output<void>();

  readonly selectStep = output<string>();
  readonly continueRun = output<void>();
  readonly retryHeld = output<void>();
  readonly endRun = output<void>();
  /** "End run" for the Guided driver (T077) - distinct from `endRun` above, which only ever fires
   *  from a hold (there is none in Guided; the run just stops waiting for the next call). */
  readonly endGuidedRun = output<void>();
  readonly resumeFromStep = output<string>();
  readonly runFromStep = output<string>();
  readonly retryFailedStep = output<string>();
  readonly noiseChange = output<NoiseChange>();
  /** Fields marked in this view; they count from the next comparison (FR-041b). */
  readonly markedFields = signal<ReadonlySet<string>>(new Set());

  ignoreField(stepKey: string, diff: ShownDifference, scope: 'STEP' | 'CYCLE'): void {
    this.noiseChange.emit({ stepKey, scope, remove: false, rule: { part: noisePart(diff.part), path: diff.path, auto: false, count: false } });
    this.markedFields.set(new Set([...this.markedFields(), `${stepKey}|${diff.path}`]));
  }

  /** Overrides an automatic noise decision (FR-041c), or takes back a user's own "ignore". */
  countField(stepKey: string, diff: ShownDifference): void {
    const user = diff.kind === 'NOISE_USER';
    this.noiseChange.emit({ stepKey, scope: 'STEP', remove: user, rule: { part: noisePart(diff.part), path: diff.path, auto: false, count: !user } });
    this.markedFields.set(new Set([...this.markedFields(), `${stepKey}|${diff.path}`]));
  }

  isMarked(stepKey: string, path: string): boolean {
    return this.markedFields().has(`${stepKey}|${path}`);
  }

  readonly filter = signal<Filter>('all');
  /** The row whose call card is open. The live run and a history snapshot share this timeline, so either click opens the same card. */
  readonly detailKey = signal<string | null>(null);
  private readonly revealed = signal<ReadonlySet<string>>(new Set());
  private readonly now = signal(Date.now());

  /** The step the timeline should keep in view. While the run is going: the hold, a checkpoint,
   *  the row that is executing, or the next unsettled top-level step. After a reload interrupts
   *  the run: the first step that was cancelled, which is where it stopped. */
  readonly trackKey = computed(() => {
    const run = this.run();
    if (!run) return null;
    const rows = this.rows();
    if (run.status === 'INTERRUPTED' || run.status === 'STOPPED') {
      return rows.find((row) => !row.isChild && row.result.state === 'CANCELLED')?.step.key
        ?? [...rows].reverse().find((row) => row.result.state !== 'PENDING')?.step.key
        ?? null;
    }
    if (run.status !== 'RUNNING') return null;
    if (run.hold?.stepKey) return run.hold.stepKey;
    const paused = this.pause()?.stepKey;
    if (paused) return paused;
    const active = rows.find((row) => RUNNING_STATES.includes(row.result.state) || row.result.state === 'PAUSED');
    if (active) return active.step.key;
    return rows.find((row) => !row.isChild && row.step.enabled && row.result.state === 'PENDING')?.step.key ?? null;
  });

  constructor() {
    const id = setInterval(() => {
      if (this.run()?.status === 'RUNNING') this.now.set(Date.now());
    }, 500);
    this.destroyRef.onDestroy(() => clearInterval(id));
    effect(() => {
      const key = this.trackKey();
      if (!key) return;
      setTimeout(() => {
        const row = this.host.nativeElement.querySelector(`[data-step-key="${CSS.escape(key)}"]`);
        row?.scrollIntoView({ block: 'center' });
      });
    });
  }

  readonly blocks = computed(() => toBlocks(this.steps()));

  readonly rows = computed<readonly TimelineRow[]>(() => {
    const results = this.results();
    return this.blocks().flatMap((block) => [
      { step: block.parent, result: results[block.parent.key] ?? emptyResult(), isChild: false },
      ...block.children.map((child) => ({ step: child, result: results[child.key] ?? emptyResult(), isChild: true })),
    ]);
  });

  readonly pausedRow = computed<TimelineRow | null>(() => {
    const p = this.pause();
    if (!p) return null;
    return this.rows().find((r) => r.step.key === p.stepKey) ?? null;
  });

  /** The step a running run is blocked on. Cleared once the hold or checkpoint is decided. */
  readonly decisionKey = computed(() => {
    const run = this.run();
    if (run?.status === 'RUNNING' && run.hold?.stepKey) return run.hold.stepKey;
    return this.pause()?.stepKey ?? null;
  });

  readonly filteredRows = computed<readonly TimelineRow[]>(() => {
    const f = this.filter();
    if (f === 'all') return this.rows();
    if (f === 'running') return this.rows().filter((r) => RUNNING_STATES.includes(r.result.state));
    if (f === 'diff') return this.rows().filter((r) => this.viewState(r) === 'COMPLETED_WITH_DIFFERENCES');
    if (f === 'failed') return this.rows().filter((r) => this.viewState(r) === 'FAILED');
    if (f === 'live') return this.rows().filter((r) => r.isChild && r.result.mode === 'LIVE');
    return this.rows().filter((r) => r.isChild && r.result.mode === 'REPLAY');
  });

  /** Visible rows kept in parent + children blocks, so a decision can outline that whole call. */
  readonly filteredGroups = computed(() => {
    const groups: { key: string; rows: TimelineRow[] }[] = [];
    for (const row of this.filteredRows()) {
      const parentKey = row.step.parentKey;
      const last = groups[groups.length - 1];
      if (parentKey && last?.key === parentKey) last.rows.push(row);
      else groups.push({ key: parentKey ?? row.step.key, rows: [row] });
    }
    return groups;
  });

  groupAwaiting(group: { readonly key: string; readonly rows: readonly TimelineRow[] }): boolean {
    const key = this.decisionKey();
    if (!key) return false;
    return group.key === key || group.rows.some((row) => row.step.key === key);
  }

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

  /** The next expected top-level step a Guided run is waiting on (T077) - null once every one has
   *  either settled or been marked SKIPPED/NOT_CALLED. */
  readonly nextGuidedStep = computed<Step | null>(() => {
    const run = this.run();
    if (run?.driver !== 'GUIDED' || run.status !== 'RUNNING') return null;
    return this.rows().find((r) => !r.isChild && r.result.state === 'PENDING')?.step ?? null;
  });

  readonly titlePill = computed<readonly [string, string]>(() => {
    const run = this.run();
    if (!run) return ['rl-p-wait', ''];
    if (run.status === 'RUNNING' && run.hold) return ['rl-p-fail', '■ holding - your call'];
    if (run.status === 'FAILED' && this.onlyDocumentMismatches()) return RUN_TITLE.COMPLETED_WITH_DIFFERENCES;
    return RUN_TITLE[run.status];
  });

  /** A finished run whose every stored failure is a whole-document JSON mismatch. */
  private onlyDocumentMismatches(): boolean {
    const failed = this.rows().filter((row) => row.result.state === 'FAILED');
    return failed.length > 0 && failed.every((row) => this.viewState(row) === 'COMPLETED_WITH_DIFFERENCES');
  }

  setFilter(filter: Filter): void {
    this.filter.set(filter);
  }

  stepLabel(key: string): string {
    return this.rows().find((row) => row.step.key === key)?.step.label ?? key;
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

  differenceLabel(row: TimelineRow): string {
    const count = this.unexpectedDifferenceCount(row);
    if (count <= 0) return 'differences';
    return count === 1 ? '1 difference' : `${count} differences`;
  }

  /** Stored state, except a whole-document JSON mismatch saved as a failure, which shows as differences. */
  viewState(row: TimelineRow): StepState {
    return displayedState(row.result, row.step.recording.status);
  }

  /** A LIVE child that got an actual response really contacted the real system, and the backend's
   *  own observer (T050) saves that answer into the Live calls log - mock.html's `res.savedLive`,
   *  the "💾 saved" badge (T074). */
  wasSavedLive(result: StepResult): boolean {
    return result.mode === 'LIVE' && result.actualResponse != null;
  }

  /** First line is the row; the opened step lists every line. Empty unless the step failed, was skipped, or was never sent. */
  whyOf(row: TimelineRow): readonly StepReason[] {
    const parent = row.step.parentKey ? this.rows().find((r) => r.step.key === row.step.parentKey) : undefined;
    const state = this.viewState(row);
    const shown = state === row.result.state ? row.result : { ...row.result, state };
    return explainStep(shown, row.step.recording.status, parent ? this.viewState(parent) : null);
  }

  readonly reasonPopup = signal<StepReason | null>(null);
  readonly differencePopup = signal<DifferencePopup | null>(null);
  private readonly differenceCache = new Map<string, readonly ShownDifference[]>();

  openReason(event: Event, reason: StepReason): void {
    event.stopPropagation();
    this.differencePopup.set(null);
    this.reasonPopup.set(reason);
  }

  closeReason(): void {
    this.reasonPopup.set(null);
  }

  formatReason(detail: string): string {
    return formatReasonDetail(detail);
  }

  /** Short field rows for the open step. A long body stays behind "Click to show". */
  differenceView(row: TimelineRow): { readonly inline: readonly ShownDifference[]; readonly note: string | null } {
    const all = this.visibleDiffs(row);
    const inline = all.length > 0 && all.length <= DIFF_PREVIEW_LIMIT && all.every(shortDifference) ? all : [];
    return { inline, note: wholeDocumentCheckNote(row.result.assertions) };
  }

  openDifferences(event: Event, row: TimelineRow): void {
    event.stopPropagation();
    this.reasonPopup.set(null);
    const rows = this.visibleDiffs(row);
    const concrete = concreteDifferences(row.result.differences);
    const classified = row.result.differences.filter((d) => !isCollapsedResponseDifference(d));
    this.differencePopup.set({
      stepKey: row.step.key,
      expected: classified.filter((d) => d.kind === 'EXPECTED'),
      noise: classified.filter((d) => d.kind === 'NOISE_AUTO' || d.kind === 'NOISE_USER'),
      label: row.step.label,
      headline: concrete || !rows.length
        ? null
        : 'One difference: the response does not match the recording. The lines below are the fields inside it.',
      note: wholeDocumentCheckNote(row.result.assertions),
      rows: rows.slice(0, DIFF_POPUP_LIMIT),
      more: Math.max(0, rows.length - DIFF_POPUP_LIMIT),
    });
  }

  closeDifferences(): void {
    this.differencePopup.set(null);
  }

  formatDiffValue(value: string | null): string {
    if (value == null) return '(not present)';
    if (!value) return '(empty)';
    const secrets = this.variableDefs().filter((variable) => variable.secret).map((variable) => variable.name);
    return maskRelive(formatReasonDetail(value), secrets, this.variables());
  }

  private visibleDiffs(row: TimelineRow): readonly ShownDifference[] {
    const key = differenceCacheKey(row);
    const cached = this.differenceCache.get(key);
    if (cached) return cached;
    const shown = concreteDifferences(row.result.differences);
    const rows = shown ?? computedDifferences(row, noiseRulesOf(this.run(), row));
    this.differenceCache.set(key, rows);
    return rows;
  }

  readonly savedLiveCount = computed(() => Object.values(this.results()).filter((r) => this.wasSavedLive(r)).length);

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

  /** "Run from here" (T075, US8 scenario 2): refuses when this step needs a `{{variable}}` its
   *  call rule references that neither the cycle defines nor an earlier step of this run actually
   *  produced a value for - a fresh run seeded from this one would just fail on it immediately. */
  canRunFromStep(stepKey: string): { readonly ok: boolean; readonly reason: string } {
    const step = this.rows().find((r) => r.step.key === stepKey)?.step;
    if (!step) return { ok: false, reason: '' };
    const defined = new Set(this.variableDefs().map((v) => v.name));
    const available = this.variables();
    const needed = variableTokensIn(step);
    const missing = needed.find((name) => !defined.has(name) && !available[name]);
    return missing ? { ok: false, reason: `Needs {{${missing}}}, which isn't available from the earlier steps.` } : { ok: true, reason: '' };
  }

  isRevealed(name: string): boolean {
    return this.revealed().has(name);
  }

  reveal(name: string): void {
    this.revealed.set(new Set([...this.revealed(), name]));
  }

  select(key: string): void {
    this.detailKey.update((current) => (current === key ? null : key));
    this.selectStep.emit(key);
  }

  startCheckpointEdit(): void {
    const row = this.pausedRow();
    if (!row) return;
    const edited = row.step.callRule.actions.find((a) => a.type === 'SET_REQUEST_BODY' && a.enabled !== false)?.body;
    this.editingCheckpoint.set({ body: edited ?? row.step.recording.requestBody ?? '', saveToCycle: false });
  }

  submitCheckpointEdit(): void {
    const edit = this.editingCheckpoint();
    if (!edit) return;
    this.editingCheckpoint.set(null);
    this.checkpointEdit.emit({ body: edit.body, saveToCycle: edit.saveToCycle });
  }

  setCheckpointBody(body: string): void {
    const edit = this.editingCheckpoint();
    if (edit) this.editingCheckpoint.set({ ...edit, body });
  }

  setCheckpointSave(saveToCycle: boolean): void {
    const edit = this.editingCheckpoint();
    if (edit) this.editingCheckpoint.set({ ...edit, saveToCycle });
  }

  /** FR-038: the run's execution log, secrets masked. */
  logMessage(message: string): string {
    return this.mask(message);
  }

  heldLabel(call: PausedCall): string {
    const key = call.relive?.stepKey;
    return (key && this.steps().find((s) => s.key === key)?.label) || `${call.method} ${call.url}`;
  }

  heldKind(call: PausedCall): 'CHANGED' | 'BEFORE' | 'AFTER' {
    const at = call.relive?.at;
    return at === 'BEFORE' || at === 'AFTER' ? at : 'CHANGED';
  }

  /** Seconds until the proxy decides on its own; null once someone took control. */
  heldSecondsLeft(call: PausedCall): number | null {
    if (call.heldAt) return null;
    return Math.max(0, Math.ceil((call.pausedAt + call.timeoutSeconds * 1000 - this.now()) / 1000));
  }

  heldPreview(call: PausedCall): string {
    const part = call.phase === 'response' ? call.response : call.request;
    return this.mask(part?.body ?? '');
  }

  decideHeld(call: PausedCall, choice: 'REPLAY' | 'FAIL' | 'SEND_REAL' | 'CONTINUE'): void {
    const decision: PauseDecision = choice === 'CONTINUE' || call.phase === 'response'
      ? { action: 'release' }
      : { action: 'release', relive: choice };
    this.armedSendReal.set(null);
    this.decidePaused.emit({ callId: call.callId, decision });
  }

  startEditAnswer(call: PausedCall): void {
    const key = call.relive?.stepKey;
    const recorded = key ? this.steps().find((s) => s.key === key)?.recording : undefined;
    const current = call.phase === 'response' ? call.response : null;
    this.editingAnswer.set({
      callId: call.callId,
      status: current?.status ?? recorded?.status ?? 200,
      body: current?.body ?? recorded?.responseBody ?? '',
    });
  }

  sendEditedAnswer(call: PausedCall): void {
    const edit = this.editingAnswer();
    if (!edit || edit.callId !== call.callId) return;
    this.editingAnswer.set(null);
    const decision: PauseDecision = call.phase === 'response'
      ? { action: 'release', status: edit.status, body: edit.body }
      : { action: 'release', relive: 'ANSWER', status: edit.status, body: edit.body };
    this.decidePaused.emit({ callId: call.callId, decision });
  }

  setEditStatus(value: string): void {
    const edit = this.editingAnswer();
    if (edit) this.editingAnswer.set({ ...edit, status: Number(value) || 200 });
  }

  setEditBody(value: string): void {
    const edit = this.editingAnswer();
    if (edit) this.editingAnswer.set({ ...edit, body: value });
  }

  pausePreview(): string {
    const p = this.pause();
    const row = this.pausedRow();
    if (!p || !row) return '';
    const text =
      p.at === 'BEFORE'
        ? (row.step.recording.requestBody ?? '')
        : (() => {
            try {
              return JSON.stringify(row.result.actualResponse, null, 2) ?? '';
            } catch {
              return String(row.result.actualResponse ?? '');
            }
          })();
    return this.mask(text);
  }

  /** Secret variables and redacted headers masked (FR-022a); there is no reveal for held calls. */
  private mask(text: string): string {
    const secretNames = this.variableDefs()
      .filter((v) => v.secret)
      .map((v) => v.name);
    return maskRelive(text, secretNames, this.variables());
  }
}

function differenceCacheKey(row: TimelineRow): string {
  const response = row.result.actualResponse;
  const body = response && typeof response === 'object' && 'body' in response ? (response as { body?: unknown }).body : null;
  const bodyLen = typeof body === 'string' ? body.length : 0;
  return `${row.step.key}|${row.result.attempt}|${row.result.finishedAt ?? ''}|${bodyLen}|${row.result.differences.length}`;
}

/** Stored field rows, when the grade kept them. A collapsed response row is computed from the bodies instead. */
function concreteDifferences(differences: readonly DifferenceEntry[]): ShownDifference[] | null {
  const unexpected = differences.filter((diff) => diff.kind === 'UNEXPECTED' && !isCollapsedResponseDifference(diff));
  if (!unexpected.length) return null;
  return unexpected.map((diff) => ({ path: diff.path, recorded: diff.recorded, actual: diff.actual, part: diff.part, kind: diff.kind }));
}

function noisePart(part: string | undefined): NoiseRule['part'] {
  return part === 'status' || part === 'header' || part === 'query' ? part : 'body';
}

function computedDifferences(row: TimelineRow, noiseRules: readonly NoiseRule[]): readonly ShownDifference[] {
  const actual = gradedResponse(row.result.actualResponse);
  if (!actual) return [];
  const recording = row.step.recording;
  return listResponseDifferences(
    { status: recording.status, headers: recording.responseHeaders, body: recording.responseBody },
    actual,
    { noiseRules, variablesUsed: row.result.variablesUsed, variablesProduced: row.result.variablesProduced },
  );
}

function gradedResponse(value: unknown): { status: number; headers: Readonly<Record<string, string>>; body: string | null } | null {
  if (!value || typeof value !== 'object' || typeof (value as { status?: unknown }).status !== 'number') return null;
  const response = value as { status: number; headers?: unknown; body?: unknown };
  const headers = response.headers && typeof response.headers === 'object'
    ? response.headers as Record<string, string>
    : {};
  const body = typeof response.body === 'string' ? response.body : response.body == null ? null : JSON.stringify(response.body);
  return { status: response.status, headers, body };
}

function noiseRulesOf(run: Run | null, row: TimelineRow): readonly NoiseRule[] {
  return [...(run?.definition?.noise ?? []), ...row.step.noise];
}

function shortDifference(diff: ShownDifference): boolean {
  return (diff.recorded?.length ?? 0) <= DIFF_VALUE_LIMIT && (diff.actual?.length ?? 0) <= DIFF_VALUE_LIMIT;
}
