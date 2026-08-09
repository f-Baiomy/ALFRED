import { Component, ElementRef, HostListener, computed, inject, signal } from '@angular/core';
import { ProfilesStateService } from '../../core/state/profiles-state.service';
import { UNASSIGNED_FILTER_KEY, SessionCyclesStateService } from '../../core/state/session-cycles-state.service';

interface FilterOption {
  readonly key: string;
  readonly label: string;
}

/**
 * Multi-select "Assigned to" filter for the Session Cycles list - same click-to-open/
 * click-outside-to-close popover shape as ThemePickerComponent, but with checkboxes instead of
 * single-select swatches since any number of assignees can be filtered on at once. An empty
 * selection means "all" (the default) rather than "none match".
 */
@Component({
  selector: 'app-assigned-to-filter',
  standalone: true,
  templateUrl: './assigned-to-filter.component.html',
})
export class AssignedToFilterComponent {
  private readonly profilesState = inject(ProfilesStateService);
  private readonly cyclesState = inject(SessionCyclesStateService);
  private readonly elementRef = inject(ElementRef<HTMLElement>);

  readonly panelOpen = signal(false);
  readonly selected = this.cyclesState.assignedToFilter;

  readonly options = computed<FilterOption[]>(() => [
    { key: UNASSIGNED_FILTER_KEY, label: 'Unassigned' },
    ...this.profilesState.profiles().map((p) => ({ key: p.id, label: p.name })),
  ]);

  readonly buttonLabel = computed(() => {
    const selected = this.selected();
    if (selected.size === 0) return 'All assigned';
    if (selected.size === 1) {
      const [key] = selected;
      return this.options().find((o) => o.key === key)?.label ?? '1 selected';
    }
    return `${selected.size} selected`;
  });

  togglePanel(): void {
    this.panelOpen.update((open) => !open);
  }

  isChecked(key: string): boolean {
    return this.selected().has(key);
  }

  toggleOption(key: string): void {
    const next = new Set(this.selected());
    if (next.has(key)) {
      next.delete(key);
    } else {
      next.add(key);
    }
    this.cyclesState.setAssignedToFilter(next);
  }

  selectAll(): void {
    this.cyclesState.setAssignedToFilter(new Set());
  }

  /** Closes the panel on any click outside this component - same pattern as ThemePickerComponent. */
  @HostListener('document:click', ['$event'])
  onDocumentClick(event: MouseEvent): void {
    if (!this.elementRef.nativeElement.contains(event.target as Node)) {
      this.panelOpen.set(false);
    }
  }
}
