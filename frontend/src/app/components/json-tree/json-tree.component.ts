import { Component, input } from '@angular/core';
import { JsonTreeNodeComponent } from './json-tree-node.component';

/** Scrollable root of the collapsible tree view - the recursion itself lives in JsonTreeNodeComponent. */
@Component({
  selector: 'app-json-tree',
  standalone: true,
  imports: [JsonTreeNodeComponent],
  templateUrl: './json-tree.component.html',
})
export class JsonTreeComponent {
  readonly value = input.required<unknown>();
  readonly searchQuery = input<string>('');
  readonly scrollId = input<string | undefined>(undefined);
}
