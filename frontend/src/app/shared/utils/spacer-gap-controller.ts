import { WritableSignal, signal } from '@angular/core';
import { CallRecord, SortMode } from '../../core/models/call.model';
import { CallReorderState, CycleSpacer } from '../../core/state/call-selection.tokens';
import { callTime } from './call-utils';

/**
 * Where a spacer is anchored - see CycleSpacer. A new or moved spacer always carries its anchor
 * call's timestamp alongside the id, so it can still be placed at the right point in time when that
 * call is filtered out, not loaded, or deleted.
 */
export interface SpacerAnchor {
  readonly beforeCallId: string | null;
  readonly anchorTimestamp: string | null;
}

/** "After every call" - both anchor fields null. */
export const TRAILING_ANCHOR: SpacerAnchor = { beforeCallId: null, anchorTimestamp: null };

function anchorOf(call: CallRecord): SpacerAnchor {
  return { beforeCallId: call.id, anchorTimestamp: call.timestamp };
}

function isTrailing(spacer: CycleSpacer): boolean {
  return spacer.beforeCallId == null && spacer.anchorTimestamp == null;
}

/**
 * The "compose a brand-new spacer" state machine - identical in the flat, nested, and waterfall
 * views, so each of those three (separately, since nested/flat live in CallListComponent while
 * waterfall is its own component) constructs one of these rather than reimplementing the same
 * signal+three-methods by hand. Not a DI service: each view's controller is anchored to that view's
 * own CALL_REORDER_STATE instance (null outside a session-cycle detail page, in which case adding
 * is simply a no-op).
 */
export interface SpacerGapController {
  /**
   * Which gap's inline composer is showing - the call id of the row the gap sits directly above,
   * null for the trailing gap below the last row, undefined when no composer is open. This is a
   * position on screen, not the new spacer's anchor: in a newest-first list the two differ (see
   * SpacerLayout.gapAnchors).
   */
  readonly composingGapKey: WritableSignal<string | null | undefined>;
  addSpacerAt(gapKey: string | null, anchor: SpacerAnchor): void;
  confirmNewSpacer(label: string): void;
  cancelSpacerEdit(): void;
}

export function createSpacerGapController(reorderState: CallReorderState | null): SpacerGapController {
  const composingGapKey = signal<string | null | undefined>(undefined);
  let pendingAnchor: SpacerAnchor = TRAILING_ANCHOR;
  return {
    composingGapKey,
    addSpacerAt(gapKey: string | null, anchor: SpacerAnchor): void {
      pendingAnchor = anchor;
      composingGapKey.set(gapKey);
    },
    confirmNewSpacer(label: string): void {
      const trimmed = label.trim();
      if (trimmed && reorderState) {
        reorderState.addSpacer(trimmed, pendingAnchor.beforeCallId, pendingAnchor.anchorTimestamp);
      }
      composingGapKey.set(undefined);
    },
    cancelSpacerEdit(): void {
      composingGapKey.set(undefined);
    },
  };
}

/** How the list a spacer is being merged into is ordered - see spacerOrderFor. */
export interface SpacerOrder {
  /** Newest first - "before this call" in time is BELOW it on screen. */
  readonly descending: boolean;
  /** Chronological at all - only then does a timestamp say where a spacer belongs among other calls. */
  readonly byTime: boolean;
}

export function spacerOrderFor(mode: SortMode): SpacerOrder {
  const descending = mode === 'newest' || mode === 'newest-call';
  return { descending, byTime: descending || mode === 'oldest' || mode === 'oldest-call' };
}

/**
 * One rendered entry once spacers are merged into a list of items. `detached` marks a spacer whose
 * position couldn't be worked out against what's currently shown - it renders at the very end,
 * flagged, rather than vanishing.
 */
export type MergedWithSpacer<T> =
  | { readonly kind: 'item'; readonly item: T }
  | { readonly kind: 'spacer'; readonly spacer: CycleSpacer; readonly detached: boolean };

export interface SpacerLayout<T> {
  readonly merged: readonly MergedWithSpacer<T>[];
  /** The anchor a new spacer gets when added in the gap directly above an anchor-eligible item, keyed by that item's call id. */
  readonly gapAnchors: ReadonlyMap<string, SpacerAnchor>;
  /** The anchor for the trailing gap below the last item. */
  readonly tailAnchor: SpacerAnchor;
}

/**
 * Splices spacers into `items` - the shared merge behind the flat view's rows, the nested view's
 * roots, and the waterfall view's root groups. `anchorCallOf` returns the call an item stands for,
 * or null for an item no spacer can sit directly before (a waterfall group ahead of the first root,
 * a flat view's closing 'response' half); everything below only ever looks at eligible items.
 *
 * Per spacer, the first rule that applies wins:
 *  a. EXACT - its anchor call is shown (or, in a tree view, `rootOf` maps it to a root that is):
 *     directly before it ascending; descending, directly before the next eligible item, i.e. just
 *     below it, since "before this call" in time is below it in a newest-first list.
 *  b. TIME - the list is chronological and the spacer has an anchorTimestamp: before the first
 *     eligible item at-or-after that time (ascending) / earlier than it (descending). This is what
 *     keeps a spacer at the same point in the story while a filter or server-side search hides its
 *     anchor call, or after that call was deleted.
 *  c. TRAILING - both anchor fields null: the tail ascending, the head descending.
 *  d. Otherwise DETACHED - after the tail, flagged. Never dropped: a spacer that silently vanishes
 *     under a filter reads as deleted.
 *
 * Several spacers resolving to the same slot keep their input (creation) order.
 */
