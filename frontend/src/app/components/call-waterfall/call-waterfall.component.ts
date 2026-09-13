import { Component, computed, inject, input, signal } from '@angular/core';
import { CallRecord } from '../../core/models/call.model';
import { CallDepthInfo, CallTreeNode, DepthRail, depthRails } from '../../shared/utils/call-tree';

import { durationClass, isInProgress, methodClass, statusClass, supplierOf, uriPath } from '../../shared/utils/call-utils';
import { CALL_LIST_CONTROLS_STATE, CALL_SELECTION_STATE } from '../../core/state/call-selection.tokens';
import { CallCardComponent } from '../call-card/call-card.component';
import { CallDiagnosticsComponent } from '../call-diagnostics/call-diagnostics.component';

/**
 * What a given line is showing:
 *
 * - 'single': a call with nothing nested inside it - one line, one bar, as before.
 * - 'request'/'response': the two lines bracketing a call that DID call others. The opening line
 *   marks where the call started and then trails off (it hasn't finished yet at that point in the
 *   list); the closing line carries the status, the total duration and the bar closing at its end
 *   tick. Between them sit the children, so the group reads open -> work -> close.
 */
type WaterfallRowKind = 'single' | 'request' | 'response';

/**
 * How a parent's own window divides up, as 0-1 fractions of the root: the stretch before its first
 * child fired, the stretch any child was in flight, and the stretch after the last one came back.
 * The middle is time it spent WAITING; the two ends are its own work. Drawn on the closing row,
 * where it answers the question the duration alone never does - "what was it doing for 12 seconds
 * when its suppliers only took 5?"
 */
interface SelfTimeSplit {
  readonly leadPercent: string;
  readonly waitPercent: string;
  readonly tailPercent: string;
  readonly waitingMs: number;
  readonly selfMs: number;
}

/** One flattened waterfall line - a call, how deep it sits, and where its bar goes. */
interface WaterfallRow {
  readonly call: CallRecord;
  readonly kind: WaterfallRowKind;
  readonly depth: number;
  /** One guide line per ancestor level, then this row's own - see depthRails. Each carries its
   * level's hue, so the nesting reads as a continuous coloured tree down the page rather than as a
   * single tick whose indent you have to measure by eye. */
  readonly rails: readonly DepthRail[];
  readonly offsetPercent: string;
  readonly widthPercent: string;
  readonly hasBar: boolean;
  /** A call with no measurable duration (a connect failure, say) - drawn as a tick at its own start
   * rather than a floored sliver that would read like a very short success. */
  readonly isInstant: boolean;
  readonly label: string;
  /** When this line happened, relative to its root's start: a call's own start, or for a closing
   * row the moment the group finished. Empty when there's no measurable root to measure against. */
  readonly offsetLabel: string;
  /** Only on a group's opening row - the root's own total, for the axis drawn above it. */
  readonly axisTotalLabel: string | null;
  /** The first row of a ROOT call's group - where one call's whole story begins. Drives the divider
   * between groups, which used to be the axis's job; the axis is hidden below 880px, so on a narrow
   * window every group ran flush into the next. */
  readonly startsRootGroup: boolean;
  /** Only on a closing row that has children to have waited on. */
  readonly selfTime: SelfTimeSplit | null;
  /** Whether this row offers a selection checkbox - true for a leaf row and for the OPENING half of
   * a bracketed pair, so a call spanning two rows still has exactly one. */
  readonly selectable: boolean;
  /** Whether this row offers a fold control - the opening half of a bracketed pair, which is the only
   * row with anything underneath it to fold. */
  readonly foldable: boolean;
  readonly folded: boolean;
  /** How many calls this row is currently hiding - 0 unless folded. */
  readonly foldedCount: number;
  /** The call's #N among its parent's outbound calls, or empty at a root - matches the number the
   * diagnostics table and findings use, so "#3 decides the total" points at a row you can see. */
  readonly indexLabel: string;
  /**
   * The node the diagnostics panel analyses - set on the opening row of EVERY call that made calls
   * of its own, at any depth, not just a root. analyzeCall has always worked against any node's
   * direct children; only this row builder was gating it on depth 0, which meant the one call whose
   * breakdown you usually want - the service in the middle that actually did the fanning out - never
   * got one.
   */
  readonly diagnosticsNode: CallTreeNode | null;
  /** Distinct from call.id, which a bracketing pair shares - used for tracking and for expanding
   * one half without the other. */
  readonly rowKey: string;
}

