import { Directive, ElementRef, inject, input, output } from '@angular/core';

/**
 * Closes a menu or panel on a click outside it or on Escape - never on mouseleave (specs/032 D7: the old session menu
 * closed while the pointer travelled to its buttons, so Pause and Release could not be pressed).
 * `[appCloseOnOutside]="open()"` arms it; `(closed)` fires once per outside click / Escape while armed.
 * Put it on the element that holds BOTH the trigger and the menu, so the trigger's own click is not "outside".
 */
@Directive({
  selector: '[appCloseOnOutside]',
  standalone: true,
  host: {
    '(document:pointerdown)': 'onPointer($event)',
    '(document:keydown.escape)': 'onEscape()',
  },
})
export class CloseOnOutsideDirective {
  private readonly host = inject(ElementRef<HTMLElement>);
  readonly appCloseOnOutside = input<boolean>(false);
  readonly closed = output<void>();

  onPointer(event: Event): void {
    if (!this.appCloseOnOutside()) return;
    const target = event.target as Node | null;
    if (target && this.host.nativeElement.contains(target)) return;
    // a dialog opened from the menu lives outside it - clicks in it are not "outside"
    if (target instanceof Element && target.closest('[data-keep-menu]')) return;
    this.closed.emit();
  }

  onEscape(): void {
    if (this.appCloseOnOutside()) this.closed.emit();
  }
}
