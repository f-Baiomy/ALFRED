import { Component, ElementRef, HostListener, OnDestroy, computed, inject, input, output, signal } from '@angular/core';
import { NameSuggestion, filterSuggestions } from '../../shared/utils/name-suggestions';
import { maskRelive } from '../../shared/utils/relive-mask';
import { computeFixedPanelPosition, trackPopoverPosition } from '../../shared/utils/popover-position';

const PANEL = { width: 460, gap: 4 };
const SECRET_NAME = /auth|token|cookie|session|secret|password|key|signature/i;

/**
 * A header or cookie name box that offers the names a call actually had - each with its value as a
 * preview - filtered as you type (↑↓ / Enter / Esc), while any other name can still be typed. One
 * component for every such box: rule conditions and header / cookie actions, Relive step checks,
 * and a step's "Save a value" from a header or cookie.
 *
 * The panel is `position: fixed` (see popover-position.ts): the boxes live in cards that clip
 * their overflow.
 */
@Component({
  selector: 'app-name-suggest',
  standalone: true,
  template: `
    <input
      type="text"
      class="name-suggest-input"
      [class]="inputClass()"
      [value]="value()"
      [placeholder]="placeholder()"
      autocomplete="off"
      spellcheck="false"
      (focus)="openPanel()"
      (input)="onInput($any($event.target).value)"
      (keydown)="onKey($event)"
    />
    @if (open() && shown().length) {
      <div class="name-suggest-panel" [style.top.px]="position().top" [style.left.px]="position().left" (mousedown)="$event.preventDefault()">
        @if (title()) {
          <div class="name-suggest-title">{{ title() }}</div>
        }
        @for (s of shown(); track s.name; let i = $index) {
          <button type="button" class="name-suggest-option" [class.on]="i === active()" (click)="pick(s.name)" (mouseenter)="active.set(i)">
            <b>{{ s.name }}</b><span>{{ preview(s) }}</span>
          </button>
        }
      </div>
    }
  `,
})
export class NameSuggestComponent implements OnDestroy {
  private readonly host = inject(ElementRef<HTMLElement>);

  readonly value = input('');
  readonly placeholder = input('');
  readonly inputClass = input('');
  readonly suggestions = input<readonly NameSuggestion[]>([]);
  /** The panel's heading, e.g. "Headers in the recorded response". */
  readonly title = input('');
  readonly valueChange = output<string>();

  readonly open = signal(false);
  readonly active = signal(0);
  readonly position = signal({ top: 0, left: 0 });
  private readonly typed = signal<string | null>(null);
  private stopTracking: (() => void) | null = null;

  readonly shown = computed(() => filterSuggestions(this.suggestions(), this.typed() ?? '').slice(0, 30));

  preview(s: NameSuggestion): string {
    const text = s.value.length > 80 ? `${s.value.slice(0, 80)}…` : s.value;
    return SECRET_NAME.test(s.name) && text.length > 12 ? `${text.slice(0, 6)}••••••` : maskRelive(text, [], {});
  }

  openPanel(): void {
    if (this.open()) return;
    const input = this.host.nativeElement.querySelector('input') as HTMLElement;
    this.position.set(computeFixedPanelPosition(input, PANEL));
    this.stopTracking = trackPopoverPosition(input, PANEL, (p) => this.position.set(p));
    this.active.set(0);
    this.open.set(true);
  }

  close(): void {
    this.stopTracking?.();
    this.stopTracking = null;
    this.open.set(false);
    this.typed.set(null);
  }

  onInput(text: string): void {
    this.typed.set(text);
    this.active.set(0);
    if (!this.open()) this.openPanel();
    this.valueChange.emit(text);
  }

  onKey(event: KeyboardEvent): void {
    const count = this.shown().length;
    if (event.key === 'ArrowDown' && count) {
      event.preventDefault();
      if (!this.open()) this.openPanel();
      this.active.set((this.active() + 1) % count);
    } else if (event.key === 'ArrowUp' && count) {
      event.preventDefault();
      this.active.set((this.active() - 1 + count) % count);
    } else if (event.key === 'Enter' && this.open() && count) {
      event.preventDefault();
      this.pick(this.shown()[this.active()].name);
    } else if (event.key === 'Escape' || event.key === 'Tab') {
      this.close();
    }
  }

  pick(name: string): void {
    this.valueChange.emit(name);
    this.close();
  }

  @HostListener('document:mousedown', ['$event'])
  onOutside(event: MouseEvent): void {
    if (this.open() && !this.host.nativeElement.contains(event.target as Node)) this.close();
  }

  ngOnDestroy(): void {
    this.stopTracking?.();
  }
}
