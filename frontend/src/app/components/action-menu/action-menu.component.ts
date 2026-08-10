import { Component, ElementRef, HostListener, inject, input, signal } from '@angular/core';
import { computeFixedPanelPosition } from '../../shared/utils/popover-position';

const PANEL_WIDTH = 220;
const PANEL_GAP = 8;

/**
 * Generic action-list popover - groups several related buttons (e.g. every export action) behind
 * one trigger instead of cluttering the toolbar with one button per action. Menu items are plain
 * projected content (`<button class="filter-option-item" (click)="...">`), not a fixed options
 * list like SelectPickerComponent, since each caller's actions have entirely different handlers/
 * loading-state signals - there's nothing generic to model beyond "open/close this popover."
 *
 * Positioned `fixed` via the same computeFixedPanelPosition() used by SelectPickerComponent/
 * EmojiPickerComponent, for the same reason - see popover-position.ts.
 */
@Component({
  selector: 'app-action-menu',
  standalone: true,
  templateUrl: './action-menu.component.html',
})
export class ActionMenuComponent {
  private readonly elementRef = inject(ElementRef<HTMLElement>);

  readonly label = input('Export');

  readonly panelOpen = signal(false);
  readonly panelPosition = signal({ top: 0, left: 0 });

  togglePanel(): void {
    const opening = !this.panelOpen();
    if (opening) {
      this.panelPosition.set(
        computeFixedPanelPosition(this.elementRef.nativeElement, { width: PANEL_WIDTH, gap: PANEL_GAP })
      );
    }
    this.panelOpen.set(opening);
  }

  /** Every menu item is a projected button with its own (click) handler - this just closes the
   * menu afterward, deferred so the item's own handler runs first (it fires on the same bubbled
   * click event this listens for). */
  onPanelClick(): void {
    setTimeout(() => this.panelOpen.set(false));
  }

  @HostListener('document:click', ['$event'])
  onDocumentClick(event: MouseEvent): void {
    if (!this.elementRef.nativeElement.contains(event.target as Node)) {
      this.panelOpen.set(false);
    }
  }
}
