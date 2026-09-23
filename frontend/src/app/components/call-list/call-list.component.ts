import { NgTemplateOutlet } from '@angular/common';
import { Component, ElementRef, computed, effect, inject, input, viewChild } from '@angular/core';
import { CdkDrag, CdkDragDrop, CdkDragHandle, CdkDropList, moveItemInArray } from '@angular/cdk/drag-drop';
import { CALL_LIST_CONTROLS_STATE, CALL_REORDER_STATE, CycleSpacer } from '../../core/state/call-selection.tokens';
import { CallRecord } from '../../core/models/call.model';
import { PinService } from '../../core/services/pin.service';
import { CallListRow, callKey } from '../../shared/utils/call-utils';
import { CallDepthInfo, CallTreeNode } from '../../shared/utils/call-tree';
import {
  MergedWithSpacer,
  SpacerLayout,
  HEAD_ANCHOR,
  createSpacerGapController,
  layoutSpacers,
  reanchorDroppedSpacer,
  rootIndex,
  spacerOrderFor,
} from '../../shared/utils/spacer-gap-controller';
import { CallCardComponent } from '../call-card/call-card.component';
import { CallTreeNodeComponent } from '../call-tree-node/call-tree-node.component';
import { CallWaterfallComponent } from '../call-waterfall/call-waterfall.component';
import { SpacerChipComponent } from '../spacer-chip/spacer-chip.component';
import { SupplierGroupComponent } from '../supplier-group/supplier-group.component';

/** A collapsed call card's height, measured live and identical for every card regardless of its
 * content. Mirrors .call-card-placeholder's height in styles.scss - change one and you must change
 * the other, since CSS can't derive it and this can't read it. */
const COLLAPSED_CARD_HEIGHT_PX = 144;

/**
 * Pinned section + either the flat paginated list or the grouped-by-supplier view. Reused
 * verbatim on both the dashboard and a session-cycle detail page (see CALL_LIST_CONTROLS_STATE).
 * Pins come straight from PinService rather than through that token - pinning is global and
 * content-keyed (by callKey), not scoped to whichever list happens to be showing a call.
 *
 * Drag-and-drop reordering (CALL_REORDER_STATE) only ever applies to the flat, ungrouped list -
 * the grouped-by-supplier view has no defined meaning for "move this call to position N" across
 * group boundaries, so dragEnabled() (and therefore cdkDropList/cdkDrag) is always false there
 * regardless of what the token itself reports.
 */
@Component({
  selector: 'app-call-list',
  standalone: true,
  imports: [
    CallCardComponent,
    CallTreeNodeComponent,
    CallWaterfallComponent,
    SpacerChipComponent,
    SupplierGroupComponent,
    CdkDropList,
    CdkDrag,
    CdkDragHandle,
    NgTemplateOutlet,
  ],
  templateUrl: './call-list.component.html',
})
export class CallListComponent {
  readonly state = inject(CALL_LIST_CONTROLS_STATE);
  private readonly pinService = inject(PinService);
  /** Non-null only on a session-cycle detail page - see CALL_REORDER_STATE. Not private: the template reads it directly to wire a spacer chip's rename output straight to the store. */
  readonly reorderState = inject(CALL_REORDER_STATE, { optional: true });

  /** Auto-load the next page on scroll instead of a manual "Load more" button - the dashboard's default. The session-cycle detail page opts out (still gets a button, no infinite scroll) since backend pagination is deliberately not enabled for captured calls - see SessionCyclesService.paginationEnabled's doc. */
  readonly infiniteScroll = input(true);

  readonly trackByCallKey = callKey;
  readonly trackByRowKey = (row: CallListRow) => row.rowKey;

  /**
   * Height to reserve for a nested-view subtree that hasn't been built yet (see the @defer in the
   * template, and .call-card-placeholder in styles.scss).
   *
   * A collapsed card is a uniform 144px whatever it contains - measured live across a full page, so
   * a subtree's height is simply one card per call in it. The flat view can use a fixed placeholder
   * for exactly that reason; the nested view can't, because one root may stand for a single call
   * and the next for a dozen, and reserving 144px for both would make the scrollbar lie badly and
   * the page jump as each subtree materialised.
   *
   * Deliberately an estimate, not a promise: nesting adds a little padding per level that this
   * doesn't model. Being a few pixels out per subtree costs a small scroll adjustment as it builds;
   * being 10x out (which a fixed height would be) costs a usable scrollbar.
   */
  subtreePlaceholderPx(node: CallTreeNode): number {
    const countCalls = (n: CallTreeNode): number =>
      1 + n.children.reduce((total, child) => total + countCalls(child), 0);
    return countCalls(node) * COLLAPSED_CARD_HEIGHT_PX;
  }

