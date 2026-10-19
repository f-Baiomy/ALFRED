import { Component, ElementRef, computed, inject, input, signal } from '@angular/core';
import { MENTION_ICONS, MentionRef, mentionTypeOf } from '../../../core/models/board.models';
import { BoardMentionsService, MentionPreview } from '../../../core/services/board-mentions.service';
import { LinksStateService } from '../../../core/links/links-state.service';
import { originOf } from '../../../core/links/remote-ref';

/**
 * A mention as a chip (FR-023): coloured by type, a preview fetched on first hover, the item opened on click. A mention
 * whose item is gone shows struck through with its saved label (FR-026) - the text around it is untouched.
 *
 * specs/021: a chip reads what its reference means now - a card's short name and number, an Acceptance item's short
 * name and AC number, a cycle's call by what it was - looked up once (BoardMentionsService.live), with a dot for its
 * state (Verified, No data, 500). Until the look-up answers, the saved label shows.
 */
@Component({
  selector: 'app-mention-chip',
  standalone: true,
  template: `<span class="board-mention" [class]="'board-mention board-mention-' + type()" [class.removed]="preview()?.removed"
      role="button" tabindex="0" [title]="title()"  (mouseenter)="load(); place()" (focus)="load(); place()" (click)="open($event)" (keydown.enter)="open($event)">
    <span class="board-mention-icon">{{ icon() }}</span>{{ label() }}
    @if (originName(); as o) { <span class="board-mention-origin" [class.off]="!originOnline()">⇇ {{ o }}</span> }
    @if (live()?.tone; as tone) { <span class="board-mention-dot" [class]="'board-mention-dot dot-' + tone" [title]="live()?.state ?? ''"></span> }
    @if (showPreview() && preview(); as p) {
      <span class="board-mention-tip">
        @for (line of p.lines; track $index) { <span class="board-mention-tip-line">{{ line }}</span> }
        @if (live()?.state; as st) { <span class="board-mention-tip-line dim">{{ st }}</span> }
        @if (p.removed) {
          <span class="board-mention-tip-line dim">{{ originName() ? (originOnline() ? 'Gone on ' + originName() + ' - deleted there' : originName() + ' is offline')
            : 'Removed' }} - this is the label it was saved with.</span>
        }
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
  readonly live = computed(() => this.mentions.live(this.mention())());
  readonly label = computed(() => this.live()?.label ?? this.mention().label);
  /** Another Alfred's card, cycle or call (specs/035 D19): which one, and whether it can be read now. */
  private readonly links = inject(LinksStateService);
  private readonly originSlug = computed(() => originOf(this.mention().ref, this.links.slugs()));
  readonly originName = computed(() => (this.originSlug() ? this.links.nameOf(this.originSlug()) : null));
  readonly originOnline = computed(() => !!this.links.linkOf(this.originSlug())?.online);
  readonly title = computed(() => `${this.label()}${this.live()?.state ? ` · ${this.live()!.state}` : ''}${this.originName()
    ? ` · from ${this.originName()}${this.originOnline() ? '' : ' (offline)'}` : ''}
${this.type()}: ${this.mention().ref}`);
  private loading = false;
  private readonly host = inject(ElementRef<HTMLElement>);

  load(): void {
    if (!this.showPreview() || this.loading || this.preview()) return;
    this.loading = true;
    this.mentions.preview(this.mention()).subscribe((p) => { this.preview.set(p); this.place(); });
  }

  /**
   * Fixes the preview to the screen under the chip (above it near the bottom, inside the window's width). A fixed box
   * is placed against the nearest ancestor that makes one its containing block (a transform, a backdrop filter), so
   * that box's own offset is measured first and taken off.
   */
  place(): void {
    if (typeof window === 'undefined') return;
    requestAnimationFrame(() => {
      const host = this.host.nativeElement as HTMLElement;
      const tip = host.querySelector('.board-mention-tip') as HTMLElement | null;
      const chip = host.querySelector('.board-mention') as HTMLElement | null;
      if (!tip || !chip || getComputedStyle(tip).display === 'none') return;
      tip.style.position = 'fixed';
      tip.style.left = '0px';
      tip.style.top = '0px';
      const origin = tip.getBoundingClientRect();
      const r = chip.getBoundingClientRect();
      const w = origin.width;
      const h = origin.height;
      const left = Math.max(8, Math.min(r.left, window.innerWidth - w - 8));
      const below = r.bottom + 6;
      const top = below + h > window.innerHeight - 8 ? Math.max(8, r.top - h - 6) : below;
      tip.style.left = `${left - origin.left}px`;
      tip.style.top = `${top - origin.top}px`;
    });
  }

  open(event: Event): void {
    event.stopPropagation();
    this.mentions.open(this.mention());
  }
}
