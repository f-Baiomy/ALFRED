import { Component, computed, input } from '@angular/core';
import { MarkdownViewComponent } from '../../../board/markdown-view/markdown-view.component';

/**
 * One Azure field's value. Description, Repro Steps and Acceptance Criteria are HTML: they go through the board's
 * sanitising Markdown view (which turns HTML into board text), never innerHTML; everything else is plain text.
 */
@Component({
  selector: 'app-azure-field',
  standalone: true,
  imports: [MarkdownViewComponent],
  template: `
    @if (isHtml()) { <app-markdown-view [text]="value() ?? ''" /> }
    @else { <span class="azure-field-text">{{ value() }}</span> }`,
  styles: [`.azure-field-text { white-space: pre-wrap; word-break: break-word; }`],
})
export class AzureFieldComponent {
  readonly key = input('');
  readonly value = input<string | null>(null);
  readonly isHtml = computed(() => /<\/?(p|div|br|ol|ul|li|b|i|strong|em|span|table|img|a)\b/i.test(this.value() ?? ''));
}
