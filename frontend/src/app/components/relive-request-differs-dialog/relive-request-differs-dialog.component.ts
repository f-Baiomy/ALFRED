import { Component, computed, input, output, signal } from '@angular/core';
import { onRequestChangedOf, setOnRequestChanged } from '../../shared/utils/relive-call-rule';
import { OnRequestChanged, Step } from '../../shared/utils/relive-types';

interface ChoiceCard {
  readonly value: OnRequestChanged;
  readonly label: string;
  readonly detail: string;
  readonly danger: boolean;
}

const CHOICES: readonly ChoiceCard[] = [
  { value: 'FAIL', label: 'Mock a failure (default)', detail: 'ALFRED answers 502 (editable) - the supplier is never contacted.', danger: false },
  { value: 'ASK', label: 'Ask me', detail: 'The call is held and you decide. No decision in time = mocked failure. Never sent without your yes.', danger: false },
  { value: 'REPLAY', label: 'Replay recording anyway', detail: 'The recorded answer is given even though the request changed.', danger: false },
  { value: 'LIVE', label: 'Call live ⚠', detail: 'A differing request goes to the REAL supplier. Dangerous - you confirm this.', danger: true },
];

/**
 * "When the request differs from the recording" (FR-014d; mock.html `openChanged()`/`CHG`/
 * `setChanged()`/`confirmCallLive()`). Choosing Call live opens a second, danger-only screen whose
 * confirm button stays disabled until the user ticks "I understand … will be contacted" - the
 * call is never sent live from one click.
 */
@Component({
  selector: 'app-relive-request-differs-dialog',
  standalone: true,
  templateUrl: './relive-request-differs-dialog.component.html',
})
export class ReliveRequestDiffersDialogComponent {
  readonly open = input.required<boolean>();
  readonly step = input<Step | null>(null);
  /** Set when a step's request was just edited and this dialog opens automatically to ask about it. */
  readonly reason = input<string | null>(null);

  readonly stepChange = output<Step>();
  readonly closed = output<void>();

  readonly choices = CHOICES;
  readonly confirmingLive = signal(false);
  readonly liveConfirmChecked = signal(false);

  readonly current = computed<OnRequestChanged | null>(() => {
    const step = this.step();
    return step ? onRequestChangedOf(step.callRule) : null;
  });

  choose(value: OnRequestChanged): void {
    if (value === 'LIVE') {
      this.confirmingLive.set(true);
      this.liveConfirmChecked.set(false);
      return;
    }
    this.apply(value);
  }

  back(): void {
    this.confirmingLive.set(false);
  }

  confirmLive(): void {
    if (!this.liveConfirmChecked()) return;
    this.apply('LIVE');
  }

  private apply(value: OnRequestChanged): void {
    const step = this.step();
    if (!step) return;
    this.stepChange.emit({ ...step, callRule: setOnRequestChanged(step.callRule, value, step.key) });
    this.confirmingLive.set(false);
    this.close();
  }

  close(): void {
    this.confirmingLive.set(false);
    this.closed.emit();
  }
}