  /** Only the flat-depth view annotates its cards - the other two show depth structurally (see
   * CallViewMode), and a call with no proven relations gets nothing rather than a lone "L1". */
  depthFor(call: CallRecord): CallDepthInfo | null {
    return this.state.callDepths().get(call.id) ?? null;
  }

  /**
   * Scroll-to-parent behind the flat-depth view's depth badge - the one affordance replacing what
   * indentation would otherwise do. The flash class is removed on the animation's own end event
   * rather than a timeout, so a re-render mid-flash can't leave a card stuck highlighted.
   *
   * On a session-cycle page the id sits on the row wrapper rather than the card (the card may not be
   * built yet - see the template), so the flash goes to whatever the row is currently showing.
   */
  revealParent(parentId: string): void {
    const target = document.getElementById(`call-row-${parentId}`);
    if (!target) return;
    target.scrollIntoView({ behavior: 'smooth', block: 'center' });
    const flashed: Element = target.classList.contains('call-row')
      ? (target.querySelector('.call-card-placeholder, app-call-card > .call') ?? target)
      : target;
    flashed.classList.add('call-flash');
    flashed.addEventListener('animationend', () => flashed.classList.remove('call-flash'), { once: true });
  }

  readonly pinnedCalls = computed(() => [...this.pinService.pinned().values()]);
  readonly hasAnyData = computed(() => this.state.calls().length > 0 || this.pinnedCalls().length > 0);
  readonly dragEnabled = computed(() => !this.state.groupBySupplier() && (this.reorderState?.dragEnabled() ?? false));

  /** How the lists are ordered right now - decides which side of its call a spacer sits on, and whether a hidden anchor can be placed by time. See layoutSpacers. */
  private readonly spacerOrder = computed(() => spacerOrderFor(this.state.sortMode()));

  /** Both halves of a split call stand for it - "after this call" is after its closing row. */
  private static readonly flatAnchorCall = (row: CallListRow): CallRecord => row.call;
  private static readonly nodeAnchorCall = (node: CallTreeNode): CallRecord => node.call;

  /**
   * The flat list's own rows with every spacer spliced in - only ever non-trivial when reorderState
   * is bound (session-cycle detail), since that's the only token that carries spacers at all. A
   * spacer whose anchor call isn't shown (filtered, searched out, not loaded, deleted) is placed by
   * its anchor's timestamp instead of being dropped - see layoutSpacers for every rule.
   */
  private readonly flatLayout = computed<SpacerLayout<CallListRow>>(() =>
    layoutSpacers(this.state.visibleRows(), CallListComponent.flatAnchorCall, this.reorderState?.spacers() ?? [], this.spacerOrder())
  );
  readonly mergedRows = computed(() => this.flatLayout().merged);

  readonly trackByMergedRowKey = (entry: MergedWithSpacer<CallListRow>) => (entry.kind === 'item' ? entry.item.rowKey : `spacer:${entry.spacer.id}`);

  /** Nested child call id -> its root's id, so a spacer anchored to a child sits before that child's root instead of vanishing. */
  private readonly rootOfChild = computed(() => rootIndex(this.state.callTree().map((node) => node.call), this.state.descendants()));

  /**
   * The nested view's own top-level merge, over ROOT calls only (spacers sit between roots, never
   * inside a subtree). Only spacers can actually be dragged here (see the template: every root's
   * cdkDrag is disabled) - the tree's own order is derived from the calls, not something a user
   * rearranges.
   */
  private readonly nestedLayout = computed<SpacerLayout<CallTreeNode>>(() => {
    const rootOf = this.rootOfChild();
    return layoutSpacers(this.state.callTree(), CallListComponent.nodeAnchorCall, this.reorderState?.spacers() ?? [], this.spacerOrder(), (id) => rootOf.get(id));
  });
  readonly mergedRoots = computed(() => this.nestedLayout().merged);

  readonly trackByMergedRootKey = (entry: MergedWithSpacer<CallTreeNode>) => (entry.kind === 'item' ? entry.item.call.id : `spacer:${entry.spacer.id}`);