/**
 * The 'waterfall' view (design B): every call as one compact line, hierarchy shown by a depth rail
 * and timing by a bar measured against its root call's window. Clicking a line expands the full
 * call card underneath it, so nothing is lost - it's just not all on screen at once.
 *
 * Rows keep tree order (each parent immediately followed by its own subtree) rather than the list's
 * sort order, which is why this view requires a chronological sort in the first place - see
 * CallViewMode.
 *
 * A call that called others is bracketed by an opening and a closing row (see WaterfallRowKind)
 * rather than rendered once above its children, where its status and total duration read as though
 * it had finished before they began. The two rows deliberately don't both draw the span: the opener
 * is a start tick trailing off, the closer is the filled bar meeting its end tick.
 */
@Component({
  selector: 'app-call-waterfall',
  standalone: true,
  imports: [CallCardComponent, CallDiagnosticsComponent],
  template: `
    <div class="waterfall">
      @for (row of rows(); track row.rowKey) {
        <div
          class="waterfall-line"
          [class.expanded]="isExpanded(row.rowKey)"
          [class.waterfall-open]="row.kind === 'request'"
          [class.waterfall-close]="row.kind === 'response'"
          [class.waterfall-root-start]="row.startsRootGroup"
        >
          @if (row.axisTotalLabel) {
            <!-- One scale per group: every row between this opener and its closing row is measured
                 against this same root window, so the quarter marks read across all of them. -->
            <div class="waterfall-axis" aria-hidden="true">
              <span class="waterfall-axis-track">
                <span class="waterfall-axis-mark" style="left: 0">0</span>
                <span class="waterfall-axis-mark" style="left: 25%">&#8942;</span>
                <span class="waterfall-axis-mark" style="left: 50%">&#8942;</span>
                <span class="waterfall-axis-mark" style="left: 75%">&#8942;</span>
                <span class="waterfall-axis-mark waterfall-axis-end">{{ row.axisTotalLabel }}</span>
              </span>
            </div>
          }
          @if (row.diagnosticsNode && diagOpen(row.call.id)) {
            <!-- Directly above its own row and joined to it (see .waterfall-diag), so it reads as
                 that call's header rather than as a banner over the whole group. Only ever rendered
                 once the button has been pressed: the panel answers a question, and most rows are
                 not being asked it. Below the axis, which belongs to the root's scale, not to a call. -->
            <div class="waterfall-diag">
              <app-call-diagnostics [node]="row.diagnosticsNode" />
            </div>
          }
          <!-- The checkbox is a SIBLING of the row button, not inside it: a checkbox nested in a
               button is invalid, and clicking it would toggle the row open as well. Only on rows
               that open a call ('single' and the opening half of a bracketed pair), so a call that
               spans two rows still offers exactly one checkbox. -->
          <div
            class="waterfall-row"
            [class.waterfall-row-selected]="row.selectable && isSelected(row.call)"
            [class.waterfall-row-diag]="row.diagnosticsNode && diagOpen(row.call.id)"
          >
            @if (row.foldable) {
              <button
                type="button"
                class="fold-toggle"
                [attr.aria-expanded]="!row.folded"
                [title]="row.folded ? 'Show the calls made inside this one' : 'Hide the calls made inside this one'"
                [attr.aria-label]="row.folded ? 'Unfold nested calls' : 'Fold nested calls'"
                (click)="toggleFold(row)"
              >{{ row.folded ? '▸' : '▾' }}</button>
            } @else {
              <span class="waterfall-fold-spacer" aria-hidden="true"></span>
            }
            @if (row.selectable) {
              <label class="call-select-wrap" title="Select this call and everything it called">
                <input
                  type="checkbox"
                  class="call-select"
                  [checked]="subtreeSelection(row.call) === 'all'"
                  [indeterminate]="subtreeSelection(row.call) === 'some'"
                  (change)="toggleSelected(row.call)"
                />
              </label>
            } @else {
              <span class="waterfall-select-spacer" aria-hidden="true"></span>
            }
            <button type="button" class="waterfall-row-main" (click)="toggle(row.rowKey)">
            <span class="waterfall-rails" aria-hidden="true">
              @for (rail of row.rails; track $index) {
                <span class="waterfall-rail" [class]="rail.tint" [class.waterfall-rail-own]="rail.own" [style.width.px]="rail.widthPx"></span>
              }
            </span>
            @if (row.kind === 'single') {
              <span class="badge" [class]="methodClassOf(row.call)">{{ row.call.method }}</span>
            } @else {
              <span class="band-marker">{{ row.kind === 'request' ? '&#8595; request' : '&#8593; response' }}</span>
            }
            @if (row.kind === 'request') {
              @if (inProgress(row.call)) {
                <span class="badge status-pending">In progress</span>
              } @else {
                <span class="badge status-sent">Sent</span>
              }
            } @else if (inProgress(row.call)) {
              <span class="badge status-pending">In progress</span>
            } @else if (row.call.error) {
              <span class="badge status-err">ERROR</span>
            } @else {
              <span class="badge" [class]="statusClassOf(row.call)">{{ row.call.response?.status ?? '?' }}</span>
            }
            @if (row.indexLabel) {
              <span class="waterfall-index">{{ row.indexLabel }}</span>
            }
            <span class="waterfall-label">{{ row.label }}</span>
            @if (row.foldedCount > 0) {
              <span class="waterfall-folded-count">{{ row.foldedCount }} folded</span>
            }
            <span class="waterfall-offset">{{ row.offsetLabel }}</span>
            <span class="waterfall-track" aria-hidden="true">
              @if (row.hasBar) {
                @if (row.kind === 'request') {
                  <!-- A start tick that trails off: at this point in the list the call has begun
                       and hasn't come back yet. The closing row below draws the span it took. -->
                  <span class="waterfall-tick" [style.margin-left]="row.offsetPercent"></span>
                  <span class="waterfall-pending"></span>
                } @else if (row.isInstant) {
                  <span class="waterfall-tick" [class.waterfall-tick-error]="!!row.call.error" [style.margin-left]="row.offsetPercent"></span>
                } @else {
                  @if (row.selfTime; as split) {
                    <!-- Waiting on children vs its own work - see SelfTimeSplit. -->
                    <span class="waterfall-bar waterfall-self" [style.margin-left]="row.offsetPercent" [style.width]="split.leadPercent"></span>
                    <span class="waterfall-bar" [style.width]="split.waitPercent"></span>
                    <span class="waterfall-bar waterfall-self" [style.width]="split.tailPercent"></span>
                  } @else {
                    <span class="waterfall-bar" [style.margin-left]="row.offsetPercent" [style.width]="row.widthPercent"></span>
                  }
                  @if (row.kind === 'response') {
                    <span class="waterfall-tick"></span>
                  }
                }
              }
            </span>
            <span class="waterfall-duration" [class]="durationClassOf(row.call)" [title]="durationTitle(row)">
              @if (row.kind === 'request') {
                sent
              } @else {
                {{ row.call.error ? 'err' : row.call.duration_ms + ' ms' }}
              }
            </span>
            </button>
            @if (row.diagnosticsNode) {
              <button
                type="button"
                class="diag-btn"
                [class.on]="diagOpen(row.call.id)"
                [attr.aria-expanded]="diagOpen(row.call.id)"
                title="Where this call's time actually went"
                (click)="toggleDiag(row.call.id)"
              >diagnose</button>
            }
          </div>
          @if (isExpanded(row.rowKey)) {
            <div class="waterfall-detail">
              <app-call-card [call]="row.call" [variant]="row.kind === 'single' ? 'full' : row.kind" />
            </div>
          }
        </div>
      }
    </div>
  `,
})
export class CallWaterfallComponent {
  readonly nodes = input.required<readonly CallTreeNode[]>();
  /** The same per-call span fractions the flat-depth view's bars use, so both views measure a call
   * against its root identically instead of each deriving it their own way. */
  readonly depths = input.required<ReadonlyMap<string, CallDepthInfo>>();

