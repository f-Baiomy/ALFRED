import { ChangeDetectionStrategy, Component, ElementRef, Injector, afterNextRender, computed, effect, inject, input, output, signal, untracked } from '@angular/core';
import { NgTemplateOutlet } from '@angular/common';
import { CallRecord } from '../../core/models/call.model';
import { CycleSpacer } from '../../core/state/call-selection.tokens';
import { CallDepthInfo, CallTreeNode, DepthRail, depthRails, depthTintClass, indexDescendants } from '../../shared/utils/call-tree';
import { methodClass, statusClass, supplierOf, uriPath } from '../../shared/utils/call-utils';
import { SpacerAnchor, layoutSpacers, rootIndex } from '../../shared/utils/spacer-gap-controller';
import { CwIconComponent } from './cw-icon.component';

export interface MiniWaterfallRow {
  readonly call: CallRecord;
  readonly depth: number;
  readonly rails: readonly DepthRail[];
  readonly tint: string;
  readonly childCount: number;
  readonly descendantCount: number;
  readonly folded: boolean;
  readonly offsetPercent: string;
  readonly widthPercent: string;
  readonly hasBar: boolean;
  readonly inProgress: boolean;
  readonly direction: 'inbound' | 'outbound';
  readonly service: string | null;
  readonly path: string;
  readonly statusText: string;
  readonly statusClass: string;
  readonly methodClass: string;
  readonly durationLabel: string;
}

/** One line of the waterfall: a call, a spacer, or the hover-to-add gap between two root groups. */
export type MiniWaterfallEntry =
  | { readonly kind: 'row'; readonly key: string; readonly row: MiniWaterfallRow }
  | { readonly kind: 'spacer'; readonly key: string; readonly spacer: CycleSpacer; readonly detached: boolean }
  | { readonly kind: 'gap'; readonly key: string; readonly anchor: SpacerAnchor; readonly divider: boolean };

/** A spacer the user wants: its label and where it goes. */
export interface SpacerRequest {
  readonly label: string;
  readonly anchor: SpacerAnchor;
}

/**
 * The widget's compact waterfall: one line per call, nested at ANY depth (the tree itself is
 * uncapped - see CallTreeNode.depth), each parent foldable and badged with how many calls sit
 * underneath it. A deliberately small cousin of CallWaterfallComponent rather than a reuse of it:
 * that one is page-sized (cards that open in place, diagnostics, the list-state service) and none of
 * that fits a 420px floating window. It shares the tree, the per-call span fractions, the depth rail
 * colours and - for spacers - layoutSpacers itself, so a spacer sits exactly where the cycle page's
 * waterfall puts it: between root groups only, with one anchored to a nested call placed by that
 * call's root group (see layoutSpacers' rootOf).
 */
