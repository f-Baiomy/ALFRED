import { Component, computed, input, output, signal } from '@angular/core';
import { PathEntry, suggestPaths } from '../../shared/utils/json-paths';

/**
 * A JSON field path box that knows the body: typing shows the matching paths of the rule's
 * sample call (request body in the request lane, response body in the response lane) with each
 * one's type and sample values; ↑↓ move, Enter or Tab picks, Esc closes. With no sample it is the
 * plain text box it replaces - suggestions help, they never restrict what can be typed.
 */
@Component({
  selector: 'app-json-path-input',
  standalone: true,
  template: `
    <span class="json-path-input">
      <input
        type="text"
        class="jpi-box"
        [value]="value()"
        [placeholder]="placeholder()"
        [attr.aria-expanded]="open() && shown().length > 0"
        aria-autocomplete="list"
        (focus)="open.set(true); active.set(0)"
        (blur)="close()"
        (input)="typed($any($event.target).value)"
        (keydown)="key($event)"
      />
      @if (open() && shown().length) {
        <span class="jpi-list" role="listbox">
          @for (e of shown(); track e.path; let i = $index) {
            <span
              class="jpi-item"
              role="option"
              [class.on]="i === active()"
              [attr.aria-selected]="i === active()"
              (mousedown)="$event.preventDefault(); pick(e)"
              (mouseenter)="active.set(i)"
            >
              <code>{{ e.path }}</code>
              <span class="jpi-type">{{ e.type }}{{ e.count > 1 ? ' ×' + e.count : '' }}</span>
              <span class="jpi-samples">{{ e.samples.join(', ') }}</span>
            </span>
          }
        </span>
      }
    </span>
  `,
})
export class JsonPathInputComponent {
  readonly value = input<string>('');
  /** The sample call's paths; null when the rule has no call - then it is a plain box. */
  readonly index = input<readonly PathEntry[] | null>(null);
  readonly placeholder = input('itinerary.price');
  readonly valueChange = output<string>();

  readonly open = signal(false);
  readonly active = signal(0);
  private readonly query = signal<string | null>(null);

  readonly shown = computed(() => {
    const index = this.index();
    if (!index?.length) return [];
    return suggestPaths(index, this.query() ?? this.value());
  });

  typed(text: string): void {
    this.query.set(text);
    this.active.set(0);
    this.open.set(true);
    this.valueChange.emit(text);
  }

  pick(entry: PathEntry): void {
    this.query.set(null);
    this.open.set(false);
    this.valueChange.emit(entry.path);
  }

  close(): void {
    // After a click on an option has had its mousedown.
    setTimeout(() => this.open.set(false), 120);
  }

  key(event: KeyboardEvent): void {
    const list = this.shown();
    if (!this.open() || !list.length) return;
    if (event.key === 'ArrowDown') this.active.set(Math.min(list.length - 1, this.active() + 1));
    else if (event.key === 'ArrowUp') this.active.set(Math.max(0, this.active() - 1));
    else if (event.key === 'Enter' || (event.key === 'Tab' && !event.shiftKey)) this.pick(list[this.active()]);
    else if (event.key === 'Escape') this.open.set(false);
    else return;
    event.preventDefault();
  }
}