export function layoutSpacers<T>(
  items: readonly T[],
  anchorCallOf: (item: T) => CallRecord | null,
  spacers: readonly CycleSpacer[],
  order: SpacerOrder,
  rootOf?: (callId: string) => string | undefined
): SpacerLayout<T> {
  const { descending, byTime } = order;
  const calls = items.map(anchorCallOf);

  // The gap above each eligible item. Ascending that's the item itself; descending the gap above a
  // row is chronologically AFTER it, so it anchors to the eligible item above (trailing at the top).
  const gapAnchors = new Map<string, SpacerAnchor>();
  let previous: SpacerAnchor = TRAILING_ANCHOR;
  let last: CallRecord | null = null;
  for (const call of calls) {
    if (!call) continue;
    if (!gapAnchors.has(call.id)) gapAnchors.set(call.id, descending ? previous : anchorOf(call));
    previous = anchorOf(call);
    last = call;
  }
  // Descending, the bottom of the list is its oldest end - a spacer there sits before the last call.
  const tailAnchor = descending && last ? anchorOf(last) : TRAILING_ANCHOR;

  if (spacers.length === 0) {
    return { merged: items.map((item) => ({ kind: 'item' as const, item })), gapAnchors, tailAnchor };
  }

  // Index of each eligible call's first row (ascending) / last row (descending), and of the next
  // eligible item after any index (items.length = the tail slot).
  const indexOfId = new Map<string, number>();
  const nextEligible = new Array<number>(items.length);
  let next = items.length;
  for (let i = items.length - 1; i >= 0; i--) {
    nextEligible[i] = next;
    const call = calls[i];
    if (!call) continue;
    next = i;
    if (!descending || !indexOfId.has(call.id)) indexOfId.set(call.id, i);
  }

  const slotByTime = (t: number): number => {
    for (let i = 0; i < items.length; i++) {
      const call = calls[i];
      if (call && (descending ? callTime(call) < t : callTime(call) >= t)) return i;
    }
    return items.length;
  };

  const slots = new Map<number, CycleSpacer[]>();
  const detached: CycleSpacer[] = [];
  const place = (slot: number, spacer: CycleSpacer): void => {
    const list = slots.get(slot);
    if (list) list.push(spacer);
    else slots.set(slot, [spacer]);
  };

  for (const spacer of spacers) {
    if (spacer.beforeCallId != null) {
      let index = indexOfId.get(spacer.beforeCallId);
      if (index === undefined && rootOf) {
        const root = rootOf(spacer.beforeCallId);
        if (root !== undefined) index = indexOfId.get(root);
      }
      if (index !== undefined) {
        place(descending ? nextEligible[index] : index, spacer);
        continue;
      }
    }
    if (byTime && spacer.anchorTimestamp != null) {
      const t = new Date(spacer.anchorTimestamp).getTime();
      if (!Number.isNaN(t)) {
        place(slotByTime(t), spacer);
        continue;
      }
    }
    if (isTrailing(spacer)) {
      place(descending ? 0 : items.length, spacer);
      continue;
    }
    detached.push(spacer);
  }

  const merged: MergedWithSpacer<T>[] = [];
  for (let i = 0; i <= items.length; i++) {
    for (const spacer of slots.get(i) ?? []) merged.push({ kind: 'spacer', spacer, detached: false });
    if (i < items.length) merged.push({ kind: 'item', item: items[i] });
  }
  for (const spacer of detached) merged.push({ kind: 'spacer', spacer, detached: true });
  return { merged, gapAnchors, tailAnchor };
}

/**
 * Re-anchors the ONE spacer just dropped at `merged[droppedIndex]` (`merged` being the post-drop
 * order): ascending, to the next eligible item below it; descending, to the eligible item above it
 * (the same asymmetry as SpacerLayout.gapAnchors); trailing if there is none. Every other spacer is
 * left exactly as it is - they're attached to calls, not to list positions, so moving one divider
 * (or a call) must never rewrite the rest. Only calls moveSpacer if the anchor actually changed.
 */
export function reanchorDroppedSpacer<T>(
  merged: readonly MergedWithSpacer<T>[],
  droppedIndex: number,
  anchorCallOf: (item: T) => CallRecord | null,
  descending: boolean,
  reorderState: CallReorderState
): void {
  const entry = merged[droppedIndex];
  if (!entry || entry.kind !== 'spacer') return;

  let anchor = TRAILING_ANCHOR;
  const step = descending ? -1 : 1;
  for (let j = droppedIndex + step; j >= 0 && j < merged.length; j += step) {
    const candidate = merged[j];
    const call = candidate.kind === 'item' ? anchorCallOf(candidate.item) : null;
    if (call) {
      anchor = anchorOf(call);
      break;
    }
  }

  const { spacer } = entry;
  if (anchor.beforeCallId !== spacer.beforeCallId || anchor.anchorTimestamp !== (spacer.anchorTimestamp ?? null)) {
    reorderState.moveSpacer(spacer.id, anchor.beforeCallId, anchor.anchorTimestamp);
  }
}

/** Maps every descendant of each root in `roots` to that root's id - `rootOf` for the tree views, built from CallListControlsState.descendants(). */
export function rootIndex(roots: readonly CallRecord[], descendants: ReadonlyMap<string, readonly CallRecord[]>): ReadonlyMap<string, string> {
  const index = new Map<string, string>();
  for (const root of roots) {
    for (const child of descendants.get(root.id) ?? []) index.set(child.id, root.id);
  }
  return index;
}
