import { Component, ElementRef, HostListener, computed, inject, input, output, signal } from '@angular/core';
import { computeFixedPanelPosition, trackPopoverPosition } from '../../shared/utils/popover-position';
import {
  customStatusFrom,
  isValidStatus,
  searchStatuses,
  statusLabel,
} from '../../shared/utils/http-status';

const PANEL_MAX_WIDTH = 320; // must match .select-picker-panel's max-width in styles.scss
const PANEL_GAP = 8;

/**
 * Pick an HTTP status by name rather than type a number.
 *
 * Every place a status is set went through a bare `<input type="number">`, which is the wrong
 * control for this: the thing a user knows is "service unavailable", not that it is 503, and
 * nothing stopped a typo'd 5003 or 20 being saved and then quietly clamped somewhere downstream.
 * Search matches the code OR the phrase, so "503", "unavail" and "service" all land on the same
 * row.
 *
 * Custom codes stay first-class rather than being a fallback - a supplier that answers 599 is
 * exactly the case worth reproducing, and typing three digits into the search box offers it
 * directly.
 *
 * Shared by the rule editor's four status fields and the paused inspector's, for the same reason
 * SelectPickerComponent is shared: five copies of a searchable popover is five chances for one
 * of them to behave differently.
 */
@Component({
  selector: 'app-status-picker',
  standalone: true,
  templateUrl: './status-picker.component.html',
})
export class StatusPickerComponent {
  private readonly elementRef = inject(ElementRef<HTMLElement>);

  readonly value = input<number | null>(null);
  /** Shown when nothing is picked yet - "Status", "Keep what the host sent". */
  readonly placeholder = input<string>('Choose a status');
  /** Narrows the list to a fixed few, for a field where only some codes make sense (a gateway failure). */
  readonly only = input<readonly number[] | null>(null);
  readonly valueChange = output<number>();

  readonly panelOpen = signal(false);
  readonly panelPosition = signal({ top: 0, left: 0 });
  readonly query = signal('');

  readonly label = computed(() => (this.value() == null ? this.placeholder() : statusLabel(this.value())));

  readonly groups = computed(() => {
    const allowed = this.only();
    const groups = searchStatuses(this.query());
    if (!allowed) return groups;
    return groups
      .map((group) => ({ label: group.label, statuses: group.statuses.filter((s) => allowed.includes(s.code)) }))
      .filter((group) => group.statuses.length > 0);
  });

  /** A three-digit code the user typed that is not in the list - offered as-is rather than lost. */
  readonly custom = computed(() => (this.only() ? null : customStatusFrom(this.query())));

  readonly nothingFound = computed(() => this.groups().length === 0 && this.custom() === null);

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

  onQuery(event: Event): void {
    this.query.set((event.target as HTMLInputElement).value);
  }

  select(code: number): void {
    if (!isValidStatus(code)) return;
    this.valueChange.emit(code);
    this.closePanel();
  }

  private closePanel(): void {
    this.stopTracking?.();
    this.stopTracking = null;
    this.panelOpen.set(false);
  }

  /** Enter on a typed code picks it, so a custom status needs no mouse. */
  onEnter(): void {
    const custom = this.custom();
    if (custom !== null) {
      this.select(custom);
      return;
    }
    const first = this.groups()[0]?.statuses[0];
    if (first) this.select(first.code);
  }

  statusLabel = statusLabel;

  @HostListener('document:click', ['$event'])
  onDocumentClick(event: MouseEvent): void {
    if (!this.elementRef.nativeElement.contains(event.target as Node)) {
      this.closePanel();
    }
  }
}
