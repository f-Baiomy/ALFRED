import { Component, computed, input } from '@angular/core';
import { JsonTokensComponent } from '../../shared/components/json-tokens/json-tokens.component';
import { HighlightToken, highlightTokens } from '../../shared/utils/json-tokenizer';
import { TreeEntry, braceFor, isContainer, treeEntriesOf } from '../../shared/utils/json-tree';

/** One collapsible node in the JSON tree view. Recurses into itself for object/array children. */
@Component({
  selector: 'app-json-tree-node',
  standalone: true,
  imports: [JsonTokensComponent, JsonTreeNodeComponent],
  templateUrl: './json-tree-node.component.html',
})
export class JsonTreeNodeComponent {
  readonly entryKey = input<string | null>(null);
  readonly value = input.required<unknown>();
  readonly isLast = input<boolean>(true);
  readonly searchQuery = input<string>('');

  readonly isContainerValue = computed(() => isContainer(this.value()));

  readonly childEntries = computed<TreeEntry[]>(() =>
    this.isContainerValue() ? treeEntriesOf(this.value() as Record<string, unknown> | unknown[]) : []
  );

  readonly brace = computed(() =>
    this.isContainerValue() ? braceFor(this.value() as Record<string, unknown> | unknown[]) : null
  );

  readonly keyTokens = computed<HighlightToken[]>(() => {
    const key = this.entryKey();
    if (key === null) return [];
    return highlightTokens([{ text: JSON.stringify(key), cls: 'k' }], this.searchQuery()).tokens;
  });

  readonly leafTokens = computed<HighlightToken[]>(() => {
    if (this.isContainerValue()) return [];
    return highlightTokens([{ text: this.leafText(), cls: this.leafClass() }], this.searchQuery()).tokens;
  });

  private leafText(): string {
    const v = this.value();
    if (v === null) return 'null';
    if (typeof v === 'string') return JSON.stringify(v);
    return String(v);
  }

  private leafClass(): HighlightToken['cls'] {
    const v = this.value();
    if (v === null) return 'z';
    if (typeof v === 'boolean') return 'b';
    if (typeof v === 'number') return 'n';
    if (typeof v === 'string') return 's';
    return '';
  }
}
