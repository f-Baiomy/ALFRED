import { Component, ElementRef, HostListener, computed, inject, input, output, signal } from '@angular/core';
import { AVATAR_EMOJIS, randomAvatarEmoji } from '../../core/models/avatar-emojis';

const PANEL_WIDTH = 280;
const PANEL_GAP = 8;

/**
 * Popover for picking a profile avatar out of the ~350-entry AVATAR_EMOJIS pool - same
 * click-to-open/click-outside-close shape as ThemePickerComponent/ProfilePickerComponent, plus a
 * search box (the list is too long to scan by eye) and a "Randomize" shortcut (the same picker
 * used for both "give me a fresh avatar" and "let me choose exactly").
 *
 * The panel is `position: fixed`, positioned from the trigger button's own
 * `getBoundingClientRect()` rather than plain CSS `position: absolute` - this picker is used
 * inside `.dialog-card`, which has `overflow-y: auto` for dialogs long enough to need it, and an
 * absolutely-positioned descendant gets clipped/mispositioned by that ancestor's scroll box.
 * Fixed positioning computed in JS escapes that entirely and always renders relative to the
 * viewport, right below the button, regardless of what scrollable container it's opened inside.
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
      this.panelPosition.set(this.computePanelPosition());
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

  /** Clamped to the viewport so the 280px-wide panel never renders partly off-screen for a trigger near the right edge. */
  private computePanelPosition(): { top: number; left: number } {
    const rect = this.elementRef.nativeElement.getBoundingClientRect();
    const left = Math.min(rect.left, window.innerWidth - PANEL_WIDTH - PANEL_GAP);
    return { top: rect.bottom + PANEL_GAP, left: Math.max(PANEL_GAP, left) };
  }

  /** Closes the panel on any click outside this component - same pattern as ThemePickerComponent. */
  @HostListener('document:click', ['$event'])
  onDocumentClick(event: MouseEvent): void {
    if (!this.elementRef.nativeElement.contains(event.target as Node)) {
      this.panelOpen.set(false);
    }
  }
}
