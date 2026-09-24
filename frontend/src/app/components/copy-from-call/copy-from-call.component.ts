import { Component, DestroyRef, OnInit, computed, inject, input, output, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { CallRecord } from '../../core/models/call.model';
import { CallRef } from '../../core/models/call-ref.model';
import { RuleSource } from '../../core/models/interception.model';
import { CallRefDetailService } from '../../core/services/call-ref-detail.service';
import { InterceptionStateService } from '../../core/state/interception-state.service';
import { detectAndFormatBody } from '../../shared/utils/body-format';
import { CopyChoices, CopyResult, CopySource, CopyTarget, buildCopy, copySourceOf, defaultChoices } from '../../shared/utils/copy-from-call';
import { CallFinderComponent, FoundCall } from '../call-finder/call-finder.component';

/** A call picked elsewhere (Pick from anywhere) - the panel opens straight at "choose what to copy". */
export interface CopyPreload {
  readonly ref: CallRef;
  readonly call: CallRecord;
}

/**
 * "Copy from a call…" for the body-shaped actions: find a call (the same finder the stored-answer
 * picker uses), then tick which parts to bring into the rule - body, content type, status, each
 * header (secrets unticked and tagged), method, URL - and apply. Nothing is sent anywhere; the
 * result is ordinary, editable rule actions (see copy-from-call.ts for where each part lands).
 */
@Component({
  selector: 'app-copy-from-call',
  standalone: true,
  imports: [CallFinderComponent],
  templateUrl: './copy-from-call.component.html',
})
export class CopyFromCallComponent implements OnInit {
  private readonly refDetail = inject(CallRefDetailService);
  private readonly interception = inject(InterceptionStateService);
  private readonly destroyRef = inject(DestroyRef);

  readonly target = input.required<CopyTarget>();
  readonly ruleHost = input<string>('');
  readonly rulePath = input<string>('');
  readonly ruleMethods = input<readonly string[]>([]);
  readonly ruleSource = input<RuleSource>('both');
  readonly ruleServiceNames = input<readonly string[]>([]);
  readonly preload = input<CopyPreload | null>(null);

  readonly applied = output<CopyResult>();
  readonly cancelled = output<void>();
  readonly pickAnywhere = output<void>();

  readonly loading = signal(false);
  readonly error = signal<string | null>(null);
  readonly picked = signal<{ call: CallRecord; where: string } | null>(null);
  readonly source = signal<CopySource | null>(null);
  readonly choices = signal<CopyChoices | null>(null);

  readonly part = computed(() => (this.target() === 'request-body' ? 'request' : 'response'));
  readonly isRequest = computed(() => this.target() === 'request-body');
  readonly isWhole = computed(() => this.target() === 'response-whole');
  readonly bodyLines = computed(() => {
    const body = this.source()?.body ?? '';
    return body ? detectAndFormatBody(body).body.split('\n').length : 0;
  });
  /** Header ACTIONS the apply will add - Content-Type rides on the body action instead when that box is ticked. */
  readonly tickedHeaders = computed(() => {
    const c = this.choices();
    if (!c) return 0;
    return Object.entries(c.headers).filter(([name, on]) => on && !(this.isRequest() && c.contentType && name.toLowerCase() === 'content-type')).length;
  });

  ngOnInit(): void {
    const preload = this.preload();
    if (preload) this.load(preload.ref, preload.call, preload.ref.cycleId ? 'a session cycle' : 'Live Calls');
  }

  onChosen(found: FoundCall): void {
    const ref: CallRef = { source: found.direction === 'inbound' ? 'internal' : 'external', callId: found.call.id, cycleId: null };
    this.load(ref, found.call, 'Live Calls');
  }

  private load(ref: CallRef, summary: CallRecord, where: string): void {
    this.loading.set(true);
    this.error.set(null);
    this.refDetail
      .hydrate(ref, summary)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (call) => {
          this.loading.set(false);
          const source = copySourceOf(call, this.target(), this.interception.sensitiveNames() ?? null);
          this.picked.set({ call, where });
          this.source.set(source);
          this.choices.set(defaultChoices(source));
        },
        error: () => {
          this.loading.set(false);
          this.error.set('Could not load that call - it may have left the log.');
        },
      });
  }

  set(field: 'body' | 'contentType' | 'status' | 'method' | 'url', event: Event): void {
    const on = (event.target as HTMLInputElement).checked;
    this.choices.update((c) => (c ? { ...c, [field]: on } : c));
  }

  setHeader(name: string, event: Event): void {
    const on = (event.target as HTMLInputElement).checked;
    this.choices.update((c) => (c ? { ...c, headers: { ...c.headers, [name]: on } } : c));
  }

  setAllHeaders(on: boolean): void {
    this.choices.update((c) => (c ? { ...c, headers: Object.fromEntries(Object.keys(c.headers).map((n) => [n, on])) } : c));
  }

  back(): void {
    this.picked.set(null);
    this.source.set(null);
    this.choices.set(null);
  }

  apply(): void {
    const source = this.source();
    const choices = this.choices();
    if (!source || !choices) return;
    this.applied.emit(buildCopy(source, this.target(), choices));
  }

  shortUrl(url: string): string {
    try {
      const u = new URL(url);
      return u.host + u.pathname;
    } catch {
      return url;
    }
  }
}
