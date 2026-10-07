import { LogCounts } from '../../core/models/call-logs.model';
import { msText } from '../../shared/utils/db-statement-display';
import { CallDbSummary } from '../../core/models/db-capture.model';
import { CallLogCountsService } from '../../core/state/call-log-counts.service';
import { NgTemplateOutlet } from '@angular/common';
import { CommentBadgeComponent } from '../comment-badge/comment-badge.component';
import { DbCaptureStateService } from '../../core/state/db-capture-state.service';
import { Component, ElementRef, computed, inject, input, signal } from '@angular/core';
import { CdkDrag, CdkDragDrop, CdkDragHandle, CdkDropList, moveItemInArray } from '@angular/cdk/drag-drop';
import { CallRecord } from '../../core/models/call.model';
import { CallDepthInfo, CallTreeNode, DepthRail, depthRails, depthTintClass } from '../../shared/utils/call-tree';

import { durationClass, isInProgress, methodClass, statusClass, supplierOf, uriPath } from '../../shared/utils/call-utils';
import { CALL_LIST_CONTROLS_STATE, CALL_REORDER_STATE, CALL_SELECTION_STATE } from '../../core/state/call-selection.tokens';
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
import { PickCallButtonComponent } from '../pick-call-button/pick-call-button.component';
import { CallDiagnosticsComponent } from '../call-diagnostics/call-diagnostics.component';
import { SpacerChipComponent } from '../spacer-chip/spacer-chip.component';
import { InterceptionLogGroup, buildInterceptionLogGroups, openInterceptionRule, parseDelayMs } from '../../shared/utils/interception-log';
import { originalRefOf } from '../../shared/utils/resend-summary';
import { RuleDialogService } from '../../core/services/rule-dialog.service';
import { InterceptionApiService } from '../../core/services/interception-api.service';
import { CallFocusService } from '../../core/services/call-focus.service';

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
  /** This row's own level tint, set on the LINE so `--depth-color` is available to everything in it -
   * chiefly a bracketing row's background wash, which otherwise painted every parent the same purple
   * no matter how deep it sat. The rails inside re-set the variable for each ancestor they draw. */
  readonly ownTint: string;
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
  /** How many interception actions touched this call - 0 for the overwhelming majority. Drives the
   * `⚡ N` badge and the amber inset edge on the bar (F2). Set on every kind so a bracketed pair's
   * opening row can show it too, not only the closing one. */
  readonly interceptedCount: number;
  /** DELAY_REQUEST/DELAY_RESPONSE segments injected into this call, positioned against the same
   * root-relative scale as the bar itself - see delaySegmentsOf. Empty unless `hasBar` (only a
   * 'single' or 'response' row ever draws the real bar these overlay). */
  readonly delaySegments: readonly DelaySegment[];
  /** Set when this call is itself a resend - the id of its original and, only when that original is
   * also currently loaded (so a real comparison exists), how much slower/faster this run was. */
  readonly resend: ResendBadgeInfo | null;
}

/** One DELAY_REQUEST/DELAY_RESPONSE segment drawn as a hatched amber overlay on the bar - `offsetPercent`/
 * `widthPercent` are already root-relative (same scale as the row's own offsetPercent/widthPercent),
 * so the template positions it with a plain `left`/`width` inside the same `.waterfall-track`. */
interface DelaySegment {
  readonly side: 'lead' | 'tail';
  readonly ms: number;
  readonly offsetPercent: string;
  readonly widthPercent: string;
}

interface ResendBadgeInfo {
  readonly originalId: string;
  /** "-40% vs original" / "+12% vs original" - only when the original's own duration is known
   * (it's currently loaded too), else null so the badge reads "↻ resend" alone rather than guessing. */
  readonly percentLabel: string | null;
}

