/**
 * Matches a cycle's current steps against a rebuilt step list (US6b "Rebuild"), so the preview
 * can show what stays, what's added and what's removed, and the apply can carry configuration
 * over onto whichever new step replaces each old one.
 *
 * Matching is endpoint + order within the same parent - the same key the proxy uses for its own
 * `ordinal` matching (`proxy/relive.py`'s `match_child`): group same-level siblings by method +
 * host + path, then pair the Nth old occurrence with the Nth new occurrence. A step whose parent
 * didn't match has no possible match either - the whole unmatched subtree is added or removed.
 */
import { Step } from './relive-types';

export type MatchableStep = Pick<Step, 'key' | 'parentKey' | 'recording'>;

export interface PairStepsResult<T extends MatchableStep = MatchableStep> {
  readonly matched: readonly (readonly [T, T])[];
  readonly added: readonly T[];
  readonly removed: readonly T[];
}

function endpointSignature<T extends MatchableStep>(step: T): string {
  const method = step.recording.method.toUpperCase();
  try {
    const url = new URL(step.recording.url);
    return `${method} ${url.host}${url.pathname}`;
  } catch {
    return `${method} ${step.recording.url}`;
  }
}

function groupBySignature<T extends MatchableStep>(steps: readonly T[]): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const step of steps) {
    const signature = endpointSignature(step);
    const group = groups.get(signature);
    if (group) {
      group.push(step);
    } else {
      groups.set(signature, [step]);
    }
  }
  return groups;
}

function descendants<T extends MatchableStep>(parentKey: string, steps: readonly T[]): T[] {
  const direct = steps.filter((s) => s.parentKey === parentKey);
  return direct.flatMap((d) => [d, ...descendants(d.key, steps)]);
}

export function pairSteps<T extends MatchableStep>(oldSteps: readonly T[], newSteps: readonly T[]): PairStepsResult<T> {
  const matched: (readonly [T, T])[] = [];
  const removedRoots: T[] = [];
  const addedRoots: T[] = [];

  const queue: { oldParent: string | null; newParent: string | null }[] = [{ oldParent: null, newParent: null }];
  while (queue.length > 0) {
    const { oldParent, newParent } = queue.shift()!;
    const oldChildren = oldSteps.filter((s) => (s.parentKey ?? null) === oldParent);
    const newChildren = newSteps.filter((s) => (s.parentKey ?? null) === newParent);
    const oldGroups = groupBySignature(oldChildren);
    const newGroups = groupBySignature(newChildren);

    const signatures = new Set([...oldGroups.keys(), ...newGroups.keys()]);
    for (const signature of signatures) {
      const oldList = oldGroups.get(signature) ?? [];
      const newList = newGroups.get(signature) ?? [];
      const pairCount = Math.min(oldList.length, newList.length);
      for (let i = 0; i < pairCount; i++) {
        matched.push([oldList[i], newList[i]]);
        queue.push({ oldParent: oldList[i].key, newParent: newList[i].key });
      }
      for (let i = pairCount; i < oldList.length; i++) {
        removedRoots.push(oldList[i]);
      }
      for (let i = pairCount; i < newList.length; i++) {
        addedRoots.push(newList[i]);
      }
    }
  }

  const removed = removedRoots.flatMap((r) => [r, ...descendants(r.key, oldSteps)]);
  const added = addedRoots.flatMap((a) => [a, ...descendants(a.key, newSteps)]);

  return { matched, added, removed };
}
