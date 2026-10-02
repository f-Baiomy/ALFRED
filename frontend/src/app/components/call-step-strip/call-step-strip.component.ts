import { Component, input, output } from '@angular/core';

/** One stage of a call's journey: recorded call, edits, what was sent, who answered, the response. */
export interface CallStripStep {
  readonly key: string;
  readonly title: string;
  readonly line: string;
}

/**
 * The numbered "1 · Recorded call → 2 · Your edits → …" strip a resent call shows, shared with
 * Relive's step details (T062) so both read the same way. Presentational only: the host owns the
 * steps and what selecting one shows.
 */
@Component({
  selector: 'app-call-step-strip',
  standalone: true,
  templateUrl: './call-step-strip.component.html',
})
export class CallStepStripComponent {
  readonly steps = input.required<readonly CallStripStep[]>();
  readonly selected = input<string | null>(null);
  readonly ariaLabel = input('The cycle of this call');
  readonly select = output<string>();
}
