import { Component, computed, input } from '@angular/core';
import { MentionRef } from '../../../core/models/board.models';
import { parseMentions } from '../../../shared/utils/mention-syntax';
import { withBareRefs } from '../../../shared/utils/readable-refs';
import { MentionChipComponent } from './mention-chip.component';

/**
 * A one-line text - a card title or reason - with its references drawn as chips (specs/021): "… returns only that branch's
 * requests (AC8)" shows the AC8 as the Acceptance item's chip, "same as #47" the card's. Plain text otherwise.
 */
@Component({
  selector: 'app-ref-text',
  standalone: true,
  imports: [MentionChipComponent],
  template: `@for (s of segments(); track $index) {@if (s.mention) {<app-mention-chip [mention]="s.mention" [showPreview]="showPreview()" />} @else {{{ s.text }}}}`,
})
export class RefTextComponent {
  readonly text = input<string | null | undefined>('');
  readonly project = input<string | null | undefined>(null);
  readonly cycleId = input<string | null | undefined>(null);
  /** The card the text is on - `[6]` in its reason is an entry of its history. */
  readonly card = input<number | null | undefined>(null);
  readonly showPreview = input(true);

  readonly segments = computed<readonly { readonly text?: string; readonly mention?: MentionRef }[]>(() =>
    parseMentions(withBareRefs(this.text() ?? '', { project: this.project(), cycleId: this.cycleId(), card: this.card() }))
      .map((s) => ('mention' in s ? { mention: s.mention } : { text: s.text })));
}
