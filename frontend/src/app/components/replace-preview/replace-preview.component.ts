import { Component, DestroyRef, computed, inject, input, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { CallRecord } from '../../core/models/call.model';
import { CallInterception, RuleAction, RuleSource } from '../../core/models/interception.model';
import { CallRefDetailService } from '../../core/services/call-ref-detail.service';
import { previewBodyReplace } from '../../shared/utils/replace-preview';
import { CallFinderComponent, FoundCall } from '../call-finder/call-finder.component';
import { InterceptionPanelComponent } from '../interception-panel/interception-panel.component';

/**
 * "Try on a call…" for Find & replace in a body: pick any logged call and see its body before and
 * after this action, with the action's own literal/regex, match-case and "at most" settings -
 * the same diff viewer (find, copy, Headers/Body) as the intercepted-call panel. Nothing is sent
 * or changed; it re-renders as the find/replace fields are edited.
 */
@Component({
  selector: 'app-replace-preview',
  standalone: true,
  imports: [CallFinderComponent, InterceptionPanelComponent],
  templateUrl: './replace-preview.component.html',
})
export class ReplacePreviewComponent {
  private readonly refDetail = inject(CallRefDetailService);
  private readonly destroyRef = inject(DestroyRef);

  /** The REPLACE_IN_*_BODY action, live - edits to its fields re-run the preview. */
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

  readonly phase = computed<'request' | 'response'>(() => (this.action().type === 'REPLACE_IN_RESPONSE_BODY' ? 'response' : 'request'));

  private readonly body = computed(() => {
    const call = this.call();
    const half = this.phase() === 'request' ? call?.request : call?.response;
    return half?.body ?? '';
  });

  readonly result = computed(() => (this.call() ? previewBodyReplace(this.body(), this.action()) : null));

  /** Before = the call's body as logged, after = what this action would make of it. */
  readonly view = computed<CallInterception | null>(() => {
    const result = this.result();
    const call = this.call();
    if (!call || !result) return null;
    const half = this.phase() === 'request' ? call.request : call.response;
    const before = { headers: half?.headers ?? {}, body: this.body() };
    const after = { headers: half?.headers ?? {}, body: result.text ?? this.body() };
    return this.phase() === 'request'
      ? { applied: [], originalRequest: before, finalRequest: after }
      : { applied: [], originalResponse: before, finalResponse: after };
  });

  readonly labels = {
    title: 'Preview',
    before: 'Body as logged',
    after: 'After this action',
    legend: 'Red is the body as logged; green is what this action would turn it into. Nothing is sent or changed.',
  };

  toggle(): void {
    this.open.update((v) => !v);
  }

  onChosen(found: FoundCall): void {
    this.loading.set(true);
    this.error.set(null);
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
