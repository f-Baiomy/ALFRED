import { Component, ElementRef, HostListener, inject, input, signal } from '@angular/core';
import { computeFixedPanelPosition, trackPopoverPosition } from '../../shared/utils/popover-position';
import { HelpEntry } from '../../shared/utils/interception-help';

const PANEL_WIDTH = 380;
const PANEL_GAP = 8;

/**
 * The ⓘ next to an action or a condition, and what it opens.
 *
 * Help sits on the control it describes rather than in a manual somewhere, because the question
 * is always "what does THIS do" while looking at it. Several entries can be shown at once - a
 * condition row is a subject and an operator, and reading about one without the other is half an
 * answer.
 *
 * `summary` closes the panel with the current control restated in plain language, using the very
 * same describeAction/describeCondition the call log uses. The editor and the log describing the
 * same thing two different ways is how people stop trusting either.
 */
@Component({
  selector: 'app-help-popover',
  standalone: true,
  templateUrl: './help-popover.component.html',
})
export class HelpPopoverComponent {
  private readonly elementRef = inject(ElementRef<HTMLElement>);

  readonly entries = input.required<readonly HelpEntry[]>();
  /** The control as it currently stands - "Request JSON field supplier equals TravelportNdc". */
  readonly summary = input<string>('');
  readonly label = input<string>('What does this do?');

  readonly open = signal(false);
  readonly position = signal({ top: 0, left: 0 });

  private stopTracking: (() => void) | null = null;

  toggle(event: MouseEvent): void {
    // The ⓘ lives inside cards that have click handlers of their own; opening help must not also
    // trigger whatever it is sitting on.
    event.stopPropagation();
    const opening = !this.open();
    if (opening) {
      const options = { width: PANEL_WIDTH, gap: PANEL_GAP };
      this.position.set(computeFixedPanelPosition(this.elementRef.nativeElement, options));
      // Re-anchors to the trigger on every scroll, including a dialog body scrolling under it -
      // see trackPopoverPosition for why that needs more than a plain scroll listener.
      this.stopTracking = trackPopoverPosition(this.elementRef.nativeElement, options, (position) =>
        this.position.set(position)
      );
    } else {
      this.stopTracking?.();
      this.stopTracking = null;
    }
    this.open.set(opening);
  }

  close(): void {
    this.stopTracking?.();
    this.stopTracking = null;
    this.open.set(false);
  }

  @HostListener('document:click', ['$event'])
  onDocumentClick(event: MouseEvent): void {
    if (!this.elementRef.nativeElement.contains(event.target as Node)) {
      this.close();
    }
  }

  @HostListener('document:keydown.escape')
  onEscape(): void {
    this.close();
  }
}