  private readonly expandedIds = signal<ReadonlySet<string>>(new Set());
  /** Which calls are currently showing their diagnostics panel, by call id - nothing shows one until
   * asked. Keyed on the call rather than the row, so a bracketed pair can't end up with two. */
  private readonly diagIds = signal<ReadonlySet<string>>(new Set());

  readonly rows = computed<readonly WaterfallRow[]>(() => {
    const depths = this.depths();
    const foldedIds = this.listState.foldedIds();
    const out: WaterfallRow[] = [];

    // childIndex is the call's 1-based position among its parent's outbound calls - the same number
    // analyzeCall assigns, since both walk children in the order buildCallTree sorted them.
    const walk = (node: CallTreeNode, childIndex = 0): void => {
      const childIndexLabel = childIndex > 0 ? `#${childIndex}` : '';
      const info = depths.get(node.call.id);
      const hasBar = info?.spanStart != null && info.spanWidth != null;
      const durationMs = node.call.duration_ms ?? 0;
      const base = {
        call: node.call,
        depth: node.depth,
        rails: depthRails(node.depth),
        offsetPercent: `${((info?.spanStart ?? 0) * 100).toFixed(2)}%`,
        // Floored so a very short call inside a very long root is still visible as more than a line.
        widthPercent: `${Math.max((info?.spanWidth ?? 0) * 100, 0.8).toFixed(2)}%`,
        hasBar,
        isInstant: durationMs <= 0,
        label: labelFor(node.call),
        offsetLabel: formatOffset(info?.offsetMs ?? null),
        axisTotalLabel: null as string | null,
        // Set on whichever row opens the group below, never on a closing one - a group is divided
        // from the one before it, not from its own second half.
        startsRootGroup: false,
        selfTime: null as SelfTimeSplit | null,
        indexLabel: childIndexLabel,
        selectable: true,
        foldable: false,
        folded: false,
        foldedCount: 0,
        diagnosticsNode: null as CallTreeNode | null,
      };

      if (node.children.length === 0) {
        out.push({ ...base, kind: 'single', rowKey: node.call.id, startsRootGroup: node.depth === 0 });
        return;
      }

      const folded = foldedIds.has(node.call.id);
      out.push({
        ...base,
        kind: 'request',
        rowKey: `${node.call.id}:request`,
        // Only a group opener draws an axis - its children are all measured against this same root,
        // so one scale covers everything between this row and its closing row.
        axisTotalLabel: node.depth === 0 ? formatOffset(info?.rootDurationMs ?? null) : null,
        startsRootGroup: node.depth === 0,
        diagnosticsNode: node,
        foldable: true,
        folded,
        foldedCount: folded ? countDescendants(node) : 0,
      });
      // Folded: the bracket stays (it's two lines, and it's what carries the timing), but everything
      // between the halves goes - which on a deep trace is the whole point.
      if (!folded) node.children.forEach((child, i) => walk(child, i + 1));
      out.push({
        ...base,
        kind: 'response',
        rowKey: `${node.call.id}:response`,
        offsetLabel: formatOffset(info?.offsetMs != null ? info.offsetMs + durationMs : null),
        selfTime: selfTimeOf(node, info ?? null, depths),
        // The opening row already carries this call's checkbox - a second one here would be two
        // controls for one selection, able to disagree with each other on screen.
        selectable: false,
      });
    };

    for (const root of this.nodes()) walk(root, 0);
    return out;
  });

