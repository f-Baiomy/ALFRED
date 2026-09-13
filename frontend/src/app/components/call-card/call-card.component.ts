import { Component, DestroyRef, ElementRef, HostListener, computed, effect, inject, input, output, signal } from '@angular/core';
import { CdkDragHandle } from '@angular/cdk/drag-drop';
import { NgTemplateOutlet } from '@angular/common';
import { CallDetail, CallDetailPart, CallRecord } from '../../core/models/call.model';
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
import { JsonPanelComponent, PanelLoadState, PanelLoadTrigger } from '../json-panel/json-panel.component';
import { CallDepthInfo } from '../../shared/utils/call-tree';

type BlockGroup = 'REQ' | 'RES';

/** Can this block be shown at all, and if not, why not - see blockChips. */
type BlockAvailability = 'ready' | 'pending' | 'none';

export interface BlockChip {
  readonly part: CallDetailPart;
  readonly group: BlockGroup;
  readonly label: string;
  /** What the open panel's own title bar reads, since the collapsed strip has no group headings. */
  readonly title: string;
  readonly state: PanelLoadState;
  readonly availability: BlockAvailability;
  readonly open: boolean;
  readonly armed: boolean;
}

const BLOCK_DEFINITIONS: readonly { part: CallDetailPart; group: BlockGroup; label: string; title: string }[] = [
  { part: 'request-headers', group: 'REQ', label: 'Headers', title: 'Request headers' },
  { part: 'request-body', group: 'REQ', label: 'Body', title: 'Request body' },
  { part: 'response-headers', group: 'RES', label: 'Headers', title: 'Response headers' },
  { part: 'response-body', group: 'RES', label: 'Body', title: 'Response body' },
];
import { CALL_LIST_CONTROLS_STATE, CALL_REMOVAL_STATE, CALL_SELECTION_STATE } from '../../core/state/call-selection.tokens';
import { ConfirmDialogService } from '../../core/services/confirm-dialog.service';
import { copyToClipboard } from '../../shared/utils/clipboard';

