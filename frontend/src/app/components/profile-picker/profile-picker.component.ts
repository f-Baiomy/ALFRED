import { Component, ElementRef, HostListener, computed, inject, input, output, signal } from '@angular/core';
import { ProfilesStateService } from '../../core/state/profiles-state.service';

/**
 * Custom single-select popover for choosing a profile (or "Unassigned") - deliberately not a
 * native <select>. A native select's closed box can be themed via CSS, but its open dropdown
 * list is normally drawn by the OS/browser and only partially respects `color-scheme`/`option`
 * colors depending on browser and platform - this popover (same click-to-open/click-outside-close
 * shape as ThemePickerComponent/AssignedToFilterComponent) is fully themed everywhere instead.
 */
@Component({
  selector: 'app-profile-picker',
  standalone: true,
  templateUrl: './profile-picker.component.html',
})
export class ProfilePickerComponent {
  private readonly profilesState = inject(ProfilesStateService);
  private readonly elementRef = inject(ElementRef<HTMLElement>);

  readonly value = input<string | null>(null);
  readonly valueChange = output<string | null>();

  readonly panelOpen = signal(false);
  readonly profiles = this.profilesState.profiles;

  readonly buttonLabel = computed(() => this.profilesState.labelFor(this.value()) ?? 'Unassigned');

  togglePanel(): void {
    this.panelOpen.update((open) => !open);
  }

  select(id: string | null): void {
    this.valueChange.emit(id);
    this.panelOpen.set(false);
  }

  /** Closes the panel on any click outside this component - same pattern as ThemePickerComponent. */
  @HostListener('document:click', ['$event'])
  onDocumentClick(event: MouseEvent): void {
    if (!this.elementRef.nativeElement.contains(event.target as Node)) {
      this.panelOpen.set(false);
    }
  }
}
