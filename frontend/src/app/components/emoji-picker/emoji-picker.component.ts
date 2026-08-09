import { Component, ElementRef, HostListener, computed, inject, input, output, signal } from '@angular/core';
import { AVATAR_EMOJIS, randomAvatarEmoji } from '../../core/models/avatar-emojis';
import { computeFixedPanelPosition } from '../../shared/utils/popover-position';

const PANEL_WIDTH = 280;
const PANEL_GAP = 8;

/**
 * Popover for picking a profile avatar out of the ~350-entry AVATAR_EMOJIS pool - same
 * click-to-open/click-outside-close shape as ThemePickerComponent/ProfilePickerComponent, plus a
 * search box (the list is too long to scan by eye) and a "Randomize" shortcut (the same picker
 * used for both "give me a fresh avatar" and "let me choose exactly").
 *
 * The panel is `position: fixed`, positioned via `computeFixedPanelPosition` rather than plain CSS
 * `position: absolute` - this picker is used inside `.dialog-card`, which has `overflow-y: auto`
 * for dialogs long enough to need it, and an absolutely-positioned descendant gets clipped by that
 * ancestor's scroll box. Fixed positioning escapes that; `computeFixedPanelPosition` additionally
 * corrects for any ancestor (e.g. `.dialog-backdrop`'s `backdrop-filter`) that would otherwise
 * become the *containing block* for a fixed descendant instead of the viewport - see that file.
 */
@Component({
  selector: 'app-emoji-picker',
  standalone: true,
  templateUrl: './emoji-picker.component.html',
})
export class EmojiPickerComponent {
  private readonly elementRef = inject(ElementRef<HTMLElement>);

  readonly value = input<string | null>(null);
  /** Always a real emoji - never null (unlike ProfilePickerComponent, there's no "unassigned" option here). */
  readonly valueChange = output<string>();

  readonly panelOpen = signal(false);
  readonly searchQuery = signal('');
  readonly panelPosition = signal({ top: 0, left: 0 });

  readonly filteredEmojis = computed(() => {
    const query = this.searchQuery().trim().toLowerCase();
    if (!query) return AVATAR_EMOJIS;
    return AVATAR_EMOJIS.filter((e) => e.name.includes(query));
  });

  togglePanel(): void {
    const opening = !this.panelOpen();
    if (opening) {
      this.panelPosition.set(
        computeFixedPanelPosition(this.elementRef.nativeElement, { width: PANEL_WIDTH, gap: PANEL_GAP })
      );
    }
    this.panelOpen.set(opening);
    this.searchQuery.set('');
  }

  select(char: string): void {
    this.valueChange.emit(char);
    this.panelOpen.set(false);
  }

  randomize(): void {
    this.valueChange.emit(randomAvatarEmoji().char);
  }

  /** Closes the panel on any click outside this component - same pattern as ThemePickerComponent. */
  @HostListener('document:click', ['$event'])
  onDocumentClick(event: MouseEvent): void {
    if (!this.elementRef.nativeElement.contains(event.target as Node)) {
      this.panelOpen.set(false);
    }
  }
}
