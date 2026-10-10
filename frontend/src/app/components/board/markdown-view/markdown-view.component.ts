import { Component, computed, input } from '@angular/core';
import { NgTemplateOutlet } from '@angular/common';
import { Inline, markdownBlocks } from '../../../shared/utils/markdown-blocks';
import { MentionChipComponent } from '../mention-chip/mention-chip.component';

/**
 * Markdown with mentions, rendered from markdown-blocks' typed tree with plain bindings - never innerHTML, since spec
 * files, comments and Claude's text are untrusted (constitution I). Headings carry their slug as an id, so a spec
 * mention's #section can scroll to it.
 */
@Component({
  selector: 'app-markdown-view',
  standalone: true,
  imports: [NgTemplateOutlet, MentionChipComponent],
  template: `
    <ng-template #inl let-nodes>
      @for (n of asInlines(nodes); track $index) {
        @switch (n.kind) {
          @case ('text') { <span class="board-md-text">{{ n.text }}</span> }
          @case ('code') { <code>{{ n.text }}</code> }
          @case ('bold') { <strong><ng-container *ngTemplateOutlet="inl; context: { $implicit: n.children }" /></strong> }
          @case ('italic') { <em><ng-container *ngTemplateOutlet="inl; context: { $implicit: n.children }" /></em> }
          @case ('link') { <a [href]="n.href" target="_blank" rel="noopener noreferrer"><ng-container *ngTemplateOutlet="inl; context: { $implicit: n.children }" /></a> }
          @case ('mention') { <app-mention-chip [mention]="n.ref" [showPreview]="previews()" /> }
        }
      }
    </ng-template>
    <div class="board-md">
      @for (b of blocks(); track $index) {
        @switch (b.kind) {
          @case ('heading') {
            <div class="board-md-h" [class]="'board-md-h board-md-h' + b.level" [id]="idPrefix() + b.slug">
              <ng-container *ngTemplateOutlet="inl; context: { $implicit: b.inlines }" />
            </div>
          }
          @case ('paragraph') { <p><ng-container *ngTemplateOutlet="inl; context: { $implicit: b.inlines }" /></p> }
          @case ('list') {
            @if (b.ordered) {
              <ol>@for (item of b.items; track $index) { <li><ng-container *ngTemplateOutlet="inl; context: { $implicit: item }" /></li> }</ol>
            } @else {
              <ul>@for (item of b.items; track $index) { <li><ng-container *ngTemplateOutlet="inl; context: { $implicit: item }" /></li> }</ul>
            }
          }
          @case ('code') { <pre class="board-md-pre">{{ b.text }}</pre> }
          @case ('rule') { <hr /> }
          @case ('table') {
            <table class="board-md-table">
              <thead><tr>@for (c of b.header; track $index) { <th><ng-container *ngTemplateOutlet="inl; context: { $implicit: c }" /></th> }</tr></thead>
              <tbody>
                @for (row of b.rows; track $index) {
                  <tr>@for (c of row; track $index) { <td><ng-container *ngTemplateOutlet="inl; context: { $implicit: c }" /></td> }</tr>
                }
              </tbody>
            </table>
          }
        }
      }
      @if (!blocks().length && empty()) { <p class="board-dim">{{ empty() }}</p> }
    </div>`,
})
export class MarkdownViewComponent {
  readonly text = input<string | null>('');
  readonly empty = input('');
  readonly previews = input(true);
  /** Prefixed to heading ids so two views on one page cannot clash. */
  readonly idPrefix = input('md-');

  readonly blocks = computed(() => markdownBlocks(this.text()));

  asInlines(nodes: unknown): readonly Inline[] {
    return nodes as readonly Inline[];
  }
}
