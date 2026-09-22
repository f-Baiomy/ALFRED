import { WritableSignal, signal } from '@angular/core';
import { CallReorderState, CycleSpacer } from '../../core/state/call-selection.tokens';

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
   * Where a brand-new spacer's inline composer is showing, in the same terms as a spacer's own
   * anchor - a call id (composer sits in that call's leading gap), null (trailing gap, after every
   * call/root/group), or undefined (no composer open).
   */
  readonly composingBeforeCallId: WritableSignal<string | null | undefined>;
  addSpacerBefore(beforeCallId: string | null): void;
  confirmNewSpacer(label: string): void;
  cancelSpacerEdit(): void;
}

export function createSpacerGapController(reorderState: CallReorderState | null): SpacerGapController {
  const composingBeforeCallId = signal<string | null | undefined>(undefined);
  return {
    composingBeforeCallId,
    addSpacerBefore(beforeCallId: string | null): void {
      composingBeforeCallId.set(beforeCallId);
    },
    confirmNewSpacer(label: string): void {
      const trimmed = label.trim();
      if (trimmed && reorderState) {
        reorderState.addSpacer(trimmed, composingBeforeCallId() ?? null);
      }
      composingBeforeCallId.set(undefined);
    },
    cancelSpacerEdit(): void {
      composingBeforeCallId.set(undefined);
    },
  };
}

/** One rendered row once spacers are merged into a plain list of anchor-bearing items - see mergeWithSpacers. */
export type MergedWithSpacer<T> = { readonly kind: 'item'; readonly item: T } | { readonly kind: 'spacer'; readonly spacer: CycleSpacer };

/**
 * Splices spacers into `items`, each immediately before the item `idOf` matches its `beforeCallId`
 * (or, for beforeCallId null, after every item) - the shared merge behind the flat view's row list,
 * the nested view's root list, and the waterfall view's root-group boundaries. `idOf` returns null
 * for an item that can never anchor a spacer (the flat/nested views' items are always anchor-
 * eligible; the waterfall view's non-root rows are not - see its own idOf). A spacer anchored to an
 * id that doesn't appear in `items` (filtered out, not yet loaded, or anchored to an ineligible
 * item) is simply omitted, exactly as before this was factored out.
 */
export function mergeWithSpacers<T>(items: readonly T[], idOf: (item: T) => string | null, spacers: readonly CycleSpacer[]): readonly MergedWithSpacer<T>[] {
  if (spacers.length === 0) return items.map((item) => ({ kind: 'item' as const, item }));

  const beforeId = new Map<string, CycleSpacer[]>();
  const trailing: CycleSpacer[] = [];
  for (const spacer of spacers) {
    if (spacer.beforeCallId == null) {
      trailing.push(spacer);
    } else {
      const list = beforeId.get(spacer.beforeCallId);
      if (list) list.push(spacer);
      else beforeId.set(spacer.beforeCallId, [spacer]);
    }
  }

  const merged: MergedWithSpacer<T>[] = [];
  for (const item of items) {
    const id = idOf(item);
    if (id != null) {
      for (const spacer of beforeId.get(id) ?? []) {
        merged.push({ kind: 'spacer', spacer });
      }
    }
    merged.push({ kind: 'item', item });
  }
  for (const spacer of trailing) {
    merged.push({ kind: 'spacer', spacer });
  }
  return merged;
}

/**
 * Recomputes each spacer's anchor after a drag-drop over a merged (item+spacer) list: a spacer's new
 * anchor is whatever anchor-eligible item now immediately follows it (by `idOf`, skipping past any
 * ineligible items in between - e.g. the waterfall view's non-root rows), or null if none follows -
 * so dragging a spacer past an item is exactly "move this divider to sit before that item", the same
 * relationship it already persists as. Only calls moveSpacer for spacers whose anchor actually
 * changed. Items themselves are never reordered by this - callers disable drag on non-spacer
 * entries (`cdkDragDisabled`) so a drop can only ever change where a spacer sits.
 */
export function reanchorSpacersAfterDrop<T>(
  merged: readonly MergedWithSpacer<T>[],
  idOf: (item: T) => string | null,
  reorderState: CallReorderState
): void {
  for (let i = 0; i < merged.length; i++) {
    const entry = merged[i];
    if (entry.kind !== 'spacer') continue;
    let nextId: string | null = null;
    for (let j = i + 1; j < merged.length; j++) {
      const candidate = merged[j];
      if (candidate.kind === 'item') {
        const id = idOf(candidate.item);
        if (id != null) {
          nextId = id;
          break;
        }
      }
    }
    if (nextId !== entry.spacer.beforeCallId) {
      reorderState.moveSpacer(entry.spacer.id, nextId);
    }
  }
}
