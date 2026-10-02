import { Component, computed, inject, input, output, signal } from '@angular/core';
import { CallRecord } from '../../core/models/call.model';
import { CallPickerService } from '../../core/services/call-picker.service';
import { ReliveCallSourceService } from '../../core/services/relive-call-source.service';
import { SessionCyclesStateService } from '../../core/state/session-cycles-state.service';
import { SelectOption, SelectPickerComponent } from '../select-picker/select-picker.component';
import { buildCallTree } from '../../shared/utils/call-tree';
import { freezeCalls } from '../../shared/utils/relive-freeze';
import { ReliveSettings, Step } from '../../shared/utils/relive-types';

/** Who asked CallPickerService to pick, so `takeResult` only answers this dialog's own pick. */
export const RELIVE_ADD_CALLS_REQUESTER = 'relive-add-calls';

/** Carried through the picker so the cycle page can re-append after the user comes back. */
export interface ReliveAddCallsResume {
  readonly cycleId: string | null;
}

/**
 * "Add calls" (FR-001, mock.html `openAdd()`/`confirmAdd()`): pick recorded calls from a chosen
 * session cycle (shown as inbound calls with their children indented) or from anywhere else in
 * ALFRED via the existing call picker, then freeze the chosen ones into steps.
 */
@Component({
  selector: 'app-relive-add-calls-dialog',
  standalone: true,
  imports: [SelectPickerComponent],
  templateUrl: './relive-add-calls-dialog.component.html',
})
export class ReliveAddCallsDialogComponent {
  private readonly source = inject(ReliveCallSourceService);
  private readonly picker = inject(CallPickerService);
  readonly sessionCycles = inject(SessionCyclesStateService);
  readonly sessionCycleOptions = computed<readonly SelectOption[]>(() => [
    { value: '', label: 'Choose a session cycle…' },
    ...this.sessionCycles.cycles().map((sc) => ({ value: sc.id, label: sc.name })),
  ]);

  readonly open = input.required<boolean>();
  readonly cycleId = input.required<string | null>();
  readonly settings = input.required<ReliveSettings>();

  readonly closed = output<void>();
  readonly added = output<readonly Step[]>();

  readonly selectedSessionCycleId = signal<string | null>(null);
  readonly calls = signal<readonly CallRecord[]>([]);
  readonly checkedRootIds = signal<ReadonlySet<string>>(new Set());
  readonly loading = signal(false);
  readonly adding = signal(false);
  readonly error = signal<string | null>(null);

  readonly tree = computed(() => buildCallTree(this.calls()).filter((node) => node.call.source === 'internal'));

  async selectSessionCycle(id: string): Promise<void> {
    this.selectedSessionCycleId.set(id || null);
    this.checkedRootIds.set(new Set());
    this.calls.set([]);
    if (!id) {
      this.calls.set([]);
      return;
    }
    this.loading.set(true);
    this.error.set(null);
    try {
      const calls = await this.source.loadCycle(id);
      if (this.selectedSessionCycleId() === id) {
        this.calls.set(calls);
        this.selectAll();
      }
    } catch {
      this.error.set('Could not load this recording. Try again.');
    } finally {
      this.loading.set(false);
    }
  }

  toggleRoot(id: string): void {
    const next = new Set(this.checkedRootIds());
    if (next.has(id)) next.delete(id);
    else next.add(id);
    this.checkedRootIds.set(next);
  }

  isChecked(id: string): boolean {
    return this.checkedRootIds().has(id);
  }

  selectAll(): void {
    this.checkedRootIds.set(new Set(this.tree().map((node) => node.call.id)));
  }

  deselectAll(): void {
    this.checkedRootIds.set(new Set());
  }

  pickFromAnywhere(): void {
    this.picker.start({
      requester: RELIVE_ADD_CALLS_REQUESTER,
      title: 'Calls to add to this Relive cycle',
      mode: 'multi',
      returnUrl: this.cycleId() ? `/relive/${this.cycleId()}` : '/relive',
      returnLabel: this.cycleId() ? 'the cycle' : 'new cycle',
      resume: { cycleId: this.cycleId() } satisfies ReliveAddCallsResume,
    });
    this.closed.emit();
  }

  async confirm(): Promise<void> {
    if (this.adding() || !this.selectedSessionCycleId()) return;
    const roots = this.tree().filter((node) => this.checkedRootIds().has(node.call.id));
    const flatten = (node: (typeof roots)[number]): CallRecord[] => [node.call, ...node.children.flatMap(flatten)];
    const chosen = roots.flatMap(flatten);
    this.adding.set(true);
    this.error.set(null);
    try {
      const hydrated = await this.source.hydrate(chosen, this.selectedSessionCycleId());
      const steps = freezeCalls(hydrated, new Map(), this.settings(), this.selectedSessionCycleId());
      this.added.emit(steps);
      this.close();
    } catch {
      this.error.set('Could not load full call details. Selection kept; try again.');
    } finally {
      this.adding.set(false);
    }
  }

  close(): void {
    this.closed.emit();
  }
}