@Component({
  selector: 'app-mini-waterfall',
  standalone: true,
  imports: [CwIconComponent, NgTemplateOutlet],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="cw-wf-head">
      <span>Waterfall</span>
      @if (maxDepth() > 0) {
        <span class="cw-faint">· {{ maxDepth() + 1 }} levels</span>
      }
      <span class="cw-seg" role="group" aria-label="Order">
        <button type="button" [class.sel]="!descending()" (click)="orderChange.emit('oldest')">Oldest first</button>
        <button type="button" [class.sel]="descending()" (click)="orderChange.emit('newest')">Newest first</button>
      </span>
      <span class="cw-spacer"></span>
      @if (hasParents()) {
        <button type="button" class="cw-link" (click)="expandAll()" title="Expand all">Expand</button>
        <button type="button" class="cw-link" (click)="collapseAll()" title="Collapse all">Collapse</button>
      }
      <button type="button" class="cw-link" (click)="startAdding('latest')" title="Add a spacer after the latest call">+ Spacer</button>
    </div>

    @if (composingAt() === 'latest') {
      <ng-container *ngTemplateOutlet="composer" />
    }

    @for (entry of entries(); track entry.key) {
      @switch (entry.kind) {
        @case ('gap') {
          @if (composingAt() === entry.key) {
            <ng-container *ngTemplateOutlet="composer" />
          } @else {
            <button type="button" class="cw-wf-gap" [class.divider]="entry.divider" (click)="startAdding(entry.key, entry.anchor)" title="Add a spacer here">
              <span>+ spacer here</span>
            </button>
          }
        }
        @case ('spacer') {
          <div class="cw-wf-spacer" [class.detached]="entry.detached" [title]="entry.detached ? 'Its place is hidden right now, so it sits at the end' : ''">
            @if (editingId() === entry.spacer.id) {
              <input
                class="cw-input cw-wf-spacer-input"
                [value]="entry.spacer.label"
                (keydown.enter)="finishRename(entry.spacer, $any($event.target).value)"
                (keydown.escape)="editingId.set(null)"
                (blur)="finishRename(entry.spacer, $any($event.target).value)"
                aria-label="Spacer label"
              />
            } @else {
              <button type="button" class="cw-wf-spacer-label" (click)="startRename(entry.spacer.id)" title="Rename">{{ entry.spacer.label }}</button>
              <button type="button" class="cw-wf-spacer-x" (click)="deleteSpacer.emit(entry.spacer)" aria-label="Delete spacer" title="Delete spacer">
                <app-cw-icon name="x" />
              </button>
            }
          </div>
        }
        @case ('row') {
          @let row = entry.row;
          <div
            class="cw-wf-row"
            [class.cw-flash]="row.call.id === flashId()"
            [class.selected]="row.call.id === selectedId()"
            [attr.data-call-id]="row.call.id"
            (click)="toggleSelected(row.call.id)"
            [title]="row.call.method + ' ' + row.call.url"
          >
            @for (rail of row.rails; track $index) {
              <span class="cw-wf-rail" [class]="rail.tint" [class.own]="rail.own"></span>
            }
            @if (row.childCount > 0) {
              <button type="button" class="cw-wf-fold" (click)="$event.stopPropagation(); toggleFold(row.call.id)" [attr.aria-label]="row.folded ? 'Expand' : 'Collapse'">
                <app-cw-icon [name]="row.folded ? 'chevron-right' : 'chevron-down'" />
              </button>
            } @else {
              <span class="cw-wf-fold-gap"></span>
            }
            <span class="cw-wf-label" [style.width.px]="labelWidth(row.depth)">
              <app-cw-icon class="cw-dir" [class.inbound]="row.direction === 'inbound'" [name]="row.direction" />
              <span class="cw-method" [class]="row.methodClass">{{ row.call.method }}</span>
              <span class="cw-wf-path" [class.root]="row.depth === 0">
                @if (row.service) {
                  <span class="cw-faint">{{ row.service }}</span>
                }
                {{ row.path }}
              </span>
            </span>
            @if (row.descendantCount > 0) {
              <span class="cw-wf-count" [class]="row.tint" [title]="row.descendantCount + ' calls inside'">
                {{ row.folded ? '+' : '' }}{{ row.descendantCount }}
              </span>
            }
            <span class="cw-wf-track">
              @if (row.hasBar) {
                <span
                  class="cw-wf-bar"
                  [class]="row.tint"
                  [class.error]="row.statusClass === 'status-5xx' || row.statusClass === 'status-err'"
                  [class.pending]="row.inProgress"
                  [style.left]="row.offsetPercent"
                  [style.width]="row.widthPercent"
                ></span>
              }
            </span>
            <span class="cw-wf-status" [class]="row.statusClass">{{ row.statusText }}</span>
            <span class="cw-wf-dur">{{ row.durationLabel }}</span>
          </div>
          @if (row.call.id === selectedId()) {
            <div class="cw-wf-detail" [style.margin-left.px]="8 + row.depth * 10">
              <div class="cw-wf-detail-url">{{ row.call.method }} {{ row.call.url }}</div>
              <div class="cw-faint">{{ detailLine(row) }}</div>
              <div class="cw-wf-detail-actions">
                <button type="button" class="cw-primary cw-wf-show" (click)="showInCycle.emit(row.call)">
                  <app-cw-icon name="external" /> Show in cycle
                </button>
                <button type="button" class="cw-ib" (click)="copyUrl(row.call)" [attr.aria-label]="copied() ? 'Copied' : 'Copy URL'" [title]="copied() ? 'Copied' : 'Copy URL'">
                  <app-cw-icon [name]="copied() ? 'check' : 'copy'" />
                </button>
              </div>
            </div>
          }
        }
      }
    }
    <!-- On "no call rows", not "no entries": a cycle's spacers still show when all its calls are hidden. -->
    @if (nodes().length === 0) {
      <div class="cw-wf-empty">
        {{ emptyText() }}
        @if (emptyAction(); as action) {
          <button type="button" class="cw-link" (click)="emptyActionClick.emit()">{{ action }}</button>
        }
      </div>
    }

    <ng-template #composer>
      <form class="cw-wf-composer" (submit)="$event.preventDefault(); finishAdding(label.value)">
        <input #label class="cw-input" placeholder="Step 2: payment" aria-label="Spacer label" (keydown.escape)="composingAt.set(null)" />
        <button type="submit" class="cw-primary">Add</button>
        <button type="button" class="cw-ib" (click)="composingAt.set(null)" aria-label="Cancel"><app-cw-icon name="x" /></button>
      </form>
    </ng-template>
  `,
})
export class MiniWaterfallComponent {
  readonly nodes = input.required<readonly CallTreeNode[]>();
  readonly depths = input.required<ReadonlyMap<string, CallDepthInfo>>();
  readonly spacers = input<readonly CycleSpacer[]>([]);
  /** Newest first: "after a call" in time is then ABOVE it (see layoutSpacers). */
  readonly descending = input(false);
  /** Folds, selection and any half-typed spacer are per cycle - a change of cycle clears them. */
  readonly cycleId = input<string | null>(null);
  readonly emptyText = input('No calls yet.');
  /** A one-click fix shown with the empty text (e.g. "Show OPTIONS"), or none. */
  readonly emptyAction = input<string | null>(null);
  readonly emptyActionClick = output<void>();
  /** The call that just arrived, briefly highlighted. */
  readonly flashId = input<string | null>(null);
  /** Anchor for "after the latest call" - the newest call in the cycle, even one not shown. */
  readonly latestAnchor = input<SpacerAnchor>({ afterCallId: null, anchorTimestamp: null });

  readonly orderChange = output<'oldest' | 'newest'>();
  readonly addSpacer = output<SpacerRequest>();
  readonly renameSpacer = output<{ spacer: CycleSpacer; label: string }>();
  readonly deleteSpacer = output<CycleSpacer>();
  readonly showInCycle = output<CallRecord>();

  private readonly folded = signal<ReadonlySet<string>>(new Set());
  readonly selectedId = signal<string | null>(null);
  readonly editingId = signal<string | null>(null);
  /** Which gap's composer is open: a gap key, 'latest' (the header's "+ Spacer"), or none. */
  readonly composingAt = signal<string | null>(null);
  private composingAnchor: SpacerAnchor | null = null;
  readonly copied = signal(false);
  private readonly host = inject(ElementRef<HTMLElement>);
  private readonly injector = inject(Injector);

  constructor() {
    // Whatever just opened for typing gets the caret.
    effect(() => {
      const composing = this.composingAt();
      const editing = this.editingId();
      if (!composing && !editing) return;
      afterNextRender(
        () => {
          const input = (this.host.nativeElement as HTMLElement).querySelector<HTMLInputElement>(editing ? '.cw-wf-spacer-input' : '.cw-wf-composer input');
          input?.focus();
          if (editing) input?.select();
        },
        { injector: this.injector }
      );
    });
    effect(() => {
      this.cycleId();
      untracked(() => {
        this.folded.set(new Set());
        this.selectedId.set(null);
        this.editingId.set(null);
        this.composingAt.set(null);
      });
    });
    // A call arriving under a folded parent unfolds the path to it, or the flash would be invisible.
    effect(() => {
      const id = this.flashId();
      if (!id) return;
      untracked(() => {
        const depths = this.depths();
        const next = new Set(this.folded());
        let parent = depths.get(id)?.parentId ?? null;
        while (parent) {
          next.delete(parent);
          parent = depths.get(parent)?.parentId ?? null;
        }
        this.folded.set(next);
      });
    });
  }

  readonly maxDepth = computed(() => {
    let max = -1;
    for (const info of this.depths().values()) max = Math.max(max, info.depth);
    return max;
  });

  readonly hasParents = computed(() => this.nodes().some((n) => n.children.length > 0));

  /** Maps any nested call to its root, so a spacer anchored to a sub-call lands next to that call's root group. */
  private readonly rootOf = computed(() => rootIndex(this.nodes().map((n) => n.call), indexDescendants(this.nodes())));

  readonly entries = computed<readonly MiniWaterfallEntry[]>(() => {
    const depths = this.depths();
    const folded = this.folded();
    const rootOf = this.rootOf();
    const layout = layoutSpacers(this.nodes(), (node) => node.call, this.spacers(), { descending: this.descending(), byTime: true }, (id) => rootOf.get(id));

    const out: MiniWaterfallEntry[] = [];
    const walk = (node: CallTreeNode): void => {
      const isFolded = folded.has(node.call.id);
      out.push({ kind: 'row', key: `row-${node.call.id}`, row: toRow(node, depths.get(node.call.id), isFolded) });
      if (!isFolded) node.children.forEach(walk);
    };
    let roots = 0;
    for (const entry of layout.merged) {
      if (entry.kind === 'spacer') {
        out.push({ kind: 'spacer', key: `spacer-${entry.spacer.id}`, spacer: entry.spacer, detached: entry.detached });
        continue;
      }
      const root = entry.item;
      // The hover-to-add gap sits above every root group; between two groups it also draws the divider.
      out.push({ kind: 'gap', key: `gap-${root.call.id}`, anchor: layout.gapAnchors.get(root.call.id)!, divider: roots > 0 });
      roots++;
      walk(root);
    }
    if (roots > 0) out.push({ kind: 'gap', key: 'gap-tail', anchor: layout.tailAnchor, divider: false });
    return out;
  });

  toggleFold(id: string): void {
    const next = new Set(this.folded());
    if (next.has(id)) next.delete(id);
    else next.add(id);
    this.folded.set(next);
  }

  expandAll(): void {
    this.folded.set(new Set());
  }

  /** Folds the roots only - reopening one then shows its next level, not everything at once. */
  collapseAll(): void {
    this.folded.set(new Set(this.nodes().filter((n) => n.children.length > 0).map((n) => n.call.id)));
  }

  toggleSelected(id: string): void {
    this.selectedId.set(this.selectedId() === id ? null : id);
    this.copied.set(false);
  }

  /** Time, duration, and which call it sits inside - the facts a one-line row has no room for. */
  detailLine(row: MiniWaterfallRow): string {
    const parts = [new Date(row.call.timestamp).toLocaleTimeString()];
    if (row.durationLabel) parts.push(row.durationLabel);
    const parentId = this.depths().get(row.call.id)?.parentId;
    const parent = parentId ? this.findCall(parentId) : null;
    if (parent) parts.push(`inside ${parent.method} ${uriPath(parent.url)}`);
    return parts.join(' · ');
  }

  copyUrl(call: CallRecord): void {
    void navigator.clipboard?.writeText(call.url).then(
      () => this.copied.set(true),
      () => this.copied.set(false)
    );
  }

  startAdding(key: string, anchor?: SpacerAnchor): void {
    this.composingAt.set(key);
    this.composingAnchor = anchor ?? null;
  }

  finishAdding(value: string): void {
    const label = value.trim();
    if (!label) return;
    this.addSpacer.emit({ label, anchor: this.composingAnchor ?? this.latestAnchor() });
    this.composingAt.set(null);
    this.composingAnchor = null;
  }

  startRename(id: string): void {
    this.editingId.set(id);
  }

  finishRename(spacer: CycleSpacer, value: string): void {
    if (this.editingId() !== spacer.id) return;
    this.editingId.set(null);
    const label = value.trim();
    if (label && label !== spacer.label) this.renameSpacer.emit({ spacer, label });
  }

  /** Narrower label column as rows indent, so deep rows keep room for their bar. */
  labelWidth(depth: number): number {
    return Math.max(200 - Math.min(depth, 6) * 12, 128);
  }

  private findCall(id: string): CallRecord | null {
    const walk = (nodes: readonly CallTreeNode[]): CallRecord | null => {
      for (const node of nodes) {
        if (node.call.id === id) return node.call;
        const found = walk(node.children);
        if (found) return found;
      }
      return null;
    };
    return walk(this.nodes());
  }
}

function toRow(node: CallTreeNode, info: CallDepthInfo | undefined, folded: boolean): MiniWaterfallRow {
  const call = node.call;
  const inProgress = call.state === 'IN_PROGRESS';
  const status = call.response?.status ?? null;
  const internal = call.source === 'internal';
  const path = uriPath(call.url);
  return {
    call,
    depth: node.depth,
    rails: depthRails(node.depth),
    tint: depthTintClass(node.depth),
    childCount: node.children.length,
    descendantCount: info?.descendantCount ?? 0,
    folded,
    offsetPercent: `${((info?.spanStart ?? 0) * 100).toFixed(2)}%`,
    // Floored so a very short call inside a long root is still a visible sliver.
    widthPercent: `${Math.max((info?.spanWidth ?? 1) * 100, 1.2).toFixed(2)}%`,
    hasBar: node.depth === 0 || info?.spanStart != null,
    inProgress,
    direction: internal ? 'inbound' : 'outbound',
    service: internal ? (call.service_name ?? 'unknown') : null,
    path: internal ? `/${path}` : `${supplierOf(call)}/${path}`,
    statusText: inProgress ? '…' : status != null ? String(status) : 'ERR',
    statusClass: inProgress ? '' : statusClass(status),
    methodClass: methodClass(call.method),
    durationLabel: inProgress ? '' : formatDuration(call.duration_ms),
  };
}

export function formatDuration(ms: number | null | undefined): string {
  if (ms == null) return '';
  return ms >= 1000 ? `${(ms / 1000).toFixed(2)} s` : `${Math.round(ms)} ms`;
}