  /** Opens the composer in the gap above this row's call - the anchor comes from the layout, since in a newest-first list the gap above a call is NOT "before" it. */
  addSpacerAbove(callId: string): void {
    this.spacerGap.addSpacerAt(callId, this.flatLayout().gapAnchors.get(callId) ?? HEAD_ANCHOR);
  }

  addSpacerAtTail(): void {
    this.spacerGap.addSpacerAt(null, this.flatLayout().tailAnchor);
  }

  addSpacerAboveRoot(callId: string): void {
    this.nestedSpacerGap.addSpacerAt(callId, this.nestedLayout().gapAnchors.get(callId) ?? HEAD_ANCHOR);
  }

  addSpacerAtRootsTail(): void {
    this.nestedSpacerGap.addSpacerAt(null, this.nestedLayout().tailAnchor);
  }

  /** Flat view's own add/compose state - see the shared controller's doc. Nested has its own separate instance (nestedSpacerGap below) since the two views can each have their own composer open at once. */
  readonly spacerGap = createSpacerGapController(this.reorderState);
  readonly nestedSpacerGap = createSpacerGapController(this.reorderState);

  deleteSpacer(spacer: CycleSpacer): void {
    this.reorderState?.deleteSpacer(spacer.id);
  }

  /** The sentinel element at the bottom of the flat list - observed to auto-trigger loadMore() as it scrolls near the viewport. Only rendered (see template) when infiniteScroll() is true; undefined otherwise or whenever the flat-list branch isn't rendered at all (no data yet, grouped view, no matches). */
  private readonly sentinel = viewChild<ElementRef<HTMLElement>>('sentinel');
  private sentinelObserver?: IntersectionObserver;

  constructor() {
    // Signal-based viewChild re-fires this effect whenever the sentinel div mounts/unmounts (e.g.
    // the flat list only appears once data exists), so the observer always tracks the current
    // element instead of being wired up once in ngAfterViewInit and missing a later mount.
    effect((onCleanup) => {
      const element = this.sentinel()?.nativeElement;
      if (!element) return;
      this.sentinelObserver = new IntersectionObserver(
        (entries) => {
          if (entries.some((e) => e.isIntersecting) && !this.state.loading() && this.state.remainingCount() > 0) {
            this.state.loadMore();
          }
        },
        // Starts fetching the next page a bit before the sentinel is actually on-screen, so the
        // next fifty are usually already loading by the time the user reaches the bottom.
        { rootMargin: '300px' }
      );
      this.sentinelObserver.observe(element);
      onCleanup(() => this.sentinelObserver?.disconnect());
    });
  }

  loadMore(): void {
    this.state.loadMore();
  }

  /**
   * Dropping a SPACER re-anchors that one spacer and nothing else - see reanchorDroppedSpacer.
   * Dropping a CALL reorders calls only: every spacer stays attached to its own anchor call, so a
   * spacer sitting before a call moves along with it.
   */
  onDrop(event: CdkDragDrop<readonly MergedWithSpacer<CallListRow>[]>): void {
    if (!this.reorderState || event.previousIndex === event.currentIndex) return;
    const dragged = this.mergedRows()[event.previousIndex];
    const merged = [...this.mergedRows()];
    moveItemInArray(merged, event.previousIndex, event.currentIndex);

    if (dragged?.kind === 'spacer') {
      reanchorDroppedSpacer(merged, event.currentIndex, CallListComponent.flatAnchorCall, this.spacerOrder().descending, this.reorderState);
      return;
    }
    const reorderedCalls = merged.filter((entry) => entry.kind === 'item').map((entry) => (entry as { item: CallListRow }).item.call);
    this.reorderState.reorder(reorderedCalls);
  }

  /** The nested view's drop handler - roots never move (their cdkDrag is disabled), so only a dropped spacer is ever re-anchored. */
  onDropRoots(event: CdkDragDrop<readonly MergedWithSpacer<CallTreeNode>[]>): void {
    if (!this.reorderState || event.previousIndex === event.currentIndex) return;
    const merged = [...this.mergedRoots()];
    moveItemInArray(merged, event.previousIndex, event.currentIndex);
    reanchorDroppedSpacer(merged, event.currentIndex, CallListComponent.nodeAnchorCall, this.spacerOrder().descending, this.reorderState);
  }
}
