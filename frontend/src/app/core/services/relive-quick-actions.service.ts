import { Injectable, inject } from '@angular/core';
import { Router } from '@angular/router';
import { CallRecord } from '../models/call.model';
import { freezeCalls } from '../../shared/utils/relive-freeze';
import { ReliveSettings, Step } from '../../shared/utils/relive-types';
import { ReliveApiService, ReliveWriteRequest } from './relive-api.service';
import { ReliveSelectionDialogService } from './relive-selection-dialog.service';

const DEFAULT_SETTINGS: ReliveSettings = { inboundMode: 'LIVE', onFailure: 'HOLD', onDifferences: 'CONTINUE', defaultDriver: 'AUTOMATIC', internalHosts: [] };

function baseCycle(name: string, description: string | null, steps: readonly Step[]): ReliveWriteRequest {
  return {
    name,
    description,
    steps,
    variables: [],
    cycleRules: [],
    globalRules: { mode: 'NONE', selectedIds: [] },
    settings: DEFAULT_SETTINGS,
    noise: [],
    unexpectedCalls: { policy: 'BLOCK', rules: [], fallback: 'BLOCK' },
  };
}

/**
 * The "Relive ▾" menu's four actions (T071, mock.html `reliveAction()`), shared by
 * `bulk-actions-bar` and `call-actions` so both selections and single calls get the same behavior.
 * "Add to cycle…" and "Replace steps of cycle…" need a cycle picked first, so they just open
 * `ReliveSelectionDialogComponent`; the other two act immediately.
 */
@Injectable({ providedIn: 'root' })
export class ReliveQuickActionsService {
  private readonly api = inject(ReliveApiService);
  private readonly router = inject(Router);
  private readonly picker = inject(ReliveSelectionDialogService);

  addToCycle(calls: readonly CallRecord[]): void {
    this.picker.open(calls, 'ADD');
  }

  replaceStepsOfCycle(calls: readonly CallRecord[]): void {
    this.picker.open(calls, 'REPLACE');
  }

  /** "New cycle from selection": creates a saved cycle from the picked calls and opens it. */
  newCycleFromSelection(calls: readonly CallRecord[]): void {
    const steps = freezeCalls(calls, new Map(), DEFAULT_SETTINGS, null);
    const name = `New cycle from ${calls.length} call${calls.length === 1 ? '' : 's'}`;
    this.api.create(baseCycle(name, null, steps)).subscribe((created) => this.router.navigate(['/relive', created.id]));
  }

  /** "⚡ Relive now": a transient (not saved) cycle, run immediately - every supplier call REPLAY
   *  by default (`defaultCallRule`'s own default for an outbound step). */
  reliveNow(calls: readonly CallRecord[]): void {
    const steps = freezeCalls(calls, new Map(), DEFAULT_SETTINGS, null);
    this.api.create(baseCycle('Quick run', 'From a Live Calls selection', steps), true).subscribe((created) => {
      this.api.startRun(created.id, { driver: 'AUTOMATIC', unattributedChoices: {} }).subscribe(() => {
        this.router.navigate(['/relive', created.id]);
      });
    });
  }
}
