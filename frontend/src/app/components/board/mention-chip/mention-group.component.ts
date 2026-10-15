import { Component, computed, input, signal } from '@angular/core';
import { MENTION_ICONS, MentionRef } from '../../../core/models/board.models';
import { labelStatus } from '../../../core/services/board-mentions.service';
import { MentionChipComponent } from './mention-chip.component';

/**
 * Three or more call mentions in a row ("calls #75, #81, #88 and #108") as one chip (specs/021): "⇄ 4 calls", their
 * labels on hover, and a click lays them out as their own chips - each opening its call popup as always.
 */
@Component({
  selector: 'app-mention-group',
  standalone: true,
  imports: [MentionChipComponent],
  template: `@if (open()) {
      <span class="board-mention-group-list">
        @for (r of refs(); track r.ref) { <app-mention-chip [mention]="r" [showPreview]="showPreview()" /> }
        <button type="button" class="board-link" title="Fold them back into one chip" (click)="open.set(false)">‹</button>
      </span>
    } @else {
      <span class="board-mention board-mention-call" role="button" tabindex="0" [title]="title()"
            (click)="unfold($event)" (keydown.enter)="unfold($event)">
        <span class="board-mention-icon">{{ icon }}</span>{{ refs().length }} calls{{ failed() ? ' · ' + failed() + ' failed' : '' }}
        @if (failed()) { <span class="board-mention-dot dot-bad"></span> }
      </span>
    }`,
})
export class MentionGroupComponent {
  readonly refs = input.required<readonly MentionRef[]>();
  readonly showPreview = input(true);
  readonly open = signal(false);
  readonly icon = MENTION_ICONS.call;
  readonly title = computed(() => this.refs().map((r) => r.label).join('\n') + '\n- click to see each one');
  /** Calls whose saved label carries an error status. */
  readonly failed = computed(() => this.refs().filter((r) => Number(labelStatus(r.label) ?? 0) >= 400).length);

  unfold(event: Event): void {
    event.stopPropagation();
    this.open.set(true);
  }
}

/** A run of call mentions joined only by ", " / " and " - drawn as one group chip when it has three or more. */
export type GroupedInline<T> = T | { readonly kind: 'calls'; readonly refs: readonly MentionRef[] };

export function groupCalls<T extends { readonly kind: string }>(nodes: readonly T[], refOf: (n: T) => MentionRef | null): GroupedInline<T>[] {
  const out: GroupedInline<T>[] = [];
  let i = 0;
  while (i < nodes.length) {
    const run: MentionRef[] = [];
    let j = i;
    for (;;) {
      const r = refOf(nodes[j]);
      if (!r || r.type.toLowerCase() !== 'call') break;
      run.push(r);
      const sep = nodes[j + 1] as { kind: string; text?: string } | undefined;
      if (sep && sep.kind === 'text' && /^\s*(?:,|,?\s*and|&|\/)\s*$/.test(sep.text ?? '') && nodes[j + 2] && refOf(nodes[j + 2])?.type.toLowerCase() === 'call') {
        j += 2;
        continue;
      }
      break;
    }
    if (run.length >= 3) {
      out.push({ kind: 'calls', refs: run });
      i = j + 1;
    } else {
      out.push(nodes[i]);
      i++;
    }
  }
  return out;
}
