/**
 * Shared by the Rebuild dialog (T070) and "Replace steps of cycle…" (T071, mock.html
 * `applyReplace()`) - both bring a cycle's step list up to date against a freshly-frozen call
 * tree and need the same "what changed, what did I keep" preview.
 */
import { pairSteps } from './relive-match';
import { Step } from './relive-types';

export interface RebuildPreviewRow {
  readonly kind: 'added' | 'updated' | 'removed' | 'reset' | 'kept';
  readonly label: string;
  readonly detail: string;
  readonly config: string;
}

/** Carries the caller's per-step configuration (everything but recording/key/source) onto whatever
 *  new step `pairSteps` matched it to - "your modes, variables, rules and checkpoints stay where
 *  the calls still match" (mock.html `rebuildPreview`/`applyReplace`). */
function carryOverConfig(old: Step, fresh: Step): Step {
  return {
    ...fresh,
    label: old.label,
    enabled: old.enabled,
    optional: old.optional,
    callRule: old.callRule,
    unattributed: old.unattributed,
    extract: old.extract,
    assertions: old.assertions,
    noise: old.noise,
  };
}

function applyCarryOver(freshSteps: readonly Step[], matched: readonly (readonly [Step, Step])[]): Step[] {
  const byFreshKey = new Map(matched.map(([old, fresh]) => [fresh.key, old]));
  return freshSteps.map((fresh) => {
    const old = byFreshKey.get(fresh.key);
    return old ? carryOverConfig(old, fresh) : fresh;
  });
}

/** Matches `oldSteps` against `freshSteps` (endpoint + order, via `pairSteps`), carries over each
 *  matched step's configuration, and reports what's added/updated/removed. */
export function rebuildReport(oldSteps: readonly Step[], freshSteps: readonly Step[]): { rows: RebuildPreviewRow[]; newSteps: Step[] } {
  const pairing = pairSteps<Step>(oldSteps, freshSteps);
  const newSteps = applyCarryOver(freshSteps, pairing.matched);
  const rows: RebuildPreviewRow[] = [];
  if (pairing.matched.length) {
    rows.push({
      kind: 'updated',
      label: `${pairing.matched.length} step${pairing.matched.length === 1 ? '' : 's'} matched`,
      detail: 'frozen copy refreshed from the new recording',
      config: 'kept: mode, edits, extraction, checkpoints',
    });
  }
  for (const step of pairing.added) {
    rows.push({ kind: 'added', label: step.label, detail: step.parentKey ? 'new supplier call' : 'new inbound call', config: `defaults: ${step.parentKey ? 'REPLAY' : 'LIVE'}, block if unattributed` });
  }
  for (const step of pairing.removed) {
    rows.push({ kind: 'removed', label: step.label, detail: 'not present in the new recording', config: 'its configuration is dropped' });
  }
  return { rows, newSteps };
}

/** Maps a preview row's kind onto ALFRED's existing `rl-p-*` pill palette (mock.html's own
 *  `pill()` mapping) rather than inventing new colors. */
export function rebuildPillClass(kind: RebuildPreviewRow['kind']): string {
  return { added: 'rl-p-ok', updated: 'rl-p-cycle', removed: 'rl-p-fail', reset: 'rl-p-mod', kept: 'rl-p-wait' }[kind];
}
