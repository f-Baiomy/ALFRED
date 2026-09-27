import { Component, DestroyRef, computed, inject, input, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { CallRecord } from '../../core/models/call.model';
import { RuleAction, RuleSource } from '../../core/models/interception.model';
import { CallRefDetailService } from '../../core/services/call-ref-detail.service';
import { CaptureOutcome, LOOKS_SECRET, captureValueFor, maskText, shapeOf } from '../../shared/utils/capture-preview';
import { CallFinderComponent, FoundCall } from '../call-finder/call-finder.component';

/**
 * "Preview on a call…" for CAPTURE_REQUEST_VARIABLE / CAPTURE_RESPONSE_VARIABLE: pick any logged
 * call and see whether the capture would find its source, what it would read (masked when the
 * variable's name looks secret, with reveal), its JSON type and length, and the fallback used when
 * the source is missing. The same call-finder + hydrate pattern as `app-replace-preview` - nothing
 * is sent or changed, and it re-renders as the action's fields are edited.
 */
@Component({
  selector: 'app-capture-value-preview',
  standalone: true,
  imports: [CallFinderComponent],
  templateUrl: './capture-value-preview.component.html',
})
export class CaptureValuePreviewComponent {
  private readonly refDetail = inject(CallRefDetailService);
  private readonly destroyRef = inject(DestroyRef);

  readonly action = input.required<RuleAction>();
  readonly ruleHost = input<string>('');
  readonly rulePath = input<string>('');
  readonly ruleMethods = input<readonly string[]>([]);
  readonly ruleSource = input<RuleSource>('both');
  readonly ruleServiceNames = input<readonly string[]>([]);

  readonly open = signal(false);
  readonly loading = signal(false);
  readonly error = signal<string | null>(null);
  readonly call = signal<CallRecord | null>(null);
  readonly revealed = signal(false);

  readonly phase = computed<'request' | 'response'>(() => (this.action().type === 'CAPTURE_RESPONSE_VARIABLE' ? 'response' : 'request'));

  private readonly message = computed(() => {
    const call = this.call();
    if (!call) return null;
    return this.phase() === 'request' ? (call.request ?? null) : (call.response ?? null);
  });

  readonly result = computed<CaptureOutcome | null>(() => {
    const call = this.call();
    if (!call) return null;
    const action = this.action();
    return captureValueFor(this.message(), action.captureSource, action.path, this.phase());
  });

  /** Whether the value shown is the real source, or the missingBehavior:FALLBACK stand-in. */
  readonly usedFallback = computed(() => {
    const result = this.result();
    return !!result && !result.found && this.action().missingBehavior === 'FALLBACK';
  });

  readonly shown = computed<CaptureOutcome | null>(() => {
    const result = this.result();
    if (!result) return null;
    if (result.found) return result;
    if (this.usedFallback()) return { found: true, value: this.action().value ?? null };
    return result;
  });

  readonly looksSecret = computed(() => LOOKS_SECRET.test((this.action().name ?? '').trim()));

  readonly shape = computed(() => {
    const shown = this.shown();
    return shown?.found ? shapeOf(shown.value) : null;
  });

  readonly displayValue = computed<string>(() => {
    const shown = this.shown();
    if (!shown?.found) return '';
    const text = typeof shown.value === 'string' ? shown.value : JSON.stringify(shown.value);
    return this.looksSecret() && !this.revealed() ? maskText(text) : text;
  });

  toggle(): void {
    this.open.update((v) => !v);
  }

  toggleReveal(): void {
    this.revealed.update((v) => !v);
  }

  onChosen(found: FoundCall): void {
    this.loading.set(true);
    this.error.set(null);
    this.revealed.set(false);
    this.refDetail
      .hydrate({ source: found.direction === 'inbound' ? 'internal' : 'external', callId: found.call.id, cycleId: null }, found.call)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (call) => {
          this.loading.set(false);
          this.call.set(call);
        },
        error: () => {
          this.loading.set(false);
          this.error.set('Could not load that call.');
        },
      });
  }

  pickAnother(): void {
    this.call.set(null);
  }
}
