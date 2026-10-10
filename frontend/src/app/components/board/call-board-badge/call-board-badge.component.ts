import { Component, inject, input } from '@angular/core';
import { CallBadge, RESOLUTION_LABELS, STATUS_LABELS } from '../../../core/models/board.models';
import { BoardMentionsService } from '../../../core/services/board-mentions.service';

/** "▣ #7 bug" on a call a card mentions (FR-036), coloured by the card's state; click opens the card. */
@Component({
  selector: 'app-call-board-badge',
  standalone: true,
  template: `
    @for (b of badges(); track b.project + b.number) {
      <button type="button" class="board-call-badge" [class]="'board-call-badge board-call-badge-' + tone(b)" [title]="title(b)"
              (click)="open($event, b)">▣ #{{ b.number }} {{ word(b) }}</button>
    }`,
})
export class CallBoardBadgeComponent {
  private readonly mentions = inject(BoardMentionsService);
  readonly badges = input<readonly CallBadge[]>([]);

  tone(b: CallBadge): string {
    if (b.status === 'CLOSED') return b.resolution === 'FINE' ? 'fine' : 'closed';
    if (b.status === 'INBOX') return 'inbox';
    if (b.status === 'FIXED' || b.status === 'VERIFIED' || b.status === 'DONE') return 'fixed';
    return b.kind === 'BUG' ? 'bug' : 'open';
  }

  word(b: CallBadge): string {
    if (b.status === 'CLOSED') return b.resolution === 'FINE' ? 'fine' : b.resolution === 'NOT_IN_FLOW' ? 'not in flow' : 'closed';
    if (b.status === 'INBOX') return 'inbox';
    return b.kind.toLowerCase();
  }

  title(b: CallBadge): string {
    return `Card #${b.number}: ${b.kind}, ${STATUS_LABELS[b.status]}${b.resolution ? ` - ${RESOLUTION_LABELS[b.resolution]}` : ''}`;
  }

  open(event: Event, b: CallBadge): void {
    event.stopPropagation();
    this.mentions.cardToOpen.set({ project: b.project, number: b.number });
  }
}
