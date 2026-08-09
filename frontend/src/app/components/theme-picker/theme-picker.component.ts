import { Component, ElementRef, HostListener, inject, signal } from '@angular/core';
import { THEMES, ThemeId } from '../../core/models/theme.model';
import { ThemeService } from '../../core/services/theme.service';

/**
 * Lives once in `MainLayoutComponent`'s tab-nav bar, not per-page - the theme it sets applies
 * app-wide via `ThemeService`, so there's nothing page-specific to duplicate into `HeaderComponent`.
 */
@Component({
  selector: 'app-theme-picker',
  standalone: true,
  templateUrl: './theme-picker.component.html',
})
export class ThemePickerComponent {
  private readonly themeService = inject(ThemeService);
  private readonly elementRef = inject(ElementRef<HTMLElement>);

  readonly themes = THEMES;
  readonly currentTheme = this.themeService.theme;
  readonly panelOpen = signal(false);

  togglePanel(): void {
    this.panelOpen.update((open) => !open);
  }

  selectTheme(id: ThemeId): void {
    this.themeService.setTheme(id);
    this.panelOpen.set(false);
  }

  /** Closes the panel on any click outside this component - simpler than a backdrop overlay for a small popover that doesn't need to block the rest of the page. */
  @HostListener('document:click', ['$event'])
  onDocumentClick(event: MouseEvent): void {
    if (!this.elementRef.nativeElement.contains(event.target as Node)) {
      this.panelOpen.set(false);
    }
  }
}
