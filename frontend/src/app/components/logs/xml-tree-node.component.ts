import { Component, computed, input } from '@angular/core';
import { highlightSegments } from '../../shared/utils/logs-query-parse';

/**
 * One element of an XML value as a collapsible tree node - the XML counterpart of the JSON tree in the
 * Logs value window. Its attributes are listed as `@name: value`, its own text as the value, and an
 * element with nothing but text is one line (`Remark: retrieve for refund`). Read-only; text bindings
 * only. Uses `<details>` like the JSON tree, so "Expand all / Collapse all" handles both.
 */
@Component({
  selector: 'app-xml-tree-node',
  standalone: true,
  imports: [XmlTreeNodeComponent],
  template: `
    @if (isLeaf()) {
      <div class="tree-row">
        <span class="k">{{ el().nodeName }}</span><span class="punct">: </span>
        <span class="s">@for (s of seg(text()); track $index) {@if (s.hit) {<mark class="hl">{{ s.text }}</mark>} @else {<ng-container>{{ s.text }}</ng-container>}}</span>
      </div>
    } @else {
      <details class="tree-node" open>
        <summary>
          <span class="k">&lt;{{ el().nodeName }}&gt;</span>
          <span class="tree-count">{{ children().length }} element{{ children().length === 1 ? '' : 's' }}@if (attrs().length) {, {{ attrs().length }} attribute{{ attrs().length === 1 ? '' : 's' }}}</span>
        </summary>
        <div class="tree-body">
          @for (a of attrs(); track a.name) {
            <div class="tree-row">
              <span class="n">&#64;{{ a.name }}</span><span class="punct">: </span>
              <span class="s">@for (s of seg(a.value); track $index) {@if (s.hit) {<mark class="hl">{{ s.text }}</mark>} @else {<ng-container>{{ s.text }}</ng-container>}}</span>
            </div>
          }
          @if (text()) {
            <div class="tree-row"><span class="s">@for (s of seg(text()); track $index) {@if (s.hit) {<mark class="hl">{{ s.text }}</mark>} @else {<ng-container>{{ s.text }}</ng-container>}}</span></div>
          }
          @for (c of children(); track $index) {
            <app-xml-tree-node [el]="c" [searchQuery]="searchQuery()" />
          }
        </div>
      </details>
    }
  `,
})
export class XmlTreeNodeComponent {
  readonly el = input.required<Element>();
  readonly searchQuery = input('');

  readonly children = computed(() => Array.from(this.el().children));
  readonly attrs = computed(() => Array.from(this.el().attributes).map((a) => ({ name: a.name, value: a.value })));
  /** The element's own text (not its children's), joined. */
  readonly text = computed(() =>
    Array.from(this.el().childNodes)
      .filter((n) => n.nodeType === Node.TEXT_NODE || n.nodeType === Node.CDATA_SECTION_NODE)
      .map((n) => (n.nodeValue ?? '').trim())
      .filter((t) => t)
      .join(' ')
  );
  readonly isLeaf = computed(() => this.children().length === 0 && this.attrs().length === 0);

  seg(text: string) {
    const q = this.searchQuery().trim();
    return highlightSegments(text, q ? [q] : []);
  }
}
