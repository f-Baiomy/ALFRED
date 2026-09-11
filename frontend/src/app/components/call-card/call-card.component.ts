import { Component, DestroyRef, ElementRef, HostListener, computed, effect, inject, input, signal } from '@angular/core';
import { CdkDragHandle } from '@angular/cdk/drag-drop';
import { CallDetail, CallRecord } from '../../core/models/call.model';
import {
  EXTERNAL_SOURCE_KEY,
  callKey,
  durationClass as durationClassOf,
  isInProgress,
  methodClass as methodClassOf,
  sourceKeyOf,
  sourceLabelOf,
  statusClass as statusClassOf,
} from '../../shared/utils/call-utils';
import { CallActionsComponent } from '../call-actions/call-actions.component';
import { JsonPanelComponent } from '../json-panel/json-panel.component';
import { CALL_LIST_CONTROLS_STATE, CALL_REMOVAL_STATE, CALL_SELECTION_STATE } from '../../core/state/call-selection.tokens';
import { ConfirmDialogService } from '../../core/services/confirm-dialog.service';
import { copyToClipboard } from '../../shared/utils/clipboard';

/** Clicking/dragging on these (or their descendants) must never toggle selection - they're either already-interactive controls or areas the user expects to select/copy text from. */
const SELECTION_EXEMPT_SELECTOR =
  'button, a, input, textarea, select, label, .uri-value, app-call-actions, app-json-panel, .drag-handle';

type DetailState = 'collapsed' | 'pending' | 'loading' | 'loaded' | 'error';

/**
 * One logged request/response pair: selection checkbox, badges, from/to urls, actions, and the
 * four Headers/Body panels.
 *
 * Request/response bodies aren't part of the list data at all (see CallRecord's doc comment) -
 * they're fetched only once this card is actually expanded, via the CALL_LIST_CONTROLS_STATE
 * token's getCallDetail() (each context - dashboard vs. a session-cycle - knows which endpoint to
 * hit). Expanding one card individually fetches immediately; a bulk "Expand all" instead sets
 * every card to 'pending' and lets an IntersectionObserver trigger each one's fetch only once it
 * actually scrolls into view, so expanding a 150-call list doesn't fire 150 requests at once.
 */
@Component({
  selector: 'app-call-card',
  standalone: true,
  imports: [CallActionsComponent, JsonPanelComponent, CdkDragHandle],
  templateUrl: './call-card.component.html',
})
export class CallCardComponent {
  private readonly state = inject(CALL_SELECTION_STATE);
  private readonly controlsState = inject(CALL_LIST_CONTROLS_STATE);
  private readonly confirmDialog = inject(ConfirmDialogService);
  private readonly hostRef = inject(ElementRef<HTMLElement>);
  private readonly destroyRef = inject(DestroyRef);
  /** Non-null only where something binds CALL_REMOVAL_STATE (a session-cycle detail view) - drives whether the "Remove" button renders at all. */
  readonly removalState = inject(CALL_REMOVAL_STATE, { optional: true });

  readonly call = input.required<CallRecord>();
  readonly pinned = input<boolean>(false);
  /** True only when the parent CallListComponent has cdkDrag enabled on this card's host element
   * (a session-cycle detail page, ungrouped, with CALL_REORDER_STATE bound) - drives whether the
   * drag-handle grip icon renders at all. The dashboard never sets this. */
  readonly dragHandle = input<boolean>(false);
  /**
   * 'full' (the default) renders exactly as before: one card with both request and response.
   * 'request'/'response' are the two halves of a split internal call (see splitCallsForDisplay()
   * in call-utils.ts) - only ever passed by the flat, chronological list. A 'request' row never
   * shows error/warning styling or a status/duration (that's the response row's job) and settles
   * to a plain "Sent" badge once resolved; a 'response' row is never in-progress (it only exists
   * once resolved) and shows the real status/duration exactly like a 'full' row does today.
   */
  readonly variant = input<'request' | 'response' | 'full'>('full');

