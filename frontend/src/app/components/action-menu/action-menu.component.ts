import { Component, ElementRef, HostListener, inject, input, signal } from '@angular/core';
import { computeFixedPanelPosition, trackPopoverPosition } from '../../shared/utils/popover-position';

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

  /** Rendered next to the label when non-zero - e.g. how many filters are currently active. */
  readonly badge = input<number>(0);

  /** Wider than the default for a panel holding form fields rather than a list of actions. */
  readonly panelWidth = input(PANEL_WIDTH);

  /**
   * Whether clicking inside the panel closes it. True for a list of actions (the original use), but
   * a panel of *inputs* must stay open while you type into it - otherwise the first click into a
   * text field dismisses the thing you were about to fill in.
   */
  readonly closeOnClick = input(true);

  readonly panelOpen = signal(false);
  readonly panelPosition = signal({ top: 0, left: 0 });

  private stopTracking: (() => void) | null = null;

  togglePanel(): void {
    const opening = !this.panelOpen();
    if (opening) {
      const options = { width: this.panelWidth(), gap: PANEL_GAP };
      this.panelPosition.set(computeFixedPanelPosition(this.elementRef.nativeElement, options));
      // Re-anchors to the trigger on every scroll, including a dialog body scrolling under it -
      // see trackPopoverPosition for why that needs more than a plain scroll listener.
      this.stopTracking = trackPopoverPosition(this.elementRef.nativeElement, options, (position) =>
        this.panelPosition.set(position)
      );
      this.panelOpen.set(true);
    } else {
      this.closePanel();
    }
  }

  private closePanel(): void {
    this.stopTracking?.();
    this.stopTracking = null;
    this.panelOpen.set(false);
  }

  /** Every menu item is a projected button with its own (click) handler - this just closes the
   * menu afterward, deferred so the item's own handler runs first (it fires on the same bubbled
   * click event this listens for). */
  onPanelClick(): void {
    if (!this.closeOnClick()) return;
    setTimeout(() => this.closePanel());
  }

  @HostListener('document:click', ['$event'])
  onDocumentClick(event: MouseEvent): void {
    if (!this.elementRef.nativeElement.contains(event.target as Node)) {
      this.closePanel();
    }
  }
}