/** Clicking/dragging on these (or their descendants) must never toggle selection - they're either already-interactive controls or areas the user expects to select/copy text from. */
const SELECTION_EXEMPT_SELECTOR =
  'button, a, input, textarea, select, label, .uri-value, app-call-actions, app-json-panel, .drag-handle';

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
  imports: [CallActionsComponent, JsonPanelComponent, CdkDragHandle, NgTemplateOutlet],
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
   *
   * 'sandwich' is the nested view's parent card: ONE card split into a request band and a response
   * band with its own children projected between them (see the [callChildren] slot). Same idea as
   * the request/response pair, but held together in a single card so containment stays literal -
   * and it puts the status, duration and end time BELOW the children the call waited on, instead
   * of at the top where they read as if the parent had finished before its children began.
   */
  readonly variant = input<'request' | 'response' | 'full' | 'sandwich'>('full');
  /**
   * This call's place in the tree, for the flat-depth view's depth badge and timing bar (see
   * CallDepthInfo). Null in the nested and waterfall views, which show the same facts structurally
   * and would only be repeating themselves, and null for a call that has no proven relations at all.
   */
  readonly depth = input<CallDepthInfo | null>(null);
  /**
   * True in the nested view, where this card's own children are rendered inside it and so the
   * checkbox is the only sensible handle on "this call and the work it caused". Selecting then acts
   * on the whole subtree and the checkbox goes tri-state; the flat view leaves this false, since it
   * draws no hierarchy and a half-filled checkbox there would refer to nothing on screen.
   */
  readonly subtreeSelect = input<boolean>(false);
  /** Whether this card offers a fold control - only a nested-view parent that actually has children. */
  readonly foldable = input<boolean>(false);
  readonly folded = input<boolean>(false);
  readonly foldToggle = output<void>();
  /**
   * Whether this card offers a "diagnose" button, and whether its panel is currently showing. The
   * panel itself is PROJECTED (see the [callDiagnostics] slot) rather than built here: only the
   * nested view holds a CallTreeNode, and only that has the children the breakdown is computed from.
   * The parent projects nothing while `diagOpen` is false, so a page of parents costs no analysis
   * until one is actually asked.
   */
  readonly diagnosable = input<boolean>(false);
  readonly diagOpen = input<boolean>(false);
  readonly diagToggle = output<void>();
  /** Emitted when the depth badge's parent name is clicked - the list scrolls that parent into view
   * and flashes it, which is how hierarchy stays navigable in a view that never indents. */
  readonly revealParent = output<string>();

  readonly isSandwich = computed(() => this.variant() === 'sandwich');
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
  /** When the call actually finished - the response band's own timestamp on a sandwich card, so the
   * gap between the two bands is readable rather than implied. Empty while still in progress. */
  readonly endTime = computed(() => {
    const call = this.call();
    if (!call.timestamp || this.inProgress()) return '';
    return new Date(new Date(call.timestamp).getTime() + (call.duration_ms ?? 0)).toLocaleString();
  });

  /**
   * The single line the from/to pair collapses to, or null when it can't collapse and both lines
   * have to stay. Three cases, and the rule is the same in all of them - render what actually
   * DIFFERS, once:
   *
   * - Identical urls (every external call: the forward proxy never rewrites, confirmed across all
   *   50 loaded here): the whole url, host and all. The host is the supplier, and it's the single
   *   most useful thing on the line.
   * - Same path and query, different host (every internal call: localhost:<listenPort> ->
   *   host.docker.internal:<upstreamPort>): the shared path, with the host hop behind the toggle.
   *   The hosts come from this project's internal_call_services entry, so they're identical on
   *   every card and re-reading them 50 times buys nothing.
   * - Anything else - a genuine path rewrite - returns null and both lines stay. Doesn't happen
   *   with today's proxies, and if that ever changes it must be visible rather than folded away.
   */
  readonly foldedUrl = computed<string | null>(() => {
    const call = this.call();
    if (call.original_url === call.url) return call.url;

    const from = parseUrl(call.original_url);
    const to = parseUrl(call.url);
    if (!from || !to) return null;
    if (from.pathname + from.search !== to.pathname + to.search) return null;
    return to.pathname + to.search;
  });

  /** True only for the collapsed-but-not-identical case, i.e. there really is a host hop tucked
   * away. An external call's folded line hides nothing, so it gets no toggle at all - which makes
   * the toggle's presence itself mean "this one was forwarded somewhere else". */
  readonly hostHop = computed(() => this.foldedUrl() !== null && this.call().original_url !== this.call().url);
  /** Click to toggle rather than reveal on hover: hover is unreachable on touch, and the urls have
   * always been selectable text that can be copied out - which a tooltip wouldn't be. */
  readonly hostsShown = signal(false);

  /** Which id chip (if any) just got copied, briefly showing "Copied!" in its place - see copyChip(). Cleared automatically after the flash, and whenever the underlying call's id chips change identity (a different call rendered into this same card instance would otherwise show a stale flash). */
  readonly copiedChip = signal<'request' | 'session' | 'operation' | null>(null);

  /**
   * Per-block load state and content. All four blocks are listed collapsed from the start and stay
   * 'idle' until one is actually opened - so a response body nobody looks at is never transferred,
   * and opening Response headers doesn't drag that body along with it.
   *
   * Keyed by CallDetailPart, which doubles as the backend's own `part` parameter and as the panel's
   * CommentBlock, so there's one vocabulary end to end rather than three that have to be mapped.
   */
  readonly partStates = signal<Readonly<Record<CallDetailPart, PanelLoadState>>>({
    'request-headers': 'idle',
    'request-body': 'idle',
    'response-headers': 'idle',
    'response-body': 'idle',
  });
  private readonly partValues = signal<Partial<Record<CallDetailPart, unknown>>>({});
  /** Requested while the card was off-screen - see the IntersectionObserver in the constructor for
   * why a bulk expand mustn't fire a fetch for a card nobody can see yet. */
  private readonly queuedParts = new Set<CallDetailPart>();
  private isIntersecting = false;
  private observer?: IntersectionObserver;

  /** Whether the Request panel renders at all: never on a 'response' half. Unlike before, this no
   * longer waits for a fetch - the blocks are listed precisely so they can be opened. */
  readonly showsRequestPanel = computed(() => this.variant() !== 'response');
  /** Whether the Response panel renders at all: never on a 'request' half, and not on a call that
   * hasn't resolved yet - there is no response to open. */
  readonly showsResponsePanel = computed(() => this.variant() !== 'request' && !this.inProgress());
  /** The depth badge's text: a parent names what it contains, a child names what it sits inside.
   * Null for a call with no proven relations - an isolated call gets no badge at all rather than a
   * meaningless "L1". A 'response' row carries no badge either; the request row opening the pair
   * already stated it, and repeating it on both halves just doubles the noise. */
  readonly depthLabel = computed(() => {
    const info = this.depth();
    if (!info || this.variant() === 'response') return null;
    if (info.ambiguous) return 'unattributed';
    if (info.depth === 0) return info.descendantCount > 0 ? `root · ${info.descendantCount} below` : null;
    return `L${info.depth + 1} · in ${info.parentLabel}`;
  });
  /** Only a call that's actually part of a tree gets a bar - for anything else there's no root
   * window to measure against, and a lone full-width bar would imply a relationship that isn't there. */
  readonly showsSpanBar = computed(() => {
    const info = this.depth();
    if (!info || info.ambiguous || info.spanStart == null || info.spanWidth == null) return false;
    return info.depth > 0 || info.descendantCount > 0;
  });
  /** Whether the badge is the clickable scroll-to-parent control rather than plain text. An
   * ambiguous call is excluded explicitly: resolveParent leaves it parentless by definition, so a
   * parentId alongside `ambiguous` would be contradictory data - and a link reading "unattributed"
   * that jumps somewhere would be worse than no link at all. */
  readonly linksToParent = computed(() => {
    const info = this.depth();
    return !!info?.parentId && !info.ambiguous;
  });
  readonly spanBarTitle = computed(() => {
    const info = this.depth();
    if (!info) return '';
    const share = Math.round((info.spanWidth ?? 0) * 100);
    return info.depth === 0
      ? `This call's own window - the track every nested call below is measured against`
      : `Covers about ${share}% of the root call's window`;
  });
  /**
   * DOM id for scroll-to-parent (see revealParent), deliberately absent on a 'response' row: in the
   * flat-depth view a split call renders twice, and two elements sharing one id would make
   * getElementById pick whichever came first rather than the call's opening row.
   */
  readonly anchorId = computed(() => (this.variant() === 'response' ? null : `call-row-${this.call().id}`));
  readonly spanOffsetPercent = computed(() => `${((this.depth()?.spanStart ?? 0) * 100).toFixed(2)}%`);
  /** Floored at a hairline so a very short call inside a very long root still renders something
   * visible rather than a zero-width sliver. */
  readonly spanWidthPercent = computed(() => `${Math.max((this.depth()?.spanWidth ?? 0) * 100, 0.8).toFixed(2)}%`);

  constructor() {
    // A bulk "Expand all" asks every card on the page to open its header blocks, including cards
    // far below the fold. Fetching for those immediately would fire a burst of requests for content
    // nobody is looking at, so an off-screen card parks the request and runs it once it scrolls
    // into view. A card the user clicks directly is visible by definition and never waits.
    this.observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          this.isIntersecting = true;
          for (const part of this.queuedParts) this.fetchPart(part);
          this.queuedParts.clear();
          this.observer?.disconnect();
        }
      },
      { rootMargin: '200px' }
    );
    this.observer.observe(this.hostRef.nativeElement);
    this.destroyRef.onDestroy(() => this.observer?.disconnect());

    // "Expand all"/"Collapse all". The card owns this now that the chip strip owns open/closed.
    // Expanding opens HEADERS only: opening every body on a full page would fire fifty large
    // fetches off one click, whereas headers are a few hundred bytes and are what's worth scanning
    // in bulk. The first run is this card catching up with current state, not a bulk click - acting
    // on it would make every card fetch the moment it rendered.
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

        if (!this.controlsState.expanded()) {
          this.closeBlocks();
          return;
        }
        for (const chip of this.blockChips()) {
          if (chip.availability !== 'ready' || chip.part.endsWith('-body')) continue;
          this.openParts.update((open) => toggled(open, chip.part, true));
          this.loadPart(chip.part, 'bulk');
        }
      },
      { allowSignalWrites: true }
    );

    // If a block was opened while the call was still IN_PROGRESS, what it fetched has no response
    // in it - the live WebSocket push that later completes the call replaces call() with a new
    // object (see calls-state.service.ts), but nothing tells this card to re-fetch, so a response
    // block would otherwise sit empty forever until a hard page refresh (confirmed live).
    let wasInProgress = false;
    effect(
      () => {
        const inProgressNow = this.call().state === 'IN_PROGRESS';
        if (inProgressNow) {
          wasInProgress = true;
          return;
        }
        if (wasInProgress) {
          for (const [part, state] of Object.entries(this.partStates()) as [CallDetailPart, PanelLoadState][]) {
            if (state === 'loaded') this.refetchPart(part);
          }
          // Anything armed while the call was still running opens itself now that there's something
          // to open - the point of arming a chip is not having to come back and click it.
          for (const part of this.armedParts()) {
            this.openParts.update((open) => toggled(open, part, true));
            this.loadPart(part, 'user');
          }
          this.armedParts.set(new Set());
        }
        wasInProgress = false;
      },
      { allowSignalWrites: true }
    );
  }

  /**
   * The four chips, in fixed order. Position never depends on click order or on which blocks
   * happen to exist, so the same block is always in the same place from one card to the next.
   *
   * `availability` is the part a chip can't show on its own:
   * - 'pending': the call is still running, so the response genuinely hasn't happened yet. The chip
   *   keeps its slot (nothing reflows when it lands) and clicking ARMS it - see armedParts.
   * - 'none': the call failed outright, so there will never be a response. Verified against a real
   *   errored call: ?part=response-body returns {"request":null,"response":null}.
   */
  readonly blockChips = computed<readonly BlockChip[]>(() => {
    const inProgress = this.inProgress();
    const failed = !inProgress && !!this.call().error;
    const open = this.openParts();
    const armed = this.armedParts();

    return BLOCK_DEFINITIONS.filter((block) => this.showsGroup(block.group))
      // A failed call has no response at all, so its two response blocks collapse to ONE inert
      // chip - two of them would be twice the noise for the same "nothing here" message.
      .filter((block) => !(failed && block.part === 'response-body'))
      .map((block) => ({
        ...block,
        state: this.partStates()[block.part],
        availability: block.group === 'RES' ? (inProgress ? 'pending' : failed ? 'none' : 'ready') : 'ready',
        open: open.has(block.part),
        armed: armed.has(block.part),
      }));
  });

  /** Whether a group's chips appear at all - a split row shows only its own half (see variant). */
  private showsGroup(group: BlockGroup): boolean {
    return group === 'REQ' ? this.showsRequestPanel() : this.variant() !== 'request';
  }

  /**
   * The chips for one strip. A sandwich card draws two strips - its request band carries REQ and its
   * response band RES - while every other card draws one strip with everything on it.
   */
  chipsFor(group?: BlockGroup): readonly BlockChip[] {
    return group ? this.blockChips().filter((chip) => chip.group === group) : this.blockChips();
  }

  /** Open blocks for one strip, in the same fixed order as the chips - so two cards with the same
   * blocks open lay out identically regardless of what was clicked first. They stack vertically,
   * each spanning the card: side by side, two panels each get half the width, which is enough to
   * wrap their own toolbars onto three rows and squeeze the content that's actually being read. */
  openBlocksFor(group?: BlockGroup): readonly BlockChip[] {
    return this.chipsFor(group).filter((chip) => chip.open);
  }

  closeBlocks(group?: BlockGroup): void {
    const closing = new Set(this.openBlocksFor(group).map((chip) => chip.part));
    this.openParts.update((open) => new Set([...open].filter((part) => !closing.has(part))));
  }

  private readonly openParts = signal<ReadonlySet<CallDetailPart>>(new Set());
  /** Response blocks clicked while the call was still running: fetched and opened by themselves the
   * moment it resolves, so a slow call can be armed and left alone. */
  private readonly armedParts = signal<ReadonlySet<CallDetailPart>>(new Set());

  /** Clicking a chip. A 'none' chip is inert - there is nothing to show and never will be. */
  toggleBlock(chip: BlockChip): void {
    if (chip.availability === 'none') return;
    if (chip.availability === 'pending') {
      this.armedParts.update((armed) => toggled(armed, chip.part));
      return;
    }
    const isOpen = this.openParts().has(chip.part);
    this.openParts.update((open) => toggled(open, chip.part));
    if (!isOpen) this.loadPart(chip.part, 'user');
  }

  /** Whether this chip opens a new group, so REQ/RES is printed once rather than per chip. */
  startsGroup(chips: readonly BlockChip[], index: number): boolean {
    return index === 0 || chips[index - 1].group !== chips[index].group;
  }

  /** The chip's own text. Availability is stated rather than implied - a blank-looking chip that
   * does nothing would just read as broken. */
  chipLabel(chip: BlockChip): string {
    if (chip.availability === 'none') return '— none';
    if (chip.availability === 'pending') return `⏳ ${chip.label}`;
    if (chip.state === 'loading') return `◌ ${chip.label}`;
    return `${chip.open ? '▾' : '▸'} ${chip.label}`;
  }

  chipTitle(chip: BlockChip): string {
    if (chip.availability === 'none') return 'The call failed before any response - there is nothing to show';
    if (chip.availability === 'pending') {
      return chip.armed
        ? 'Armed - this opens by itself as soon as the response arrives'
        : 'The call is still running. Click to open this the moment the response arrives';
    }
    if (chip.state === 'error') return `${chip.title} failed to load - open to retry`;
    return chip.title;
  }

  closeBlock(part: CallDetailPart): void {
    this.openParts.update((open) => toggled(open, part, false));
  }

  partState(part: CallDetailPart): PanelLoadState {
    return this.partStates()[part];
  }

  partValue(part: CallDetailPart): unknown {
    return this.partValues()[part];
  }

  /**
   * One block was opened (or its retry clicked). Idempotent by design: a panel emits this on its
   * own toggle AND on a bulk expand, and the two can coincide - a block already loading or loaded
   * is left alone rather than fetched twice.
   */
  loadPart(part: CallDetailPart, trigger: PanelLoadTrigger = 'user'): void {
    const state = this.partStates()[part];
    if (state === 'loading' || state === 'loaded') return;
    // Someone opening this exact block can obviously see it, so don't make it wait on an
    // IntersectionObserver callback that may not have fired yet even for a card already on screen.
    if (trigger === 'user') this.isIntersecting = true;
    this.refetchPart(part);
  }

  private refetchPart(part: CallDetailPart): void {
    this.setPartState(part, 'loading');
    if (!this.isIntersecting) {
      this.queuedParts.add(part);
      return;
    }
    this.fetchPart(part);
  }

  private fetchPart(part: CallDetailPart): void {
    this.controlsState.getCallDetail(this.call().id, this.call().source, part).subscribe({
      next: (detail) => {
        this.partValues.update((values) => ({ ...values, [part]: valueOfPart(detail, part) }));
        this.setPartState(part, 'loaded');
      },
      error: () => this.setPartState(part, 'error'),
    });
  }

  private setPartState(part: CallDetailPart, state: PanelLoadState): void {
    this.partStates.update((states) => ({ ...states, [part]: state }));
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

  toggleHosts(): void {
    this.hostsShown.update((shown) => !shown);
  }

  onRevealParent(): void {
    const parentId = this.depth()?.parentId;
    if (parentId) this.revealParent.emit(parentId);
  }

  isSelected(): boolean {
    return this.state.isSelected(this.call());
  }

  /** 'none' outside the nested view - a flat card's checkbox is only ever empty or filled. */
  subtreeSelection(): 'none' | 'some' | 'all' {
    return this.subtreeSelect() ? this.state.subtreeSelection(this.call()) : 'none';
  }

  /** Half-filled: some of this call's subtree is selected and some isn't. */
  isPartiallySelected(): boolean {
    return this.subtreeSelection() === 'some';
  }

  toggleSelected(): void {
    if (!this.subtreeSelect()) {
      this.state.toggleSelected(this.call());
      return;
    }
    // A half-filled parent fills rather than clears - the same thing every file tree does, and the
    // only reading that lets one click finish a partly-made selection.
    this.state.setSubtreeSelected(this.call(), this.subtreeSelection() !== 'all');
  }

  toggleFold(): void {
    this.foldToggle.emit();
  }

  toggleDiag(): void {
    this.diagToggle.emit();
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
   *
   * `stopPropagation` is load-bearing in the nested view, where cards are rendered INSIDE one
   * another: mousedown bubbles, so without it a click on a child ran this handler again on every
   * card it sits inside. Measured on a real trace, clicking one supplier call at depth 2 selected
   * three calls - itself, its parent and its grandparent - so the tree selected UPWARDS, which is
   * the exact opposite of what selecting a parent is supposed to mean.
   */
  @HostListener('mousedown', ['$event'])
  onMouseDown(event: MouseEvent): void {
    if (event.button !== 0) return;
    const target = event.target as HTMLElement;
    if (target.closest(SELECTION_EXEMPT_SELECTOR)) return;

    event.preventDefault();
    event.stopPropagation();
    this.state.startDragSelect(this.call(), this.subtreeSelect());
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

/** Adds or removes a part, returning a fresh set (signals compare by reference). */
function toggled(
  parts: ReadonlySet<CallDetailPart>,
  part: CallDetailPart,
  force?: boolean
): ReadonlySet<CallDetailPart> {
  const next = new Set(parts);
  const shouldAdd = force ?? !next.has(part);
  if (shouldAdd) next.add(part);
  else next.delete(part);
  return next;
}

/** Pulls one block's raw value out of a per-part detail response - the backend populates only the
 * part that was asked for (see CallDetail.part), so the other three are null either way. */
function valueOfPart(detail: CallDetail, part: CallDetailPart): unknown {
  switch (part) {
    case 'request-headers':
      return detail.request?.headers;
    case 'request-body':
      return detail.request?.body;
    case 'response-headers':
      return detail.response?.headers;
    case 'response-body':
      return detail.response?.body;
  }
}

/** `new URL()` throws on anything malformed - a url Alfred logged verbatim from the wire is not
 * guaranteed to parse, and a card must render regardless. */
function parseUrl(value: string): URL | null {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}
