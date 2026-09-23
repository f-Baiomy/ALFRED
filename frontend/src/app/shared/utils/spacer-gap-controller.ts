import { WritableSignal, signal } from '@angular/core';
import { CallRecord, SortMode } from '../../core/models/call.model';
import { CallReorderState, CycleSpacer } from '../../core/state/call-selection.tokens';
import { callTime } from './call-utils';

/**
 * Where a spacer is anchored - see CycleSpacer: the call directly ABOVE it, plus that call's
 * timestamp, so it can still be placed at the right point in time when that call is filtered out,
 * not loaded, or deleted. Both null means "above every call".
 */
export interface SpacerAnchor {
  readonly afterCallId: string | null;
  readonly anchorTimestamp: string | null;
}

/** What layoutSpacers needs of a spacer - a CycleSpacer, or an export's ExportedSpacer. */
export interface AnchoredSpacer {
  readonly afterCallId?: string | null;
  readonly anchorTimestamp?: string | null;
}

/** "Above every call" - both anchor fields null. */
export const HEAD_ANCHOR: SpacerAnchor = { afterCallId: null, anchorTimestamp: null };

function anchorOf(call: CallRecord): SpacerAnchor {
  return { afterCallId: call.id, anchorTimestamp: call.timestamp };
}

function isHead(spacer: AnchoredSpacer): boolean {
  return spacer.afterCallId == null && spacer.anchorTimestamp == null;
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
  let pendingAnchor: SpacerAnchor = HEAD_ANCHOR;
  return {
    composingGapKey,
    addSpacerAt(gapKey: string | null, anchor: SpacerAnchor): void {
      pendingAnchor = anchor;
      composingGapKey.set(gapKey);
    },
    confirmNewSpacer(label: string): void {
      const trimmed = label.trim();
      if (trimmed && reorderState) {
        reorderState.addSpacer(trimmed, pendingAnchor.afterCallId, pendingAnchor.anchorTimestamp);
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
  /** Newest first - "after this call" in time is ABOVE it on screen. */
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
export type MergedWithSpacer<T, S extends AnchoredSpacer = CycleSpacer> =
  | { readonly kind: 'item'; readonly item: T }
  | { readonly kind: 'spacer'; readonly spacer: S; readonly detached: boolean };

export interface SpacerLayout<T, S extends AnchoredSpacer = CycleSpacer> {
  readonly merged: readonly MergedWithSpacer<T, S>[];
  /** The anchor a new spacer gets when added in the gap directly above an anchor-eligible item, keyed by that item's call id (its first row, for a call shown as two). */
  readonly gapAnchors: ReadonlyMap<string, SpacerAnchor>;
  /** The anchor for the trailing gap below the last item. */
  readonly tailAnchor: SpacerAnchor;
}

/**
 * Splices spacers into `items` - the shared merge behind the flat view's rows, the nested view's
 * roots, the waterfall view's root groups, and the .md/.html exports' call blocks, so all of them
 * put a spacer in the same place. `anchorCallOf` returns the call an item stands for, or null for
 * an item no spacer can attach to (a waterfall group ahead of the first root); only eligible items
 * are ever looked at below. A call may stand behind two items (a split request/response pair) -
 * "after it" means after the last of them.
 *
 * Per spacer, the first rule that applies wins:
 *  a. EXACT - its anchor call is shown (or, in a tree view, `rootOf` maps it to a root that is):
 *     directly after it; newest-first, directly above it. Calls that were hidden when the spacer
 *     was added (OPTIONS preflights, a filter) and are shown now land BELOW it, never between it
 *     and the call it was placed after - which is the whole point of anchoring to the call above.
 *  b. TIME - the list is chronological and the spacer has an anchorTimestamp: after the last shown
 *     call at-or-before that time. What keeps a spacer at the same point in the story while its
 *     anchor call is hidden, not loaded, or deleted.
 *  c. HEAD - both anchor fields null: above every call (below every call, newest-first).
 *  d. Otherwise DETACHED - after everything, flagged. Never dropped: a spacer that silently
 *     vanishes under a filter reads as deleted.
 *
 * Several spacers resolving to the same slot keep their input (creation) order.
 */
export function layoutSpacers<T, S extends AnchoredSpacer = CycleSpacer>(
  items: readonly T[],
  anchorCallOf: (item: T) => CallRecord | null,
  spacers: readonly S[],
  order: SpacerOrder,
  rootOf?: (callId: string) => string | undefined
): SpacerLayout<T, S> {
  const { descending, byTime } = order;
  const calls = items.map(anchorCallOf);

  // The gap above each eligible item (keyed by its call, first row only). The gap above a row is
  // after whatever is shown above it; newest-first, it's after (in time) the row itself.
  const gapAnchors = new Map<string, SpacerAnchor>();
  let above: SpacerAnchor = HEAD_ANCHOR;
  let last: CallRecord | null = null;
  for (const call of calls) {
    if (!call) continue;
    if (!gapAnchors.has(call.id)) gapAnchors.set(call.id, descending ? anchorOf(call) : above);
    above = anchorOf(call);
    last = call;
  }
  // The bottom of the list: after the last call; newest-first that's the oldest end, before every call.
  const tailAnchor = !descending && last ? anchorOf(last) : HEAD_ANCHOR;

  if (spacers.length === 0) {
    return { merged: items.map((item) => ({ kind: 'item' as const, item })), gapAnchors, tailAnchor };
  }

  // slot i = directly before items[i]; items.length = the tail. "After item i" is the slot right
  // after its last row (ascending) / right before its first row (descending, where after = above).
  const slotAfter = new Map<string, number>();
  for (let i = 0; i < items.length; i++) {
    const call = calls[i];
    if (!call) continue;
    if (descending) {
      if (!slotAfter.has(call.id)) slotAfter.set(call.id, i);
    } else {
      slotAfter.set(call.id, i + 1);
    }
  }

  const slotByTime = (t: number): number => {
    // Ascending: before the first eligible call later than t. Descending: before the first at-or-before t.
    for (let i = 0; i < items.length; i++) {
      const call = calls[i];
      if (call && (descending ? callTime(call) <= t : callTime(call) > t)) return i;
    }
    return items.length;
  };

  const slots = new Map<number, S[]>();
  const detached: S[] = [];
  const place = (slot: number, spacer: S): void => {
    const list = slots.get(slot);
    if (list) list.push(spacer);
    else slots.set(slot, [spacer]);
  };

  for (const spacer of spacers) {
    if (spacer.afterCallId != null) {
      let slot = slotAfter.get(spacer.afterCallId);
      if (slot === undefined && rootOf) {
        const root = rootOf(spacer.afterCallId);
        if (root !== undefined) slot = slotAfter.get(root);
      }
      if (slot !== undefined) {
        place(slot, spacer);
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
    if (isHead(spacer)) {
      place(descending ? items.length : 0, spacer);
      continue;
    }
    detached.push(spacer);
  }

  const merged: MergedWithSpacer<T, S>[] = [];
  for (let i = 0; i <= items.length; i++) {
    for (const spacer of slots.get(i) ?? []) merged.push({ kind: 'spacer', spacer, detached: false });
    if (i < items.length) merged.push({ kind: 'item', item: items[i] });
  }
  for (const spacer of detached) merged.push({ kind: 'spacer', spacer, detached: true });
  return { merged, gapAnchors, tailAnchor };
}

/**
 * The same merge, as "which spacers go right before this item" plus "which go after everything" -
 * the shape the .md/.html export builders iterate in, so they place spacers exactly where the list
 * does rather than by a lookup of their own.
 */
export function spacerSlots<T, S extends AnchoredSpacer>(merged: readonly MergedWithSpacer<T, S>[]): { before: ReadonlyMap<T, readonly S[]>; tail: readonly S[] } {
  const before = new Map<T, S[]>();
  let pending: S[] = [];
  for (const entry of merged) {
    if (entry.kind === 'spacer') {
      pending.push(entry.spacer);
    } else {
      if (pending.length > 0) before.set(entry.item, pending);
      pending = [];
    }
  }
  return { before, tail: pending };
}

/**
 * Re-anchors the ONE spacer just dropped at `merged[droppedIndex]` (`merged` being the post-drop
 * order) to the eligible item directly above it - newest-first, directly below it, since that's the
 * one it now follows in time; above every call if there is none. Every other spacer is left
 * exactly as it is - they're attached to calls, not to list positions, so moving one divider (or a
 * call) must never rewrite the rest. Only calls moveSpacer if the anchor actually changed.
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

  let anchor = HEAD_ANCHOR;
  const step = descending ? 1 : -1;
  for (let j = droppedIndex + step; j >= 0 && j < merged.length; j += step) {
    const candidate = merged[j];
    const call = candidate.kind === 'item' ? anchorCallOf(candidate.item) : null;
    if (call) {
      anchor = anchorOf(call);
      break;
    }
  }

  const { spacer } = entry;
  if (anchor.afterCallId !== (spacer.afterCallId ?? null) || anchor.anchorTimestamp !== (spacer.anchorTimestamp ?? null)) {
    reorderState.moveSpacer(spacer.id, anchor.afterCallId, anchor.anchorTimestamp);
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
