import { Component, computed, input } from '@angular/core';
import { CallTreeNode } from '../../shared/utils/call-tree';
import { CallCardComponent } from '../call-card/call-card.component';

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
 * Recurses through its own selector. Depth is uncapped in the data; it's the INDENT that's capped
 * (see depthRailPx), so a chain deeper than a few levels keeps nesting correctly instead of
 * squeezing the innermost card down to nothing.
 */
@Component({
  selector: 'app-call-tree-node',
  standalone: true,
  imports: [CallCardComponent],
  template: `
    @if (hasChildren()) {
      <app-call-card [call]="node().call" variant="sandwich">
        <div callChildren class="tree-children">
          @for (child of node().children; track child.call.id) {
            <app-call-tree-node [node]="child" />
          }
        </div>
      </app-call-card>
    } @else {
      <app-call-card [call]="node().call" />
    }
  `,
})
export class CallTreeNodeComponent {
  readonly node = input.required<CallTreeNode>();
  /** Only a call that actually called other calls is sandwiched - a leaf has nothing to bracket,
   * so it stays the single card it is everywhere else. Same rule the flat-depth view's split uses. */
  readonly hasChildren = computed(() => this.node().children.length > 0);
}
