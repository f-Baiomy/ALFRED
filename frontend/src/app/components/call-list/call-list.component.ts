import { Component, ElementRef, computed, effect, inject, input, viewChild } from '@angular/core';
import { CdkDrag, CdkDragDrop, CdkDropList, moveItemInArray } from '@angular/cdk/drag-drop';
import { CALL_LIST_CONTROLS_STATE, CALL_REORDER_STATE } from '../../core/state/call-selection.tokens';
import { CallRecord } from '../../core/models/call.model';
import { PinService } from '../../core/services/pin.service';
import { CallListRow, callKey } from '../../shared/utils/call-utils';
import { CallDepthInfo, CallTreeNode } from '../../shared/utils/call-tree';

/** A collapsed call card's height, measured live and identical for every card regardless of its
 * content. Mirrors .call-card-placeholder's height in styles.scss - change one and you must change
 * the other, since CSS can't derive it and this can't read it. */
const COLLAPSED_CARD_HEIGHT_PX = 144;
import { CallCardComponent } from '../call-card/call-card.component';
import { CallTreeNodeComponent } from '../call-tree-node/call-tree-node.component';
import { CallWaterfallComponent } from '../call-waterfall/call-waterfall.component';
import { SupplierGroupComponent } from '../supplier-group/supplier-group.component';

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
  imports: [CallCardComponent, CallTreeNodeComponent, CallWaterfallComponent, SupplierGroupComponent, CdkDropList, CdkDrag],
  templateUrl: './call-list.component.html',
})
export class CallListComponent {
  readonly state = inject(CALL_LIST_CONTROLS_STATE);
  private readonly pinService = inject(PinService);
  /** Non-null only on a session-cycle detail page - see CALL_REORDER_STATE. */
  private readonly reorderState = inject(CALL_REORDER_STATE, { optional: true });

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
   */
  revealParent(parentId: string): void {
    const target = document.getElementById(`call-row-${parentId}`);
    if (!target) return;
    target.scrollIntoView({ behavior: 'smooth', block: 'center' });
    target.classList.add('call-flash');
    target.addEventListener('animationend', () => target.classList.remove('call-flash'), { once: true });
  }

  readonly pinnedCalls = computed(() => [...this.pinService.pinned().values()]);
  readonly hasAnyData = computed(() => this.state.calls().length > 0 || this.pinnedCalls().length > 0);
  readonly dragEnabled = computed(() => !this.state.groupBySupplier() && (this.reorderState?.dragEnabled() ?? false));

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

  onDrop(event: CdkDragDrop<readonly CallRecord[]>): void {
    if (!this.reorderState || event.previousIndex === event.currentIndex) return;
    const reordered = [...this.state.visibleCalls()];
    moveItemInArray(reordered, event.previousIndex, event.currentIndex);
    this.reorderState.reorder(reordered);
  }
}
