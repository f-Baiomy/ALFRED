import { Component, computed, inject, input, signal } from '@angular/core';
import { CallTreeNode } from '../../shared/utils/call-tree';
import { CallCardComponent } from '../call-card/call-card.component';
import { CallDiagnosticsComponent } from '../call-diagnostics/call-diagnostics.component';
import { CALL_LIST_CONTROLS_STATE } from '../../core/state/call-selection.tokens';

/**
 * The 'nested' view (design A): one call's card with every call proven to have happened inside it
 * rendered INSIDE it, recursively. Containment is literal here, which is the whole point of this
 * view - so unlike the flat-depth view these cards carry no depth badge and no span bar, with
 * nothing to state that the layout isn't already showing.
 *
 * A call WITH children renders as a sandwich (see CallCardComponent's 'sandwich' variant): request
 * band, children, response band, all in one card. Without it the parent's status and duration sat
 * above its children, reading as though it had finished before they started.
 *
 * Every card here selects by SUBTREE (see CallCardComponent's subtreeSelect): with the children
 * drawn inside the parent, ticking the parent can only sensibly mean "this call and the work it
 * caused", and the checkbox goes tri-state so a parent left selected after one child was unticked
 * still reads as partial.
 *
 * Recurses through its own selector. Depth is uncapped in the data; it's the INDENT that's capped
 * (see depthRailPx), so a chain deeper than a few levels keeps nesting correctly instead of
 * squeezing the innermost card down to nothing.
 */
@Component({
  selector: 'app-call-tree-node',
  standalone: true,
  imports: [CallCardComponent, CallDiagnosticsComponent],
  template: `
    @if (hasChildren()) {
      <app-call-card
        [call]="node().call"
        variant="sandwich"
        [subtreeSelect]="true"
        [foldable]="true"
        [folded]="folded()"
        (foldToggle)="toggleFold()"
        [diagnosable]="true"
        [diagOpen]="diagOpen()"
        (diagToggle)="diagOpen.set(!diagOpen())"
      >
        @if (diagOpen()) {
          <app-call-diagnostics callDiagnostics [node]="node()" />
        }
        <div callChildren>
          @if (folded()) {
            <button type="button" class="tree-fold-summary" (click)="toggleFold()">
              {{ hiddenCount() }} {{ hiddenCount() === 1 ? 'call' : 'calls' }} folded &mdash; show
            </button>
          } @else {
            <div class="tree-children">
              @for (child of node().children; track child.call.id) {
                <app-call-tree-node [node]="child" />
              }
            </div>
          }
        </div>
      </app-call-card>
    } @else {
      <app-call-card [call]="node().call" [subtreeSelect]="true" />
    }
  `,
})
export class CallTreeNodeComponent {
  private readonly state = inject(CALL_LIST_CONTROLS_STATE);

  readonly node = input.required<CallTreeNode>();
  /** Only a call that actually called other calls is sandwiched - a leaf has nothing to bracket,
   * so it stays the single card it is everywhere else. Same rule the flat-depth view's split uses. */
  readonly hasChildren = computed(() => this.node().children.length > 0);
  readonly folded = computed(() => this.state.foldedIds().has(this.node().call.id));
  readonly hiddenCount = computed(() => countDescendants(this.node()));
  /** Local rather than in the shared list state: showing a breakdown is a momentary "what happened
   * here", not a property of the list worth keeping in step across views. */
  readonly diagOpen = signal(false);

  /**
   * Folding takes every parent underneath this one with it, so re-opening gives back ONE level
   * rather than however many were open when it was folded - the point of folding a deep trace is to
   * get back to something readable, and restoring it wholesale undoes that in a single click.
   * Unfolding deliberately touches only this call, leaving whatever is inside it as the user left it.
   */
  toggleFold(): void {
    const id = this.node().call.id;
    if (this.folded()) this.state.setFolded([id], false);
    else this.state.setFolded([id, ...foldableDescendantIds(this.node())], true);
  }
}

function countDescendants(node: CallTreeNode): number {
  return node.children.reduce((total, child) => total + 1 + countDescendants(child), 0);
}

/** Ids of the calls below `node` that have children of their own - the only ones folding means anything for. */
function foldableDescendantIds(node: CallTreeNode): string[] {
  return node.children.flatMap((child) =>
    child.children.length > 0 ? [child.call.id, ...foldableDescendantIds(child)] : foldableDescendantIds(child)
  );
}
