import { Component, ElementRef, HostListener, computed, inject, input, output, signal } from '@angular/core';
import { computeFixedPanelPosition } from '../../shared/utils/popover-position';
import { SelectOption } from '../select-picker/select-picker.component';

const PANEL_MAX_WIDTH = 320; // must match .select-picker-panel's max-width in styles.scss
const PANEL_GAP = 8;

/**
 * Pick several values from a short list - the multi-select counterpart of SelectPickerComponent,
 * sharing its SelectOption shape and its popover positioning so the two look like one control in
 * two modes rather than two controls.
 *
 * Exists because the rule editor's project and method fields are both "any of these", and the
 * alternatives are worse in specific ways: a free-text field means a rule silently matches
 * nothing when a project is renamed or misspelled, and a native `<select multiple>` is drawn by
 * the OS (the same reason SelectPickerComponent exists at all).
 *
 * An empty selection is a legitimate state meaning "any", not an unfilled form - which is why
 * the summary says so rather than showing a blank box.
 */
@Component({
  selector: 'app-multi-select-picker',
  standalone: true,
  templateUrl: './multi-select-picker.component.html',
})
export class MultiSelectPickerComponent {
  private readonly elementRef = inject(ElementRef<HTMLElement>);

  readonly options = input.required<readonly SelectOption[]>();
  readonly values = input<readonly string[]>([]);
  /** What an empty selection means, in the user's terms - "Any project", "Any method". */
  readonly emptyLabel = input<string>('Any');
  /** Shows a filter box; pointless for six methods, necessary for thirty projects. */
  readonly searchable = input<boolean>(false);
  readonly valuesChange = output<readonly string[]>();

  readonly panelOpen = signal(false);
  readonly panelPosition = signal({ top: 0, left: 0 });
  readonly query = signal('');

  readonly selected = computed(() => new Set(this.values()));

  readonly visibleOptions = computed(() => {
    const needle = this.query().trim().toLowerCase();
    if (!needle) return this.options();
    return this.options().filter((o) => o.label.toLowerCase().includes(needle));
  });

  /**
   * The options that are selected but no longer offered - a project removed from
   * settings.properties, say. Kept visible and removable rather than silently dropped: the rule
   * still carries that name, and a filter that hides it would make the rule's real behaviour
   * invisible.
   */
  readonly unknownSelections = computed(() => {
    const known = new Set(this.options().map((o) => o.value));
    return this.values().filter((v) => !known.has(v));
  });

  togglePanel(): void {
    const opening = !this.panelOpen();
    // Cleared on the way in, not in an effect: a stale query would silently hide most of the
    // list the next time the panel is opened, and an effect that writes a signal needs
    // allowSignalWrites for no benefit over doing it here.
    this.query.set('');
    if (opening) {
      this.panelPosition.set(
        computeFixedPanelPosition(this.elementRef.nativeElement, { width: PANEL_MAX_WIDTH, gap: PANEL_GAP })
      );
    }
    this.panelOpen.set(opening);
  }

  onQuery(event: Event): void {
    this.query.set((event.target as HTMLInputElement).value);
  }

  toggle(value: string): void {
    const next = this.values().includes(value)
      ? this.values().filter((v) => v !== value)
      : [...this.values(), value];
    this.valuesChange.emit(next);
  }

  /** Stays open: picking three projects should not mean reopening the panel three times. */
  clear(): void {
    this.valuesChange.emit([]);
  }

  labelOf(value: string): string {
    return this.options().find((o) => o.value === value)?.label ?? value;
  }

  @HostListener('document:click', ['$event'])
  onDocumentClick(event: MouseEvent): void {
    if (!this.elementRef.nativeElement.contains(event.target as Node)) {
      this.panelOpen.set(false);
    }
  }
}