  readonly idBase = computed(() => callKey(this.call()));
  readonly methodClass = computed(() => methodClassOf(this.call().method));
  readonly statusClass = computed(() => statusClassOf(this.call().response?.status ?? null));
  readonly durationClass = computed(() => durationClassOf(this.call().duration_ms));
  readonly sourceLabel = computed(() => {
    const label = sourceLabelOf(this.call());
    if (this.variant() === 'request') return `${label} · request`;
    if (this.variant() === 'response') return `${label} · response`;
    return label;
  });
  /** 'unknown' gets its own warning tint (a request that never matched a configured project); a real project name gets the neutral tinted badge; 'external' (the common case) gets the plain, unremarkable one. */
  readonly sourceBadgeClass = computed(() => {
    const key = sourceKeyOf(this.call());
    if (key === EXTERNAL_SOURCE_KEY) return 'source-badge-external';
    if (key === 'unknown') return 'source-badge-unknown';
    return 'source-badge';
  });
  readonly inProgress = computed(() => isInProgress(this.call()));
  /** Network/proxy failures and 5xx responses - a real error on our or the supplier's side. A
   * 'request' row never shows this: error/warning styling belongs to the response half, so a
   * resolved internal call's request row reads as neutral rather than red/orange. */
  readonly hasError = computed(() => {
    if (this.variant() === 'request') return false;
    if (this.inProgress()) return false;
    if (this.call().error) return true;
    const status = this.call().response?.status;
    return status != null && status >= 500;
  });
  /** 4xx responses - the call completed but the supplier rejected it (validation/business rule),
   * distinct from hasError since nothing actually broke on either side. Same request-row exemption
   * as hasError above. */
  readonly hasWarning = computed(() => {
    if (this.variant() === 'request') return false;
    if (this.inProgress() || this.hasError()) return false;
    const status = this.call().response?.status;
    return status != null && status >= 400 && status < 500;
  });
  readonly formattedTime = computed(() => {
    const ts = this.call().timestamp;
    return ts ? new Date(ts).toLocaleString() : '';
  });

  /** Which id chip (if any) just got copied, briefly showing "Copied!" in its place - see copyChip(). Cleared automatically after the flash, and whenever the underlying call's id chips change identity (a different call rendered into this same card instance would otherwise show a stale flash). */
  readonly copiedChip = signal<'request' | 'session' | 'operation' | null>(null);

  readonly detailState = signal<DetailState>('collapsed');
  private readonly detail = signal<CallDetail | null>(null);
  private isIntersecting = false;
  private observer?: IntersectionObserver;

  /** call() merged with its hydrated detail (if loaded) - what the template's panels actually render from. Falls back to call() itself (request/response undefined) before hydration. */
  readonly displayCall = computed<CallRecord>(() => {
    const detail = this.detail();
    return detail ? { ...this.call(), ...detail } : this.call();
  });

  /** Whether the Request panel renders at all: never on a 'response' half, and not until the
   * hydrated detail actually carries a request (see displayCall). */
  readonly showsRequestPanel = computed(() => this.variant() !== 'response' && this.displayCall().request != null);
  /** Whether the Response panel renders at all: never on a 'request' half, and not on a full card
   * whose call hasn't resolved yet. */
  readonly showsResponsePanel = computed(() => this.variant() !== 'request' && this.displayCall().response != null);
  /**
   * True when exactly one of the two panels renders - either half of a split internal call (see
   * splitCallsForDisplay() in call-utils.ts), or a full card still waiting on its response. The
   * panels grid is 2-up by default, which would leave a permanently empty second column in both
   * cases, so the lone panel is given the card's full width instead (see .panels.single).
   */
  readonly singlePanel = computed(() => this.showsRequestPanel() !== this.showsResponsePanel());

