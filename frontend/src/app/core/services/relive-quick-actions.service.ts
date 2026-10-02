import { Injectable, inject } from '@angular/core';
import { CallRecord } from '../models/call.model';
import { freezeCalls } from '../../shared/utils/relive-freeze';
import { ReliveSettings, Step } from '../../shared/utils/relive-types';
import { refOf } from '../models/call-ref.model';
import { ReliveWriteRequest } from './relive-api.service';
import { ReliveCallSourceService } from './relive-call-source.service';
import { ReliveFingerprintFlow } from './relive-fingerprint-flow.service';
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
  private readonly fingerprints = inject(ReliveFingerprintFlow);
  private readonly picker = inject(ReliveSelectionDialogService);
  private readonly callSource = inject(ReliveCallSourceService);

  /** FR-003b: an inbound call always brings its correlated outbound children, whether or not they
   *  were selected too (T082: "Relive now" on one inbound call replayed it without its suppliers,
   *  which then all ran into the unexpected-call policy). */
  private async stepsOf(calls: readonly CallRecord[]): Promise<Step[]> {
    if (!calls.some((call) => call.source === 'internal')) return freezeCalls(calls, new Map(), DEFAULT_SETTINGS, null);
    return this.callSource.freezePicked(calls.map((call) => ({ ref: refOf(call, null), call, originLabel: 'Live Calls' })), DEFAULT_SETTINGS);
  }

  addToCycle(calls: readonly CallRecord[]): void {
    this.picker.open(calls, 'ADD');
  }

  replaceStepsOfCycle(calls: readonly CallRecord[]): void {
    this.picker.open(calls, 'REPLACE');
  }

  /** "New cycle from selection": creates a saved cycle from the picked calls and opens it. */
  newCycleFromSelection(calls: readonly CallRecord[], onError?: () => void): void {
    const name = `New cycle from ${calls.length} call${calls.length === 1 ? '' : 's'}`;
    void this.stepsOf(calls)
      .then((steps) => this.fingerprints.createAndOpen(baseCycle(name, null, steps)))
      .catch(() => onError?.());
  }

  /** "⚡ Relive now": a transient (not saved) cycle, run immediately - every supplier call REPLAY
   *  by default (`defaultCallRule`'s own default for an outbound step). */
  reliveNow(calls: readonly CallRecord[]): void {
    void this.stepsOf(calls).then((steps) =>
      this.fingerprints.createAndOpen(baseCycle('Quick run', 'From a Live Calls selection', steps), { transient: true, start: true }));
  }
}
