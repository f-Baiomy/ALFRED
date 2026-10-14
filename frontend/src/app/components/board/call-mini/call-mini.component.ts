import { Component, OnInit, computed, inject, input, signal } from '@angular/core';
import { MentionRef } from '../../../core/models/board.models';
import { BoardMentionsService, MentionPreview } from '../../../core/services/board-mentions.service';

/**
 * A call mention on a line of its own, shown as a card (docs/board.md "Rich text"): what the call was and how it went at a
 * glance - from the same preview a chip shows on hover - and opened on click.
 */
@Component({
  selector: 'app-call-mini',
  standalone: true,
  template: `
    <span class="board-callcard" [class.bad]="bad()" [class.removed]="preview()?.removed" role="button" tabindex="0"
          [title]="mention().label" (click)="open($event)" (keydown.enter)="open($event)">
      <span class="board-callcard-ico">⇄</span>
      <span class="board-callcard-main">
        <span class="board-callcard-label">{{ mention().label }}</span>
        @if (preview(); as p) {
          @for (line of p.lines.slice(0, 3); track $index) { <span class="board-callcard-line">{{ line }}</span> }
        } @else {
          <span class="board-callcard-line">…</span>
        }
      </span>
    </span>`,
})
export class CallMiniComponent implements OnInit {
  private readonly mentions = inject(BoardMentionsService);
  readonly mention = input.required<MentionRef>();
  readonly preview = signal<MentionPreview | null>(null);
  readonly bad = computed(() => /\b[45]\d\d\b|error|exception|fail/i.test((this.preview()?.lines ?? []).join(' ') + ' ' + this.mention().label));

  ngOnInit(): void {
    this.mentions.preview(this.mention()).subscribe({ next: (p) => this.preview.set(p), error: () => this.preview.set({ lines: [], removed: false }) });
  }

  open(event: Event): void {
    event.stopPropagation();
    this.mentions.open(this.mention());
  }
}
