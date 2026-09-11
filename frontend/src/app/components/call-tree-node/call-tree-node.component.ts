import { Component, input } from '@angular/core';
import { CallTreeNode } from '../../shared/utils/call-tree';
import { CallCardComponent } from '../call-card/call-card.component';

/**
 * The 'nested' view (design A): one call's card with every call proven to have happened inside it
 * rendered INSIDE it, recursively. Containment is literal here, which is the whole point of this
 * view - so unlike the flat-depth view these cards carry no depth badge and no span bar (nothing
 * to state that the layout isn't already showing), and no request/response split (see
 * CallViewMode): the card already encloses its children, so splitting it into halves around them
 * would only say the same thing twice.
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
    <app-call-card [call]="node().call" />
    @if (node().children.length > 0) {
      <div class="tree-children">
        @for (child of node().children; track child.call.id) {
          <app-call-tree-node [node]="child" />
        }
      </div>
    }
  `,
})
export class CallTreeNodeComponent {
  readonly node = input.required<CallTreeNode>();
}
