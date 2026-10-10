import { Component, computed, inject, input, signal } from '@angular/core';
import { MENTION_ICONS, MentionRef, mentionTypeOf } from '../../../core/models/board.models';
import { BoardMentionsService, MentionPreview } from '../../../core/services/board-mentions.service';

/**
 * A mention as a chip (FR-023): coloured by type, a preview fetched on first hover, the item opened on click. A mention
 * whose item is gone shows struck through with its saved label (FR-026) - the text around it is untouched.
 */
@Component({
  selector: 'app-mention-chip',
  standalone: true,
  template: `<span class="board-mention" [class]="'board-mention board-mention-' + type()" [class.removed]="preview()?.removed"
      role="button" tabindex="0" [title]="title()" (mouseenter)="load()" (focus)="load()" (click)="open($event)" (keydown.enter)="open($event)">
    <span class="board-mention-icon">{{ icon() }}</span>{{ mention().label }}
    @if (showPreview() && preview(); as p) {
      <span class="board-mention-tip">
        @for (line of p.lines; track $index) { <span class="board-mention-tip-line">{{ line }}</span> }
        @if (p.removed) { <span class="board-mention-tip-line dim">Removed - this is the label it was saved with.</span> }
      </span>
    }
  </span>`,
})
export class MentionChipComponent {
  private readonly mentions = inject(BoardMentionsService);
  readonly mention = input.required<MentionRef>();
  /** Off on board cards, where a chip is a short label and a hover would fetch for every card scrolled past. */
  readonly showPreview = input(true);

  readonly preview = signal<MentionPreview | null>(null);
  readonly type = computed(() => mentionTypeOf(this.mention()));
  readonly icon = computed(() => MENTION_ICONS[this.type()] ?? '@');
  readonly title = computed(() => `${this.mention().label}\n${this.type()}: ${this.mention().ref}`);
  private loading = false;

  load(): void {
    if (!this.showPreview() || this.loading || this.preview()) return;
    this.loading = true;
    this.mentions.preview(this.mention()).subscribe((p) => this.preview.set(p));
  }

  open(event: Event): void {
    event.stopPropagation();
    this.mentions.open(this.mention());
  }
}
