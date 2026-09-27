import { Component, computed, inject, input, output, signal } from '@angular/core';
import { Router } from '@angular/router';
import { CallRecord } from '../../core/models/call.model';
import { CallPickerService } from '../../core/services/call-picker.service';
import { SessionCyclesApiService } from '../../core/services/session-cycles-api.service';
import { CallsQuery } from '../../core/state/call-list-view';
import { SessionCyclesStateService } from '../../core/state/session-cycles-state.service';
import { buildCallTree } from '../../shared/utils/call-tree';
import { freezeCalls } from '../../shared/utils/relive-freeze';
import { ReliveSettings, Step } from '../../shared/utils/relive-types';

/** Who asked CallPickerService to pick, so `takeResult` only answers this dialog's own pick. */
export const RELIVE_ADD_CALLS_REQUESTER = 'relive-add-calls';

/** Carried through the picker so the cycle page can re-append after the user comes back. */
export interface ReliveAddCallsResume {
  readonly cycleId: string;
}

/**
 * "Add calls" (FR-001, mock.html `openAdd()`/`confirmAdd()`): pick recorded calls from a chosen
 * session cycle (shown as inbound calls with their children indented) or from anywhere else in
 * ALFRED via the existing call picker, then freeze the chosen ones into steps.
 */
@Component({
  selector: 'app-relive-add-calls-dialog',
  standalone: true,
  templateUrl: './relive-add-calls-dialog.component.html',
})
export class ReliveAddCallsDialogComponent {
  private readonly sessionCyclesApi = inject(SessionCyclesApiService);
  private readonly picker = inject(CallPickerService);
  private readonly router = inject(Router);
  readonly sessionCycles = inject(SessionCyclesStateService);

  readonly open = input.required<boolean>();
  readonly cycleId = input.required<string>();
  readonly settings = input.required<ReliveSettings>();

  readonly closed = output<void>();
  readonly added = output<readonly Step[]>();

  readonly selectedSessionCycleId = signal<string | null>(null);
  readonly calls = signal<readonly CallRecord[]>([]);
  readonly checkedRootIds = signal<ReadonlySet<string>>(new Set());

  readonly tree = computed(() => buildCallTree(this.calls()));

  selectSessionCycle(id: string): void {
    this.selectedSessionCycleId.set(id || null);
    this.checkedRootIds.set(new Set());
    if (!id) {
      this.calls.set([]);
      return;
    }
    const query: CallsQuery = { search: '', supplier: '', sort: 'newest', offset: 0, limit: 500, sessionId: '', operationId: '', requestId: '' };
    this.sessionCyclesApi.listCalls(id, query).subscribe((page) => this.calls.set(page.calls.map((c) => c.call)));
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

  pickFromAnywhere(): void {
    this.picker.start({
      requester: RELIVE_ADD_CALLS_REQUESTER,
      title: 'Calls to add to this Relive cycle',
      mode: 'multi',
      returnUrl: `/relive/${this.cycleId()}`,
      returnLabel: 'the cycle',
      resume: { cycleId: this.cycleId() } satisfies ReliveAddCallsResume,
    });
    this.closed.emit();
  }

  confirm(): void {
    const roots = this.tree().filter((node) => this.checkedRootIds().has(node.call.id));
    const chosen = roots.flatMap((node) => [node.call, ...node.children.map((c) => c.call)]);
    // Every call from `listCalls` already carries its full request/response - no separate detail
    // fetch needed (see relive-freeze.ts's doc on `details`).
    const steps = freezeCalls(chosen, new Map(), this.settings(), this.selectedSessionCycleId());
    this.added.emit(steps);
    this.close();
  }

  close(): void {
    this.closed.emit();
  }
}
