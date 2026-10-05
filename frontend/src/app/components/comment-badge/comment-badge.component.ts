import { Component, computed, effect, inject, input } from '@angular/core';
import { COMMENT_BLOCK_LABELS, CommentBlock } from '../../core/models/comment.model';
import { CommentCountsState } from '../../core/state/comment-counts-state.service';

const BLOCK_ORDER: readonly CommentBlock[] = ['call', 'request-headers', 'request-body', 'response-headers', 'response-body'];

/**
 * "💬 N" on a call that has comments - on its card (flat and nested views) and on its waterfall row,
 * so a call with notes is visible without opening it. Renders nothing for a call without comments.
 * A plain span: the waterfall row is itself a button, and a card wraps it in its own button.
 */
@Component({
  selector: 'app-comment-badge',
  standalone: true,
  template: `@if (count(); as c) {<span class="badge comment-badge" [class.mini]="mini()" [title]="title()">💬 {{ c.total }}</span>}`,
})
export class CommentBadgeComponent {
  private readonly state = inject(CommentCountsState);
  readonly callId = input.required<string>();
  /** The waterfall's compact row. */
  readonly mini = input(false);

  readonly count = computed(() => this.state.counts().get(this.callId()) ?? null);

  readonly title = computed(() => {
    const c = this.count();
    if (!c) return '';
    const parts = BLOCK_ORDER.filter((b) => c.byBlock[b]).map((b) =>
      b === 'call' ? `${c.byBlock[b]} on the whole call` : `${c.byBlock[b]} on ${COMMENT_BLOCK_LABELS[b].toLowerCase()}`);
    return `${c.total} comment${c.total === 1 ? '' : 's'} - ${parts.join(', ')}`;
  });

  constructor() {
    effect(() => this.state.request(this.callId()));
  }
}
