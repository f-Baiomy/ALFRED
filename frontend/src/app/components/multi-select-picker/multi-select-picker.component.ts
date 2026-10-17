import { Component, ElementRef, HostListener, computed, inject, input, output, signal } from '@angular/core';
import { computeFixedPanelPosition, trackPopoverPosition } from '../../shared/utils/popover-position';
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
  /** The closed button says "first +2" with a count instead of every chip - for a narrow filter column. */
  readonly compact = input<boolean>(false);
  /** Lets a value not in the list be typed and added with Enter (an item id, a new tag); `custom` checks it. */
  readonly allowCustom = input<boolean>(false);
  readonly custom = input<(v: string) => boolean>(() => true);
  /** How a picked value the list no longer offers is described. */
  readonly unknownNote = input<string>('not configured any more');
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

  /** The typed text, when it can be added as a value of its own. */
  readonly typedValue = computed(() => {
    const t = this.query().trim();
    if (!this.allowCustom() || !t || this.selected().has(t) || !this.custom()(t)) return null;
    return this.options().some((o) => o.value === t || o.label.toLowerCase() === t.toLowerCase()) ? null : t;
  });

  readonly summaryTitle = computed(() => this.values().map((v) => this.labelOf(v)).join(', '));

  private stopTracking: (() => void) | null = null;

  togglePanel(): void {
    const opening = !this.panelOpen();
    // Cleared on the way in, not in an effect: a stale query would silently hide most of the
    // list the next time the panel is opened, and an effect that writes a signal needs
    // allowSignalWrites for no benefit over doing it here.
    this.query.set('');
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

  private closePanel(): void {
    this.stopTracking?.();
    this.stopTracking = null;
    this.panelOpen.set(false);
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

  addTyped(): void {
    const t = this.typedValue();
    if (!t) return;
    this.valuesChange.emit([...this.values(), t]);
    this.query.set('');
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
      this.closePanel();
    }
  }
}
