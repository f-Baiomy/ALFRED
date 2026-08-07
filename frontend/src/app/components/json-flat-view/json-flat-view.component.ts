import { Component, input } from '@angular/core';
import { JsonTokensComponent } from '../../shared/components/json-tokens/json-tokens.component';
import { HighlightToken } from '../../shared/utils/json-tokenizer';

export type FlatViewVariant = 'json' | 'plain';

@Component({
  selector: 'app-json-flat-view',
  standalone: true,
  imports: [JsonTokensComponent],
  templateUrl: './json-flat-view.component.html',
})
export class JsonFlatViewComponent {
  readonly tokens = input.required<readonly HighlightToken[]>();
  readonly variant = input<FlatViewVariant>('json');
  readonly activeMatchIndex = input<number>(-1);
  readonly scrollId = input<string | undefined>(undefined);
}
