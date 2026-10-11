import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { Router } from '@angular/router';
import { BoardMentionsService } from '../../../core/services/board-mentions.service';
import { ReturnPointService, restoreScrolls, whenPresent } from '../../../core/services/return-point.service';

/**
 * The "⇄ Back to card #27" button, rendered once in the app shell while a jump from a card's call popup is pending:
 * back to the page the user was on (its Board tab included) with the card opened again. ✕ forgets the way back.
 */
@Component({
  standalone: true,
  selector: 'app-return-point-host',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (returns.point(); as p) {
      <div class="db-back return-back" role="status">
        <button type="button" class="db-back-btn" title="Back to where you were, with the card open again" (click)="back()">
          ⇄ Back to {{ p.card ? 'card #' + p.card.number : 'where you were' }}
          @if (p.card) { <span>{{ p.card.title }}</span> }
        </button>
        <button type="button" class="db-back-x" title="Stay here" aria-label="Stay here" (click)="returns.clear()">✕</button>
      </div>
    }`,
})
export class ReturnPointHostComponent {
  protected readonly returns = inject(ReturnPointService);
  private readonly router = inject(Router);
  private readonly mentions = inject(BoardMentionsService);

  /**
   * Back exactly: the page (and its tab), the card opened again, its drawer, the board's columns and the page scrolled
   * as they were, then the call popup shown again, scrolled as it was.
   */
  async back(): Promise<void> {
    const p = this.returns.point();
    if (!p) return;
    this.returns.clear();
    await this.router.navigateByUrl(p.url);
    if (p.card) {
      this.mentions.cardToOpen.set({ project: p.card.project, number: p.card.number });
      // the drawer is there once it shows this card's title
      await whenPresent('.board-drawer-title', (el) => el.textContent?.trim() === p.card!.title);
    }
    await restoreScrolls(p.scrolls);
    if (p.popup) {
      this.mentions.callToShow.set(p.popup);
      await whenPresent('.board-call-pop-body');
      await restoreScrolls(p.popupScrolls);
    }
  }
}
