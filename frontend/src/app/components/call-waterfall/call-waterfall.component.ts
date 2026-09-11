import { Component, computed, input, signal } from '@angular/core';
import { CallRecord } from '../../core/models/call.model';
import { CallDepthInfo, CallTreeNode, depthRailPx } from '../../shared/utils/call-tree';
import { durationClass, isInProgress, methodClass, statusClass, supplierOf, uriPath } from '../../shared/utils/call-utils';
import { CallCardComponent } from '../call-card/call-card.component';

/** One flattened waterfall line - a call, how deep it sits, and where its bar goes. */
interface WaterfallRow {
  readonly call: CallRecord;
  readonly depth: number;
  readonly railPx: number;
  readonly offsetPercent: string;
  readonly widthPercent: string;
  readonly hasBar: boolean;
  readonly label: string;
}

/**
 * The 'waterfall' view (design B): every call as one compact line, hierarchy shown by a depth rail
 * and timing by a bar measured against its root call's window. Clicking a line expands the full
 * call card underneath it, so nothing is lost - it's just not all on screen at once.
 *
 * Rows keep tree order (each parent immediately followed by its own subtree) rather than the list's
 * sort order, which is why this view requires a chronological sort in the first place - see
 * CallViewMode. No request/response split here either: a bar's left and right edges already ARE the
 * call's start and end, so a pair of rows would only restate the geometry.
 */
@Component({
  selector: 'app-call-waterfall',
  standalone: true,
  imports: [CallCardComponent],
  template: `
    <div class="waterfall">
      @for (row of rows(); track row.call.id) {
        <div class="waterfall-line" [class.expanded]="isExpanded(row.call.id)">
          <button type="button" class="waterfall-row" (click)="toggle(row.call.id)">
            <span class="waterfall-rail" [style.width.px]="row.railPx" aria-hidden="true"></span>
            <span class="badge" [class]="methodClassOf(row.call)">{{ row.call.method }}</span>
            @if (inProgress(row.call)) {
              <span class="badge status-pending">In progress</span>
            } @else if (row.call.error) {
              <span class="badge status-err">ERROR</span>
            } @else {
              <span class="badge" [class]="statusClassOf(row.call)">{{ row.call.response?.status ?? '?' }}</span>
            }
            <span class="waterfall-label">{{ row.label }}</span>
            <span class="waterfall-track" aria-hidden="true">
              @if (row.hasBar) {
                <span class="waterfall-bar" [style.margin-left]="row.offsetPercent" [style.width]="row.widthPercent"></span>
              }
            </span>
            <span class="waterfall-duration" [class]="durationClassOf(row.call)">
              {{ row.call.error ? 'err' : row.call.duration_ms + ' ms' }}
            </span>
          </button>
          @if (isExpanded(row.call.id)) {
            <div class="waterfall-detail">
              <app-call-card [call]="row.call" />
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

  readonly rows = computed<readonly WaterfallRow[]>(() => {
    const depths = this.depths();
    const out: WaterfallRow[] = [];

    const walk = (node: CallTreeNode): void => {
      const info = depths.get(node.call.id);
      const hasBar = info?.spanStart != null && info.spanWidth != null;
      out.push({
        call: node.call,
        depth: node.depth,
        railPx: depthRailPx(node.depth),
        offsetPercent: `${((info?.spanStart ?? 0) * 100).toFixed(2)}%`,
        // Floored so a very short call inside a very long root is still visible as more than a line.
        widthPercent: `${Math.max((info?.spanWidth ?? 0) * 100, 0.8).toFixed(2)}%`,
        hasBar,
        label: labelFor(node.call),
      });
      for (const child of node.children) walk(child);
    };

    for (const root of this.nodes()) walk(root);
    return out;
  });

  readonly methodClassOf = (call: CallRecord) => methodClass(call.method);
  readonly statusClassOf = (call: CallRecord) => statusClass(call.response?.status ?? null);
  readonly durationClassOf = (call: CallRecord) => durationClass(call.duration_ms);
  readonly inProgress = (call: CallRecord) => isInProgress(call);

  isExpanded(id: string): boolean {
    return this.expandedIds().has(id);
  }

  toggle(id: string): void {
    const next = new Set(this.expandedIds());
    if (!next.delete(id)) next.add(id);
    this.expandedIds.set(next);
  }
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