/**
 * One root call's whole run of lines (its opening row, every nested row, its closing row) - the unit
 * a spacer sits between, and so the unit CDK drags around: one cdkDrag per group rather than one per
 * line, which on a deep trace was most of the view's construction cost. Lines ahead of the first
 * root (none today, but rows() doesn't promise it) form a group with no root, which nothing can
 * anchor to.
 */
interface WaterfallGroup {
  readonly key: string;
  readonly root: CallRecord | null;
  readonly rows: readonly WaterfallRow[];
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
  imports: [CallCardComponent, CommentBadgeComponent, PickCallButtonComponent, CallDiagnosticsComponent, SpacerChipComponent, CdkDropList, CdkDrag, CdkDragHandle, NgTemplateOutlet],
  template: `
    <ng-template #waterfallSpacerComposer>
      <div class="spacer-row">
        <div class="spacer-line"></div>
        <div class="spacer-chip spacer-chip-editing">
          <input #newSpacerInput type="text" placeholder="Spacer name" (keydown.enter)="spacerGap.confirmNewSpacer(newSpacerInput.value)" (keydown.escape)="spacerGap.cancelSpacerEdit()" />
          <button type="button" class="spacer-icon-btn" (click)="spacerGap.confirmNewSpacer(newSpacerInput.value)" aria-label="Save">&#10003;</button>
          <button type="button" class="spacer-icon-btn" (click)="spacerGap.cancelSpacerEdit()" aria-label="Cancel">&#10005;</button>
        </div>
        <div class="spacer-line"></div>
      </div>
    </ng-template>
    <div class="waterfall" cdkDropList [cdkDropListDisabled]="!reorderState" (cdkDropListDropped)="onDrop($event)">
      @for (entry of mergedGroups(); track trackByMergedGroupKey(entry)) {
        @if (entry.kind === 'spacer') {
          <!-- \`detached\`: its position couldn't be worked out against what's shown (see layoutSpacers), so it sits at the end, dimmed, rather than vanishing. -->
          <div class="spacer-row" [class.spacer-row-detached]="entry.detached" cdkDrag>
            <span class="spacer-drag-handle" cdkDragHandle>&#8942;&#8942;</span>
            <div class="spacer-line"></div>
            <app-spacer-chip [spacer]="entry.spacer" [detached]="entry.detached" (rename)="reorderState?.renameSpacer(entry.spacer.id, $event)" (remove)="reorderState?.deleteSpacer(entry.spacer.id)" />
            <div class="spacer-line"></div>
          </div>
        } @else {
          @let group = entry.item;
          <!-- Never actually draggable (cdkDragDisabled) - only here so a spacer's drop position can land between two root groups. See onDrop. -->
          <div class="waterfall-group call-row" cdkDrag [cdkDragDisabled]="true">
          @if (group.root && reorderState) {
            @if (spacerGap.composingGapKey() === group.root.id) {
              <ng-container [ngTemplateOutlet]="waterfallSpacerComposer" />
            } @else {
              <!-- Sits immediately above the root group - hover-revealed, see .call-row. A spacer anchored to a nested child call shows here, above that child's root group (see layoutSpacers' rootOf). -->
              <div class="spacer-gap">
                <button type="button" class="add-spacer-btn" (click)="addSpacerAbove(group.root.id)">
                  <span>+ Add spacer</span>
                </button>
              </div>
            }
          }
          @for (row of group.rows; track row.rowKey) {
        <div
          class="waterfall-line"
          [class]="row.ownTint"
          [class.expanded]="isExpanded(row.rowKey)"
          [class.waterfall-open]="row.kind === 'request'"
          [class.waterfall-close]="row.kind === 'response'"
          [class.waterfall-root-start]="row.startsRootGroup"
          [class.waterfall-row-flash]="flashCallId() === row.call.id"
          [attr.data-call-row]="row.call.id"
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
            @if (row.kind !== 'response') {
              <!-- Once per call: a split call's request row carries it, its response row does not. -->
              <app-comment-badge [callId]="row.call.id" [mini]="true" />
              @if (dbSummary(row.call.id); as db) {
                @if (db.failedCount) {
                  <span class="db-fail-mark" [title]="db.statementCount + ' database statements, ' + db.failedCount + ' failed - open the call for the DB chip'">&#10006; DB {{ db.statementCount }} · {{ db.failedCount }} failed</span>
                } @else if (db.statementCount) {
                  <span class="db-fail-mark ok" [title]="db.statementCount + ' database statement' + (db.statementCount > 1 ? 's' : '') + ' - open the call for the DB chip'">&#9670; DB {{ db.statementCount }} · {{ dbMs(db.dbMicros) }}</span>
                }
              }
              @if (logCounts(row.call.id); as lc) {
                @if (lc.errors || lc.warnings) {
                  <span class="db-fail-mark" [class.warn]="!lc.errors" [title]="logTitle(lc)">&#9636;@if (lc.errors) { {{ lc.errors }} err}@if (lc.errors && lc.warnings) { ·}@if (lc.warnings) { {{ lc.warnings }} warn}</span>
                }
              }
            }
            @if (row.interceptedCount > 0) {
              <!-- Indicator only - a button may not contain another, so the clickable badge that
                   opens the hover card is a SIBLING of this row button (see below). -->
              <span class="badge intercept-badge-mini" aria-hidden="true">&#9889; {{ row.interceptedCount }}</span>
            }
            @if (row.resend; as resend) {
              <span class="badge resend-badge-mini" aria-hidden="true">
                <span>&#8635; resend</span>
                @if (resend.percentLabel) {
                  <span class="resend-badge-percent">{{ resend.percentLabel }}</span>
                }
              </span>
            }
            @if (row.indexLabel) {
              <span class="waterfall-index">{{ row.indexLabel }}</span>
            }
            <span class="waterfall-label">{{ row.label }}</span>
            @if (row.foldedCount > 0) {
              <span class="waterfall-folded-count">{{ row.foldedCount }} folded</span>
            }
            <span class="waterfall-offset">{{ row.offsetLabel }}</span>
            <span class="waterfall-track" [class.waterfall-track-intercepted]="row.interceptedCount > 0" [class.waterfall-track-resent]="!!row.resend" aria-hidden="true">
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
                  <!-- Injected delay(s), overlaid on top of the bar just drawn above rather than in
                       its own flow position - see delaySegmentsOf for why these are already
                       root-relative and don't need a separate margin-left dance. -->
                  @for (segment of row.delaySegments; track $index) {
                    <span
                      class="waterfall-delay"
                      [class.waterfall-delay-lead]="segment.side === 'lead'"
                      [class.waterfall-delay-tail]="segment.side === 'tail'"
                      [style.left]="segment.offsetPercent"
                      [style.width]="segment.widthPercent"
                      [title]="segment.ms + ' ms injected'"
                    ></span>
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
              @if (row.delaySegments.length > 0) {
                <span class="waterfall-delay-label">{{ delayLabel(row) }}</span>
              }
            </span>
            </button>
            <!-- Two more row buttons, siblings of waterfall-row-main for the same reason app-pick-call
                 is below: a button may not contain another. -->
            @if (row.interceptedCount > 0) {
              <button
                type="button"
                class="waterfall-badge-btn"
                title="Show the rules that changed this call"
                aria-label="Show the rules that changed this call"
                [attr.aria-expanded]="hoverCardOpen(row.rowKey)"
                (click)="toggleHoverCard(row.rowKey, $event)"
              ><svg class="waterfall-bolt-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M13.8 2 4.9 13h6l-.7 9 9-12h-6.1l.7-8z" fill="currentColor" /></svg></button>
            }
            @if (row.resend) {
              <button
                type="button"
                class="waterfall-badge-btn"
                [title]="row.resend.percentLabel ? 'Scroll to the original - ' + row.resend.percentLabel : 'Scroll to the original this call resent'"
                (click)="focusOriginal(row, $event)"
              >&#8635;</button>
            }
            @if (row.interceptedCount > 0 && hoverCardOpen(row.rowKey)) {
              <div class="waterfall-hover-card" role="dialog" aria-label="What changed this call">
                @for (group of interceptionGroups(row); track $index) {
                  <div class="waterfall-hover-group">
                    <div class="waterfall-hover-group-head">
                      <strong>{{ group.ruleName }}</strong>
                      @if (group.ruleId) {
                        <button type="button" class="pill" [disabled]="openingRule(group.ruleId)" (click)="openRule(group.ruleId, $event)">
                          {{ openingRule(group.ruleId) ? 'Opening…' : 'Open rule ↗' }}
                        </button>
                      }
                    </div>
                    @for (action of group.actions; track action.number) {
                      <div class="waterfall-hover-step">
                        <span>{{ group.ruleName }}</span> · <span>{{ action.label }}</span>
                        @if (action.entry.detail) { <span class="waterfall-hover-detail">{{ action.entry.detail }}</span> }
                      </div>
                    }
                  </div>
                }
                @if (ruleOpenError()) { <div class="waterfall-hover-error" role="alert">{{ ruleOpenError() }}</div> }
                <button type="button" class="pill" (click)="showWhatChanged(row, $event)">Show what changed</button>
              </div>
            }
            <!-- A sibling, not inside the row button: a button may not contain another. -->
            <app-pick-call [call]="row.call" />
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
        }
      }
      @if (reorderState) {
        @if (spacerGap.composingGapKey() === null) {
          <ng-container [ngTemplateOutlet]="waterfallSpacerComposer" />
        } @else {
          <!-- Sits after the last root group. -->
          <div class="spacer-gap">
            <button type="button" class="add-spacer-btn" (click)="addSpacerAtTail()">
              <span>+ Add spacer</span>
            </button>
          </div>
        }
      }
    </div>
    @if (hasBadges()) {
      <!-- Only shown when the loaded window actually has something to explain - a trace with no
           intercepted or resent calls gets no legend at all rather than one nobody needs. -->
      <div class="waterfall-legend">
        @if (hasIntercepted()) {
          <span class="waterfall-legend-item"><span class="waterfall-legend-swatch waterfall-legend-intercepted">&#9889;</span> Intercepted</span>
          <span class="waterfall-legend-item"><span class="waterfall-legend-swatch waterfall-legend-delay"></span> Injected delay</span>
        }
        @if (hasResent()) {
          <span class="waterfall-legend-item"><span class="waterfall-legend-swatch waterfall-legend-resent">&#8635;</span> Resend</span>
        }
      </div>
    }
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

  /** Every currently-loaded call, by id - what resendBadgeInfoOf uses to find a resend's original
   * (for the duration comparison) when it's also loaded. Built once per render of the tree rather
   * than searched per row. */
  private readonly callsById = computed<ReadonlyMap<string, CallRecord>>(() => {
    const map = new Map<string, CallRecord>();
    const walk = (node: CallTreeNode): void => {
      map.set(node.call.id, node.call);
      node.children.forEach(walk);
    };
    this.nodes().forEach(walk);
    return map;
  });

  readonly rows = computed<readonly WaterfallRow[]>(() => {
    const depths = this.depths();
    const foldedIds = this.listState.foldedIds();
    const callsById = this.callsById();
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
        ownTint: depthTintClass(node.depth),
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
        interceptedCount: node.call.interception?.applied.length ?? 0,
        delaySegments: hasBar ? delaySegmentsOf(node.call, info!) : [],
        resend: resendBadgeInfoOf(node.call, callsById),
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

  /** Non-null only on a session-cycle detail page - see CALL_REORDER_STATE. */
  readonly reorderState = inject(CALL_REORDER_STATE, { optional: true });
  readonly spacerGap = createSpacerGapController(this.reorderState);

  /** rows() cut into one group per root call - see WaterfallGroup. */
  readonly groups = computed<readonly WaterfallGroup[]>(() => {
    const out: { key: string; root: CallRecord | null; rows: WaterfallRow[] }[] = [];
    for (const row of this.rows()) {
      if (row.startsRootGroup || out.length === 0) {
        out.push({ key: row.startsRootGroup ? row.rowKey : `lead:${row.rowKey}`, root: row.startsRootGroup ? row.call : null, rows: [] });
      }
      out[out.length - 1].rows.push(row);
    }
    return out;
  });

  private static readonly groupAnchorCall = (group: WaterfallGroup): CallRecord | null => group.root;

  private readonly spacerOrder = computed(() => spacerOrderFor(this.listState.sortMode()));

  /** Nested child call id -> its root's id, so a spacer anchored to a child sits above that child's root group instead of vanishing. */
  private readonly rootOfChild = computed(() => rootIndex(this.nodes().map((node) => node.call), this.listState.descendants()));

  /**
   * groups() with every spacer spliced in between them - spacers only ever sit between root groups
   * here, mirroring the nested view. A spacer whose anchor isn't shown is placed by its anchor's
   * timestamp instead of being dropped - see layoutSpacers for every rule.
   */
  private readonly layout = computed<SpacerLayout<WaterfallGroup>>(() => {
    const rootOf = this.rootOfChild();
    return layoutSpacers(this.groups(), CallWaterfallComponent.groupAnchorCall, this.reorderState?.spacers() ?? [], this.spacerOrder(), (id) => rootOf.get(id));
  });
  readonly mergedGroups = computed(() => this.layout().merged);

  readonly trackByMergedGroupKey = (entry: MergedWithSpacer<WaterfallGroup>) => (entry.kind === 'item' ? entry.item.key : `spacer:${entry.spacer.id}`);

  /** Opens the composer in the gap above this root group - see CallListComponent.addSpacerAbove for why the anchor comes from the layout. */
  addSpacerAbove(rootId: string): void {
    this.spacerGap.addSpacerAt(rootId, this.layout().gapAnchors.get(rootId) ?? HEAD_ANCHOR);
  }

  addSpacerAtTail(): void {
    this.spacerGap.addSpacerAt(null, this.layout().tailAnchor);
  }

  /** Groups never move (their cdkDrag is disabled), so only a dropped spacer is ever re-anchored. */
  onDrop(event: CdkDragDrop<readonly MergedWithSpacer<WaterfallGroup>[]>): void {
    if (!this.reorderState || event.previousIndex === event.currentIndex) return;
    const merged = [...this.mergedGroups()];
    moveItemInArray(merged, event.previousIndex, event.currentIndex);
    reanchorDroppedSpacer(merged, event.currentIndex, CallWaterfallComponent.groupAnchorCall, this.spacerOrder().descending, this.reorderState);
  }

  /** Selection is shared state, so a call ticked here is ticked in the flat and nested views too -
   * and the bulk actions bar counts it - rather than this view keeping a second list of its own. */
  private readonly selection = inject(CALL_SELECTION_STATE);
  /** For the fold set, which the nested view shares - folding a call in one tree view folds it in
   * the other, since they're two drawings of the same tree rather than two different trees. */
  private readonly listState = inject(CALL_LIST_CONTROLS_STATE);
  private readonly dbState = inject(DbCaptureStateService);
  private readonly logCountsState = inject(CallLogCountsService);

  /** A row's DB mark: its statement count, red with the failed ones (its ◆ DB summary - the list states request one per loaded inbound call). */
  dbMs(micros: number): string {
    return msText(micros);
  }

  dbSummary(callId: string): CallDbSummary | undefined {
    return this.dbState.summaries().get(callId);
  }

  /** A row's log mark: its ERROR and WARN line counts (the list states request counts for every loaded inbound call). */
  logCounts(callId: string): LogCounts | undefined {
    return this.logCountsState.counts().get(callId);
  }

  logTitle(c: LogCounts): string {
    const parts = [c.errors ? `${c.errors} error` : '', c.warnings ? `${c.warnings} warning` : ''].filter(Boolean).join(' and ');
    return `${parts} log line${c.errors + c.warnings > 1 ? 's' : ''} during this call (${c.lines} in all) - open the call for the Logs chip`;
  }

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

  // ---- F2: interception/resend badges, hover card, and delay/comparison labels ----

  readonly hasIntercepted = computed(() => this.rows().some((r) => r.interceptedCount > 0));
  readonly hasResent = computed(() => this.rows().some((r) => r.resend != null));
  readonly hasBadges = computed(() => this.hasIntercepted() || this.hasResent());

  /** Which row's hover card (the ⚡ badge's rule list) is currently open, by rowKey - only one at a
   * time, same idea as diagIds but keyed to the badge rather than the call. */
  private readonly hoverRowKey = signal<string | null>(null);
  private readonly ruleDialog = inject(RuleDialogService);
  private readonly interceptionApi = inject(InterceptionApiService);
  private readonly callFocus = inject(CallFocusService);
  private readonly hostRef = inject(ElementRef<HTMLElement>);
  private readonly openingRuleId = signal<string | null>(null);
  readonly ruleOpenError = signal('');
  /** The call whose row should scroll into view and flash once - see focusOriginal(). Separate from
   * `expandedIds`/`hoverRowKey`: flashing doesn't expand or open anything, it just points at a row. */
  readonly flashCallId = signal<string | null>(null);

  hoverCardOpen(rowKey: string): boolean {
    return this.hoverRowKey() === rowKey;
  }

  toggleHoverCard(rowKey: string, event: Event): void {
    event.stopPropagation();
    this.hoverRowKey.update((current) => (current === rowKey ? null : rowKey));
  }

  /** Reuses buildInterceptionLogGroups - the exact grouping CallCardComponent's own interception log
   * uses - so the hover card's "name · type · detail" list can never disagree with what the card
   * shows once expanded. */
  interceptionGroups(row: WaterfallRow): readonly InterceptionLogGroup[] {
    return buildInterceptionLogGroups(row.call.interception);
  }

  /** "Open rule" in the hover card - the same lookup-then-open flow as CallCardComponent's own
   * "Edit rule ↗", extracted into openInterceptionRule so the two can't drift on what happens when
   * the rule has since been deleted or the fetch fails. */
  openRule(ruleId: string, event: Event): void {
    event.stopPropagation();
    if (this.openingRuleId()) return;
    this.ruleOpenError.set('');
    this.openingRuleId.set(ruleId);
    openInterceptionRule(this.interceptionApi, this.ruleDialog, ruleId, {
      onError: (message) => this.ruleOpenError.set(message),
      onDone: () => this.openingRuleId.set(null),
    });
  }

  openingRule(ruleId: string): boolean {
    return this.openingRuleId() === ruleId;
  }

  /** "Show what changed" in the hover card - rather than duplicating the diff viewer, this just
   * expands the row (see toggle()), which already renders app-call-card with its own interception
   * panels for exactly this call. */
  showWhatChanged(row: WaterfallRow, event: Event): void {
    event.stopPropagation();
    this.hoverRowKey.set(null);
    if (!this.isExpanded(row.rowKey)) this.toggle(row.rowKey);
  }

  /** "1500 ms injected" / "1500 ms + 300 ms injected" - one label for however many delay segments a
   * call carries, so a call delayed on both halves states both rather than only the first. */
  delayLabel(row: WaterfallRow): string {
    return row.delaySegments.map((s) => `${s.ms} ms`).join(' + ') + ' injected';
  }

  /**
   * Clicking a resend badge - scroll to and flash the original if its row is part of this SAME tree
   * (the common case: a resend usually sits right beside what it resent), else fall back to
   * CallFocusService's cross-page navigation (which also selects the right source and highlights
   * once the target page's own card mounts).
   */
  focusOriginal(row: WaterfallRow, event: Event): void {
    event.stopPropagation();
    const resend = row.resend;
    if (!resend) return;
    const foundLocally = this.rows().some((r) => r.call.id === resend.originalId);
    if (foundLocally) {
      this.flashCallId.set(resend.originalId);
      const target = this.hostRef.nativeElement.querySelector(`[data-call-row="${cssEscapeId(resend.originalId)}"]`);
      target?.scrollIntoView({ block: 'center', behavior: 'smooth' });
      setTimeout(() => this.flashCallId.set(null), 2400);
      return;
    }
    const ref = originalRefOf(row.call);
    if (!ref) return;
    this.callFocus.go({ callId: ref.callId, cycleId: ref.cycleId, direction: ref.source === 'internal' ? 'inbound' : 'outbound', serviceName: null });
  }
}

/** `CSS.escape` when available (every real browser); a plain quote-escape fallback keeps this
 * working in a test environment that stubs it out. */
function cssEscapeId(id: string): string {
  return typeof CSS !== 'undefined' && typeof CSS.escape === 'function' ? CSS.escape(id) : id.replace(/"/g, '\\"');
}

/**
 * DELAY_REQUEST/DELAY_RESPONSE segments for one call, positioned on the same root-relative 0-1
 * scale as the row's own bar (`info.spanStart`/`info.spanWidth`) so the template can overlay them
 * with a plain `left`/`width` inside `.waterfall-track`. A request delay pads the LEAD of the bar
 * (it happens before the call goes out); a response delay pads the TAIL (it happens after upstream
 * answered, before the call returns) - see contracts.md §5's DELAY_* actions.
 */
function delaySegmentsOf(call: CallRecord, info: CallDepthInfo): readonly DelaySegment[] {
  const spanStart = info.spanStart;
  const spanWidth = info.spanWidth;
  const durationMs = call.duration_ms ?? 0;
  if (spanStart == null || spanWidth == null || durationMs <= 0) return [];

  const segments: DelaySegment[] = [];
  for (const applied of call.interception?.applied ?? []) {
    const side = applied.action === 'DELAY_REQUEST' ? 'lead' : applied.action === 'DELAY_RESPONSE' ? 'tail' : null;
    if (!side) continue;
    const ms = parseDelayMs(applied.detail);
    if (ms == null) continue;
    // Capped at the bar's own width - a delay that (per its recorded detail) somehow exceeds the
    // call's total duration must not paint past the bar it's meant to be part of.
    const widthFrac = Math.min(spanWidth, (ms / durationMs) * spanWidth);
    const offsetFrac = side === 'lead' ? spanStart : spanStart + spanWidth - widthFrac;
    segments.push({ side, ms, offsetPercent: `${(offsetFrac * 100).toFixed(2)}%`, widthPercent: `${(widthFrac * 100).toFixed(2)}%` });
  }
  return segments;
}

/**
 * Whether `call` is a resend, and - only when its original is part of the SAME currently-loaded
 * window - how its duration compares. `callsById` is scoped to what's actually on screen (see
 * `callsById` above), so an original from a page that hasn't been loaded, or that scrolled out of a
 * paginated backend window, correctly reads as "unknown" rather than guessing.
 */
function resendBadgeInfoOf(call: CallRecord, callsById: ReadonlyMap<string, CallRecord>): ResendBadgeInfo | null {
  if (!call.resendOf) return null;
  const original = callsById.get(call.resendOf);
  if (!original || original.duration_ms == null || original.duration_ms <= 0 || call.duration_ms == null) {
    return { originalId: call.resendOf, percentLabel: null };
  }
  const percent = Math.round(((call.duration_ms - original.duration_ms) / original.duration_ms) * 100);
  const sign = percent > 0 ? '+' : '';
  return { originalId: call.resendOf, percentLabel: `${sign}${percent}% vs original` };
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