  /** Selection is shared state, so a call ticked here is ticked in the flat and nested views too -
   * and the bulk actions bar counts it - rather than this view keeping a second list of its own. */
  private readonly selection = inject(CALL_SELECTION_STATE);
  /** For the fold set, which the nested view shares - folding a call in one tree view folds it in
   * the other, since they're two drawings of the same tree rather than two different trees. */
  private readonly listState = inject(CALL_LIST_CONTROLS_STATE);

  isSelected(call: CallRecord): boolean {
    return this.selection.isSelected(call);
  }

  /** Like the nested view, a row's checkbox takes the call AND everything nested under it - a
   * bracketed row's whole span is its subtree, so anything narrower would contradict the bar. */
  subtreeSelection(call: CallRecord): 'none' | 'some' | 'all' {
    return this.selection.subtreeSelection(call);
  }

  toggleSelected(call: CallRecord): void {
    this.selection.setSubtreeSelected(call, this.subtreeSelection(call) !== 'all');
  }

  toggleFold(row: WaterfallRow): void {
    if (row.folded) this.listState.setFolded([row.call.id], false);
    else this.listState.setFolded(foldableIdsUnder(row.call.id, this.nodes()), true);
  }

  readonly methodClassOf = (call: CallRecord) => methodClass(call.method);
  readonly statusClassOf = (call: CallRecord) => statusClass(call.response?.status ?? null);
  readonly durationClassOf = (call: CallRecord) => durationClass(call.duration_ms);
  readonly inProgress = (call: CallRecord) => isInProgress(call);

