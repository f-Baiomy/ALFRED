import { Component, computed, inject, input, output, signal } from '@angular/core';
import { CallsQuery } from '../../core/state/call-list-view';
import { SessionCyclesApiService } from '../../core/services/session-cycles-api.service';
import { SessionCyclesStateService } from '../../core/state/session-cycles-state.service';
import { defaultCallRule } from '../../shared/utils/relive-call-rule';
import { freezeCalls } from '../../shared/utils/relive-freeze';
import { RebuildPreviewRow, rebuildPillClass, rebuildReport } from '../../shared/utils/relive-rebuild-preview';
import { CycleVersion, ReliveCycle, Step } from '../../shared/utils/relive-types';

type RebuildMode = 'REFRESH' | 'RECORDING' | 'START_OVER';

interface Preview {
  readonly mode: RebuildMode;
  readonly reason: CycleVersion['reason'];
  readonly rows: readonly RebuildPreviewRow[];
  readonly newSteps: readonly Step[];
}

const QUERY: CallsQuery = { search: '', supplier: '', sort: 'newest', offset: 0, limit: 500, sessionId: '', operationId: '', requestId: '' };

/**
 * "Rebuild" (T070, mock.html `openRebuild()`/`rebuildPreview()`/`applyRebuild()`): three ways to
 * bring a cycle's step list up to date with its sources without losing per-step configuration.
 * Shows a preview first - nothing is written until "Apply rebuild" - and the host page's
 * `ReliveCycleEditorState.rebuild()` persists immediately (snapshotting a version) so "Undo" can
 * restore it via `versions/{v}/restore`.
 */
@Component({
  selector: 'app-relive-rebuild-dialog',
  standalone: true,
  templateUrl: './relive-rebuild-dialog.component.html',
})
export class ReliveRebuildDialogComponent {
  private readonly sessionCyclesApi = inject(SessionCyclesApiService);
  readonly sessionCycles = inject(SessionCyclesStateService);

  readonly open = input.required<boolean>();
  readonly cycle = input.required<ReliveCycle>();

  readonly closed = output<void>();
  /** Emitted with the steps to persist and the version-history reason to tag them with; the host
   *  page calls `ReliveCycleEditorState.rebuild(steps, reason)`. */
  readonly rebuild = output<{ readonly steps: readonly Step[]; readonly reason: CycleVersion['reason'] }>();

  readonly preview = signal<Preview | null>(null);
  readonly pickedSessionCycleId = signal<string | null>(null);

  /** The single session cycle every inbound step's `source.cycleId` points at, or null if the
   *  cycle's steps came from more than one source (or nowhere) - "Refresh" needs exactly one. */
  readonly refreshSourceCycleId = computed<string | null>(() => {
    const ids = new Set(this.cycle().steps.filter((s) => !s.parentKey).map((s) => s.source.cycleId).filter((id): id is string => !!id));
    return ids.size === 1 ? [...ids][0] : null;
  });

  chooseMode(mode: RebuildMode): void {
    if (mode === 'START_OVER') {
      this.previewStartOver();
      return;
    }
    if (mode === 'REFRESH') {
      const cycleId = this.refreshSourceCycleId();
      if (!cycleId) return;
      this.loadAndPreview(cycleId, 'REFRESH', 'REBUILD_REFRESH');
      return;
    }
    // RECORDING: wait for the user to pick which session cycle to rebuild from.
    this.pickedSessionCycleId.set(null);
  }

  pickRecordingSource(cycleId: string): void {
    this.pickedSessionCycleId.set(cycleId || null);
    if (cycleId) this.loadAndPreview(cycleId, 'RECORDING', 'REBUILD_RECORDING');
  }

  private loadAndPreview(sourceCycleId: string, mode: RebuildMode, reason: CycleVersion['reason']): void {
    this.sessionCyclesApi.listCalls(sourceCycleId, QUERY).subscribe((page) => {
      const calls = page.calls.map((c) => c.call);
      const freshSteps = freezeCalls(calls, new Map(), this.cycle().settings, sourceCycleId);
      const { rows, newSteps } = rebuildReport(this.cycle().steps, freshSteps);
      this.preview.set({ mode, reason, rows, newSteps });
    });
  }

  private previewStartOver(): void {
    const cycle = this.cycle();
    const rows: RebuildPreviewRow[] = [
      { kind: 'reset', label: `all ${cycle.steps.length} steps`, detail: 're-frozen from the original recording', config: 'step edits, overrides, match rules, checkpoints dropped' },
      { kind: 'kept', label: 'cycle level', detail: `${cycle.variables.length} variables · ${cycle.cycleRules.length} cycle rules · global rule selection`, config: 'unchanged' },
    ];
    const newSteps = cycle.steps.map((s) => ({ ...s, callRule: defaultCallRule(s, cycle.settings), unattributed: 'BLOCK' as const, enabled: true }));
    this.preview.set({ mode: 'START_OVER', reason: 'REBUILD_START_OVER', rows, newSteps });
  }

  backToModes(): void {
    this.preview.set(null);
    this.pickedSessionCycleId.set(null);
  }

  apply(): void {
    const preview = this.preview();
    if (!preview) return;
    this.rebuild.emit({ steps: preview.newSteps, reason: preview.reason });
    this.close();
  }

  close(): void {
    this.preview.set(null);
    this.pickedSessionCycleId.set(null);
    this.closed.emit();
  }

  readonly pillClass = rebuildPillClass;
}
