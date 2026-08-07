import { Component, input } from '@angular/core';
import { HighlightToken } from '../../utils/json-tokenizer';

/**
 * Renders a list of already-highlighted tokens as text - never innerHTML.
 * Shared by the flat view, the tree view, and plain-text bodies, so the
 * "how do we show a <mark>" decision lives in exactly one place.
 */
@Component({
  selector: 'app-json-tokens',
  standalone: true,
  templateUrl: './json-tokens.component.html',
})
export class JsonTokensComponent {
  readonly tokens = input.required<readonly HighlightToken[]>();
  readonly activeMatchIndex = input<number>(-1);
}