  /** Spells out the self-time split in words on hover, so the two bar shades don't need a legend
   * repeated above every group. */
  durationTitle(row: WaterfallRow): string {
    const split = row.selfTime;
    if (!split) return '';
    return `${split.waitingMs} ms waiting on nested calls, ${split.selfMs} ms of its own work`;
  }

  isExpanded(id: string): boolean {
    return this.expandedIds().has(id);
  }

  toggle(id: string): void {
    const next = new Set(this.expandedIds());
    if (!next.delete(id)) next.add(id);
    this.expandedIds.set(next);
  }

  diagOpen(callId: string): boolean {
    return this.diagIds().has(callId);
  }

  toggleDiag(callId: string): void {
    const next = new Set(this.diagIds());
    if (!next.delete(callId)) next.add(callId);
    this.diagIds.set(next);
  }
}

/** "+1.85s" / "+340ms" - sub-second offsets keep millisecond precision, since that's exactly the
 * scale at which a track a few hundred pixels wide stops being able to show a difference. */
function formatOffset(ms: number | null): string {
  if (ms == null) return '';
  if (ms < 1000) return `+${Math.round(ms)}ms`;
  return `+${(ms / 1000).toFixed(2)}s`;
}

/**
 * Splits a parent's window into lead / waiting / tail against its DIRECT children only - a
 * grandchild is inside a child's own window, so it can never widen the waiting stretch.
 */
function selfTimeOf(
  node: CallTreeNode,
  info: CallDepthInfo | null,
  depths: ReadonlyMap<string, CallDepthInfo>
): SelfTimeSplit | null {
  if (!info || info.spanStart == null || info.spanWidth == null || info.rootDurationMs == null) return null;

  const childSpans = node.children
    .map((child) => depths.get(child.call.id))
    .filter((child): child is CallDepthInfo => child?.spanStart != null && child.spanWidth != null);
  if (childSpans.length === 0) return null;

  const ownStart = info.spanStart;
  const ownEnd = info.spanStart + info.spanWidth;
  const waitStart = Math.max(ownStart, Math.min(...childSpans.map((c) => c.spanStart!)));
  const waitEnd = Math.min(ownEnd, Math.max(...childSpans.map((c) => c.spanStart! + c.spanWidth!)));
  if (waitEnd <= waitStart) return null;

  const rootMs = info.rootDurationMs;
  const waitingMs = Math.round((waitEnd - waitStart) * rootMs);
  return {
    leadPercent: `${((waitStart - ownStart) * 100).toFixed(2)}%`,
    waitPercent: `${((waitEnd - waitStart) * 100).toFixed(2)}%`,
    tailPercent: `${((ownEnd - waitEnd) * 100).toFixed(2)}%`,
    waitingMs,
    selfMs: Math.max(0, Math.round((node.call.duration_ms ?? 0) - waitingMs)),
  };
}

function countDescendants(node: CallTreeNode): number {
  return node.children.reduce((total, child) => total + 1 + countDescendants(child), 0);
}

/**
 * The call `callId` plus every call under it that has children of its own - what folding takes with
 * it, so re-opening gives back one level. Found by walking `nodes` rather than threaded through the
 * row, since a row only carries its CallRecord.
 */
function foldableIdsUnder(callId: string, nodes: readonly CallTreeNode[]): string[] {
  const find = (list: readonly CallTreeNode[]): CallTreeNode | null => {
    for (const node of list) {
      if (node.call.id === callId) return node;
      const hit = find(node.children);
      if (hit) return hit;
    }
    return null;
  };
  const target = find(nodes);
  if (!target) return [callId];

  const below = (node: CallTreeNode): string[] =>
    node.children.flatMap((child) => (child.children.length > 0 ? [child.call.id, ...below(child)] : below(child)));
  return [callId, ...below(target)];
}

/** "core-service · api/pricing/quote" for an attributed call, host-qualified for an external one -
 * a waterfall line has no room for both full urls, and the path is what distinguishes siblings. */
function labelFor(call: CallRecord): string {
  const path = uriPath(call.url);
  if (call.source === 'internal') {
    return call.service_name ? `${call.service_name} · ${path}` : path;
  }
  return `${supplierOf(call)} · ${path}`;
}