  constructor() {
    this.observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          this.isIntersecting = true;
          this.maybeLoadDetail();
          this.observer?.disconnect();
        }
      },
      { rootMargin: '200px' }
    );
    this.observer.observe(this.hostRef.nativeElement);
    this.destroyRef.onDestroy(() => this.observer?.disconnect());

    // A bulk "Expand all" marks every card 'pending' (so the placeholder already reads
    // "loading soon" instead of "click to expand") without fetching anything for cards that
    // aren't visible yet - maybeLoadDetail only actually fetches once isIntersecting is also
    // true, whether that happened before or after this fires.
    let lastSeenCollapseAllVersion = -1;
    effect(
      () => {
        const version = this.controlsState.collapseAllVersion();
        if (lastSeenCollapseAllVersion === -1) {
          lastSeenCollapseAllVersion = version;
          return;
        }
        if (version === lastSeenCollapseAllVersion) return;
        lastSeenCollapseAllVersion = version;

        if (this.controlsState.expanded()) {
          if (this.detailState() === 'collapsed') {
            this.detailState.set('pending');
            this.maybeLoadDetail();
          }
        } else if (this.detailState() !== 'loaded') {
          // Collapsing doesn't drop already-hydrated data (still cached, cheap to keep showing
          // if re-expanded), it just hides it - only a still-pending/loading card resets.
          this.detailState.set('collapsed');
        }
      },
      { allowSignalWrites: true }
    );

    // If this card is expanded while its call is still IN_PROGRESS, the fetched detail has no
    // response yet - the live WebSocket push that later completes the call replaces call() with
    // a new object (see calls-state.service.ts), but this component's own cached `detail` signal
    // is never told to refetch, so the response panel would otherwise stay stuck at "no response
    // yet" forever until a hard page refresh re-fetches everything from scratch (confirmed live).
    let wasInProgress = false;
    effect(
      () => {
        const inProgressNow = this.call().state === 'IN_PROGRESS';
        if (inProgressNow) {
          wasInProgress = true;
          return;
        }
        if (wasInProgress && this.detailState() === 'loaded') {
          this.detail.set(null);
          this.detailState.set('pending');
          this.maybeLoadDetail();
        }
        wasInProgress = false;
      },
      { allowSignalWrites: true }
    );
  }

  /**
   * Only fires when something has already asked for this card's detail ('pending') AND it's
   * visible - never for a plain 'collapsed' card. The IntersectionObserver's role is purely to
   * gate *when* a pending fetch actually happens, not to promote a collapsed card into a pending
   * one by itself, or every card that merely scrolls into view would silently fetch its detail
   * with no click at all (confirmed live: this exact bug fetched a visible card's detail on
   * first page load, before this check was narrowed to 'pending' only).
   */
  private maybeLoadDetail(): void {
    if (!this.isIntersecting) return;
    if (this.detailState() !== 'pending') return;
    this.detailState.set('loading');
    this.controlsState.getCallDetail(this.call().id, this.call().source).subscribe({
      next: (detail) => {
        this.detail.set(detail);
        this.detailState.set('loaded');
      },
      error: () => {
        this.detailState.set('error');
      },
    });
  }

  /**
   * Individual "Show request/response" click - the card is visible by definition (the user just
   * clicked it), so this fetches immediately without waiting on the IntersectionObserver, which
   * may not have fired its (async) callback yet even for an already-visible element.
   */
  onExpandClick(): void {
    this.isIntersecting = true;
    this.detailState.set('pending');
    this.maybeLoadDetail();
  }

  /** Truncates an id chip's value down to its first 8 characters for display - the full value is still what gets copied (see copyChip), this is purely a rendering shortcut for a UUID that would otherwise dominate the card's width. */
  shortId(value: string): string {
    return value.length > 8 ? value.slice(0, 8) + '…' : value;
  }

  copyChip(chip: 'request' | 'session' | 'operation', value: string): void {
    copyToClipboard(value).then(() => {
      this.copiedChip.set(chip);
      setTimeout(() => this.copiedChip.set(null), 1000);
    });
  }

  isSelected(): boolean {
    return this.state.isSelected(this.call());
  }

  toggleSelected(): void {
    this.state.toggleSelected(this.call());
  }

  async remove(): Promise<void> {
    if (!this.removalState) return;
    const confirmed = await this.confirmDialog.confirm('Remove this call from the cycle?', 'Remove');
    if (!confirmed) return;
    this.removalState.remove(this.call());
  }

  /**
   * Clicking anywhere on the card outside an interactive control toggles
   * its selection, and dragging from there across other cards paints the
   * same selection state onto each one - the checkbox stays as a small,
   * precise alternative to this larger "click the row" target.
   */
  @HostListener('mousedown', ['$event'])
  onMouseDown(event: MouseEvent): void {
    if (event.button !== 0) return;
    const target = event.target as HTMLElement;
    if (target.closest(SELECTION_EXEMPT_SELECTOR)) return;

    event.preventDefault();
    this.state.startDragSelect(this.call());
  }

  @HostListener('mouseenter')
  onMouseEnter(): void {
    this.state.dragSelectOver(this.call());
  }

  @HostListener('window:mouseup')
  onWindowMouseUp(): void {
    this.state.endDragSelect();
  }
}
