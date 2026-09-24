import { Component, DestroyRef, computed, inject, input, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { forkJoin, map, of, switchMap } from 'rxjs';
import { catchError } from 'rxjs/operators';
import { CallRecord } from '../../core/models/call.model';
import { refOf } from '../../core/models/call-ref.model';
import { CallInterception, OriginalHttp } from '../../core/models/interception.model';
import { CallRefDetailService } from '../../core/services/call-ref-detail.service';
import { CallsApiService } from '../../core/services/calls-api.service';
import { SessionCyclesApiService } from '../../core/services/session-cycles-api.service';
import { CALL_ORIGIN } from '../../core/state/call-origin.token';
import { SessionCyclesStateService } from '../../core/state/session-cycles-state.service';
import { buildHttpDiff } from '../../shared/utils/interception-diff';
import { ResendSummary, describeResendChanges, originalRefOf, resendSummaryOf } from '../../shared/utils/resend-summary';
import { statusLabel } from '../../shared/utils/http-status';
import { InterceptionPanelComponent } from '../interception-panel/interception-panel.component';

export type ResendStep = 'original' | 'edits' | 'session' | 'sent' | 'rules' | 'upstream' | 'response';

interface Loaded {
  readonly original: CallRecord | null;
  readonly current: CallRecord | null;
}

/**
 * The whole cycle of a resent call, on its own card: the original it came from, what you changed,
 * the session values swapped in, how it went out, which rules touched it, what the host answered -
 * and both halves side by side with the original's (Original / Resent / Diff), request AND
 * response.
 *
 * Deliberately the intercepted-call panel's twin: same head, same step rows, and the SAME diff
 * viewer - `InterceptionPanelComponent` embedded, fed the two calls as its before and after - so
 * find, "in Headers/Body" and copy work identically and a SOAP envelope looks exactly as it does
 * everywhere else.
 *
 * Nothing is fetched until the panel is opened: the original's detail (from its cycle when the
 * resend recorded one) and this call's own detail, once. The original may have left the log - the
 * steps still show from what the resend recorded, and the views say it is gone.
 */
@Component({
  selector: 'app-resend-panel',
  standalone: true,
  imports: [InterceptionPanelComponent],
  templateUrl: './resend-panel.component.html',
})
export class ResendPanelComponent {
  private readonly refDetail = inject(CallRefDetailService);
  private readonly callsApi = inject(CallsApiService);
  private readonly cyclesApi = inject(SessionCyclesApiService);
  private readonly cyclesState = inject(SessionCyclesStateService);
  private readonly origin = inject(CALL_ORIGIN, { optional: true });
  private readonly destroyRef = inject(DestroyRef);

  /** The resent call. */
  readonly call = input.required<CallRecord>();

  readonly open = signal(false);
  readonly step = signal<ResendStep>('response');
  readonly half = signal<'request' | 'response'>('response');
  readonly loading = signal(false);
  readonly loaded = signal<Loaded | null>(null);

  readonly summary = computed<ResendSummary>(() => resendSummaryOf(this.call()) ?? {});
  readonly originalRef = computed(() => originalRefOf(this.call()));
  readonly changes = computed(() => describeResendChanges(this.summary()));

  readonly originLabel = computed(() => {
    const cycleId = this.originalRef()?.cycleId;
    if (!cycleId) return 'a Live Calls call';
    const name = this.cyclesState.cycles().find((c) => c.id === cycleId)?.name;
    return name ? `cycle "${name}"` : 'a session cycle';
  });

  readonly batchLabel = computed(() => {
    const batch = this.summary().batch;
    return batch ? `${batch.index} of ${batch.total} in batch` : null;
  });

  readonly original = computed(() => this.loaded()?.original ?? null);
  readonly originalGone = computed(() => this.loaded() !== null && this.loaded()!.original === null);

  /** What the original looked like on the way out: its own method/url from the summary when edited, else this call's. */
  readonly originalRequest = computed<OriginalHttp | null>(() => {
    const original = this.original();
    if (!original) return null;
    const s = this.summary();
    return {
      method: s.method?.from ?? this.call().method,
      url: s.url?.from ?? this.call().url,
      headers: original.request?.headers ?? {},
      body: original.request?.body ?? '',
    };
  });

  readonly currentRequest = computed<OriginalHttp | null>(() => {
    const current = this.loaded()?.current;
    return current ? { method: current.method, url: current.url, headers: current.request?.headers ?? {}, body: current.request?.body ?? '' } : null;
  });

  readonly originalResponse = computed<OriginalHttp | null>(() => responseOf(this.original()));
  readonly currentResponse = computed<OriginalHttp | null>(() => responseOf(this.loaded()?.current ?? null));

  /** Both halves as the interception panel reads them - before = the original call, after = this one. */
  readonly requestView = computed<CallInterception>(() => ({
    applied: [],
    originalRequest: this.originalRequest() ?? undefined,
    finalRequest: this.currentRequest() ?? undefined,
  }));

  readonly responseView = computed<CallInterception>(() => ({
    applied: [],
    originalResponse: this.originalResponse() ?? undefined,
    finalResponse: this.currentResponse() ?? undefined,
  }));

  readonly requestLabels = {
    title: 'Request',
    before: 'Original request',
    after: 'Resent request',
    legend: "Red was in the original call's request; green is what was resent.",
  };

  readonly responseLabels = {
    title: 'Response',
    before: 'Original response',
    after: 'Resent response',
    legend: "Red is what the host answered the original call; green is what it answered this time.",
  };

  /** "response changed: 200 → 409, body differs" - only once both sides are in hand. */
  readonly responseChange = computed(() => {
    const diff = this.loaded() ? buildHttpDiff(this.originalResponse(), this.currentResponse()) : null;
    if (!diff) return null;
    const parts: string[] = [];
    if (diff.statusChange) parts.push(diff.statusChange);
    if (diff.headersChanged) parts.push('headers differ');
    if (diff.bodyChanged) parts.push('body differs');
    return parts.length ? `response changed: ${parts.join(', ')}` : 'same response as the original';
  });

  readonly headSummary = computed(() => {
    const changes = this.changes();
    const request = changes.length ? `${changes.length} change${changes.length === 1 ? '' : 's'}: ${changes.join(' · ')}` : 'resent unchanged';
    const response = this.responseChange();
    return response ? `${request} · ${response}` : request;
  });

  readonly rules = computed(() => this.call().interception?.applied ?? []);

  readonly steps = computed<readonly { readonly key: ResendStep; readonly title: string; readonly line: string }[]>(() => {
    const call = this.call();
    const s = this.summary();
    const original = this.original();
    const status = call.response?.status;
    const originalStatus = original?.response?.status;
    return [
      { key: 'original', title: 'Original call', line: original ? `${s.method?.from ?? call.method} · ${originalStatus ?? '—'}${durationText(original)}` : this.originLabel() },
      { key: 'edits', title: 'Your edits', line: this.changes().filter((c) => !c.includes('session')).join(' · ') || 'none' },
      { key: 'session', title: 'Session', line: s.session?.length ? `${s.session.length} value${s.session.length === 1 ? '' : 's'} swapped` : 'not used' },
      { key: 'sent', title: 'Sent', line: call.source === 'internal' ? `to ${call.service_name ?? 'the project'}'s reverse proxy` : 'forward proxy' },
      { key: 'rules', title: 'Rules', line: this.rules().length ? `${this.rules().length} applied` : 'none' },
      { key: 'upstream', title: 'Upstream', line: `${hostOf(call.url)}${durationText(call)}` },
      { key: 'response', title: 'Response', line: `${status ?? (call.error ? 'failed' : '…')}${originalStatus != null ? ` · was ${originalStatus}` : ''}` },
    ];
  });

  toggle(): void {
    this.open.update((v) => !v);
    if (this.open()) this.load();
  }

  select(step: ResendStep): void {
    this.step.set(step);
    if (step === 'original' || step === 'edits' || step === 'session' || step === 'sent') this.half.set('request');
    if (step === 'response' || step === 'upstream') this.half.set('response');
  }

  statusText(status: number | null | undefined): string {
    return status == null ? '—' : statusLabel(status);
  }

  durationOf(call: CallRecord | null): string {
    return durationText(call).replace(/^ · /, '');
  }

  hostOf = hostOf;

  /** Once per card: the original (from its cycle if recorded) and this call's own full detail. */
  private load(): void {
    if (this.loaded() || this.loading()) return;
    const call = this.call();
    const ref = this.originalRef();
    this.loading.set(true);
    const currentRef = refOf(call, this.origin?.cycleId() ?? null);
    // The summary may be gone while the detail is not (or the other way round) - a missing
    // summary still lets the detail be asked for, and only a missing detail means "gone".
    const original$ = ref
      ? this.findOriginalSummary(ref.source, ref.callId, ref.cycleId).pipe(
          switchMap((summary) => this.refDetail.hydrate(ref, summary ?? stubOf(call, ref.callId))),
          catchError(() => of(null))
        )
      : of(null);
    forkJoin({
      original: original$,
      current: this.refDetail.hydrate(currentRef, call).pipe(catchError(() => of(null))),
    })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((result) => {
        this.loading.set(false);
        this.loaded.set(result);
      });
  }

  /** Where "open original" goes - the live log's filter, or the cycle it was captured in. */
  readonly originalHref = computed(() => {
    const ref = this.originalRef();
    if (!ref) return null;
    const query = `?requestId=${encodeURIComponent(ref.callId)}`;
    return ref.cycleId ? `/cycles/${ref.cycleId}${query}` : `/${query}`;
  });

  /** The original's own summary (method, status, timestamp, duration) - the detail endpoint carries none of those. */
  private findOriginalSummary(source: 'external' | 'internal', callId: string, cycleId: string | null) {
    const query = { search: '', supplier: '', sort: 'newest' as const, offset: 0, limit: 5, sessionId: '', operationId: '', requestId: callId };
    const page$ = cycleId ? this.cyclesApi.listCalls(cycleId, query, source).pipe(map((p) => p.calls.map((c) => c.call))) : this.callsApi.getCalls(query, source).pipe(map((p) => p.calls));
    return page$.pipe(
      map((calls: readonly CallRecord[]) => calls.find((c) => c.id === callId) ?? null),
      catchError(() => of(null))
    );
  }
}

function responseOf(call: CallRecord | null): OriginalHttp | null {
  if (!call?.response) return null;
  return { status: call.response.status, headers: call.response.headers ?? {}, body: call.response.body ?? '' };
}

function durationText(call: CallRecord | null): string {
  const ms = call?.duration_ms;
  return ms == null ? '' : ` · ${Math.round(ms)} ms`;
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/** When the original's summary is gone but its detail may not be (or neither is) - enough to ask for the detail. */
function stubOf(call: CallRecord, id: string): CallRecord {
  return { id, original_url: call.original_url, url: call.url, method: call.method, timestamp: '', duration_ms: 0 };
}
