import { Component, ElementRef, HostListener, computed, inject, input, output, signal } from '@angular/core';
import { computeFixedPanelPosition, trackPopoverPosition } from '../../shared/utils/popover-position';

export interface SelectOption {
  readonly value: string;
  readonly label: string;
}

const PANEL_MAX_WIDTH = 320; // must match .select-picker-panel's max-width in styles.scss
const PANEL_GAP = 8;

/**
 * Generic single-select popover, replacing a native <select> - same reasoning as
 * ProfilePickerComponent/EmojiPickerComponent: a native select's dropdown *list* is drawn by the
 * OS/browser and only inconsistently respects page theming (verified live - `color-scheme` and
 * `option` colors aren't honored everywhere), so this renders the whole popup as regular themed
 * DOM instead. Used for anything that's just "pick one label from a short fixed list" - the
 * limit/sort/supplier-filter selects in HeaderComponent, the sort select in
 * SessionCyclesListComponent - so those call sites don't each need their own popover.
 *
 * Positioned `fixed` via `computeFixedPanelPosition` (see that file for why a naive viewport-relative
 * computation isn't enough - `header`/`.tab-nav`'s `backdrop-filter` makes them the containing block
 * for fixed descendants in glass themes).
 */
@Component({
  selector: 'app-select-picker',
  standalone: true,
  templateUrl: './select-picker.component.html',
})
export class SelectPickerComponent {
  private readonly elementRef = inject(ElementRef<HTMLElement>);

  readonly options = input.required<readonly SelectOption[]>();
  readonly value = input<string>('');
  readonly valueChange = output<string>();

  readonly panelOpen = signal(false);
  readonly panelPosition = signal({ top: 0, left: 0 });

  readonly currentLabel = computed(() => this.options().find((o) => o.value === this.value())?.label ?? this.value());

  private stopTracking: (() => void) | null = null;

  togglePanel(): void {
    const opening = !this.panelOpen();
    if (opening) {
      const options = { width: PANEL_MAX_WIDTH, gap: PANEL_GAP };
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

  select(value: string): void {
    this.valueChange.emit(value);
    this.closePanel();
  }

  private closePanel(): void {
    this.stopTracking?.();
    this.stopTracking = null;
    this.panelOpen.set(false);
  }

  /** Closes the panel on any click outside this component - same pattern as ThemePickerComponent. */
  @HostListener('document:click', ['$event'])
  onDocumentClick(event: MouseEvent): void {
    if (!this.elementRef.nativeElement.contains(event.target as Node)) {
      this.closePanel();
    }
  }
}
