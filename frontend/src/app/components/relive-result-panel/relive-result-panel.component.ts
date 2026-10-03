import { Component, computed, input, output, signal } from '@angular/core';
import { CallStepStripComponent, CallStripStep } from '../call-step-strip/call-step-strip.component';
import { InterceptionPanelComponent } from '../interception-panel/interception-panel.component';
import { CallInterception, Condition, OriginalHttp, describeCondition } from '../../core/models/interception.model';
import { CheckRowResult, StepCheckResults, foundLine, isCheckResults, tally } from '../../shared/utils/relive-checks';
import { requestBodyOf } from '../../shared/utils/relive-call-rule';
import { maskRelive } from '../../shared/utils/relive-mask';
import { sessionAppliedOf } from '../../shared/utils/relive-session';
import { StepReason, formatReasonDetail } from '../../shared/utils/relive-outcome';
import { CycleVariable, DifferenceEntry, Step, StepResult } from '../../shared/utils/relive-types';
import { AssertionResult } from '../../shared/utils/scenario-types';

/** One field that differs between the recording and this run, as the run timeline lists it. */
export interface ShownDifference {
  readonly path: string;
  readonly recorded: string | null;
  readonly actual: string | null;
  readonly part?: string;
  readonly kind?: DifferenceEntry['kind'];
  readonly cause?: string | null;
}

type Box = 'recorded' | 'edits' | 'variables' | 'sent' | 'rules' | 'answered' | 'response' | 'values';

/** Reduces a StepResult's stored request/response to what InterceptionPanelComponent draws. */
function toHttp(value: unknown): OriginalHttp | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as { status?: unknown; headers?: unknown; body?: unknown; method?: unknown; url?: unknown };
  return {
    status: typeof v.status === 'number' ? v.status : null,
    method: typeof v.method === 'string' ? v.method : null,
    url: typeof v.url === 'string' ? v.url : null,
    headers: (v.headers && typeof v.headers === 'object' ? v.headers : {}) as Readonly<Record<string, string>>,
    body: typeof v.body === 'string' ? v.body : v.body == null ? null : JSON.stringify(v.body),
  };
}

function assertionResultsOf(raw: unknown): readonly AssertionResult[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((item): item is AssertionResult => !!item && typeof item === 'object' && 'assertion' in item);
}

/**
 * What happened to one step of a run, as one more panel of the Live Calls call card - the twin of
 * "Resent from…" (same frame, the same numbered strip, the same Request / Response diff). The card
 * itself is the call the run made, so its ⚡ intercepted panel and error banner show as for any call.
 */
@Component({
  selector: 'app-relive-result-panel',
  standalone: true,
  imports: [CallStepStripComponent, InterceptionPanelComponent],
  templateUrl: './relive-result-panel.component.html',
})
export class ReliveResultPanelComponent {
  readonly step = input.required<Step>();
  readonly result = input.required<StepResult>();
  /** Why the step failed / was skipped (the timeline's `whyOf`). */
  readonly reasons = input<readonly StepReason[]>([]);
  readonly differences = input<readonly ShownDifference[]>([]);
  readonly diffNote = input<string | null>(null);
  readonly variableDefs = input<readonly CycleVariable[]>([]);
  readonly variables = input<Readonly<Record<string, string>>>({});
  /** A field already ignored or counted from this run (the timeline keeps the set). */
  readonly markedPaths = input<ReadonlySet<string>>(new Set());

  /** Values the run swapped in and cookies it carried for this attempt (relive-session.ts). */
  readonly session = computed(() => sessionAppliedOf(this.result()));

  variablesLine(): string {
    const result = this.result();
    const parts = result.variablesUsed.map((v) => v.name);
    const cookies = this.session()?.cookies ?? [];
    if (cookies.length) parts.push(`cookie${cookies.length === 1 ? '' : 's'} ${cookies.join(', ')}`);
    return parts.length ? parts.join(', ') : 'none';
  }

  readonly ignore = output<{ readonly diff: ShownDifference; readonly scope: 'STEP' | 'CYCLE' }>();
  readonly count = output<ShownDifference>();
  readonly showReason = output<StepReason>();
  readonly showAllDifferences = output<void>();

  readonly open = signal(true);
  private readonly picked = signal<Box | null>(null);
  readonly box = computed<Box>(() => {
    const picked = this.picked();
    if (picked) return picked;
    const state = this.result().state;
    return state === 'FAILED' || state === 'COMPLETED_WITH_DIFFERENCES' ? 'response' : 'recorded';
  });
  readonly half = signal<'request' | 'response'>('response');

  readonly status = computed(() => toHttp(this.result().actualResponse)?.status ?? null);
  readonly edited = computed(() => requestBodyOf(this.step().callRule) !== null);
  readonly assertions = computed(() => assertionResultsOf(this.result().assertions));
  /** Checks as groups of rule conditions, evaluated by the proxy (relive-checks.ts). */
  readonly checks = computed<StepCheckResults | null>(() => {
    const raw = this.result().assertions;
    return isCheckResults(raw) ? raw : null;
  });
  readonly checkTally = computed(() => tally(this.checks()));
  readonly failedChecks = computed(() => this.assertions().filter((a) => !a.passed).length + this.checkTally().failed);
  readonly warnedChecks = computed(() => this.checkTally().warned);

  describe(condition: Condition): string {
    return describeCondition(condition);
  }

  foundLine(row: CheckRowResult): string {
    return this.mask(foundLine(row));
  }

  /** Each item a list condition looked at, with whether it held - the chips under a row. */
  items(row: CheckRowResult): readonly { readonly value: string; readonly holds: boolean }[] {
    const field = row.found?.fields?.[0];
    if (!field?.itemHolds) return [];
    return field.itemHolds.map((holds, i) => ({ value: this.mask(String(field.values[i] ?? 'null')), holds }));
  }

  /** Each saved value of this step: what this run got next to what the recording had. */
  readonly values = computed(() => {
    const produced = new Map(this.result().variablesProduced.map((v) => [v.name, v.value]));
    return this.step().extract.map((rule) => ({
      rule,
      value: produced.has(rule.as) ? produced.get(rule.as)! : null,
    }));
  });

  readonly strip = computed<readonly CallStripStep[]>(() => {
    const { step } = this;
    const result = this.result();
    const status = this.status();
    const answered = result.mode === 'REPLAY' ? 'ALFRED answered (recording)' : result.reachedUpstream === false ? 'answered by ALFRED' : 'real host contacted';
    const values = this.values();
    const missing = values.filter((v) => v.value === null).length;
    const checks = this.assertions().length + (this.checks()?.groups.length ?? 0);
    const warned = this.warnedChecks();
    return [
      { key: 'recorded', title: 'Recorded call', line: `${step().recording.method} · ${step().recording.status}` },
      { key: 'edits', title: 'Your edits', line: this.edited() ? 'request body replaced' : 'none' },
      { key: 'variables', title: 'Variables', line: this.variablesLine() },
      { key: 'sent', title: 'Sent', line: `attempt ${result.attempt}${result.requestChanged ? ' · differs from the recording' : ''}` },
      { key: 'rules', title: 'Rules', line: result.rulesApplied.length ? `${result.rulesApplied.length} applied` : 'none' },
      { key: 'answered', title: result.mode === 'REPLAY' ? 'ALFRED' : 'Upstream', line: answered },
      { key: 'response', title: 'Response', line: status == null ? (result.error ? 'no answer' : 'none') : `${status} (recorded ${step().recording.status})${this.differences().length ? ` · ${this.differences().length} diffs` : ''}` },
      {
        key: 'values',
        title: 'Values',
        line: [values.length ? (missing ? `${missing} missing` : `${values.length} saved`) : '', checks ? (this.failedChecks() ? `${this.failedChecks()} of ${checks} checks failed` : `${checks - warned} checks passed`) : '', warned ? `${warned} warning${warned === 1 ? '' : 's'}` : '']
          .filter(Boolean).join(' · ') || 'none',
      },
    ];
  });

  readonly summary = computed(() => {
    const result = this.result();
    const parts = [`attempt ${result.attempt}`, result.mode];
    if (result.rulesApplied.length) parts.push(`${result.rulesApplied.length} rule${result.rulesApplied.length === 1 ? '' : 's'}`);
    if (this.differences().length) parts.push(`${this.differences().length} difference${this.differences().length === 1 ? '' : 's'}`);
    if (this.failedChecks()) parts.push(`${this.failedChecks()} check${this.failedChecks() === 1 ? '' : 's'} failed`);
    if (this.warnedChecks()) parts.push(`${this.warnedChecks()} warning${this.warnedChecks() === 1 ? '' : 's'}`);
    return parts.join(' · ');
  });

  readonly compare = computed<CallInterception>(() => {
    const rec = this.step().recording;
    const result = this.result();
    return {
      applied: [],
      originalRequest: this.maskHttp({ method: rec.method, url: rec.url, headers: rec.requestHeaders, body: rec.requestBody ?? '' }),
      originalResponse: this.maskHttp({ status: rec.status, headers: rec.responseHeaders, body: rec.responseBody ?? '' }),
      finalRequest: this.maskHttp(toHttp(result.actualRequest) ?? toHttp(result.effectiveRequest)),
      finalResponse: this.maskHttp(toHttp(result.actualResponse)),
    };
  });

  readonly hasRequest = computed(() => !!(this.result().actualRequest || this.result().effectiveRequest));
  readonly hasResponse = computed(() => !!this.result().actualResponse);

  readonly requestLabels = { title: 'Request', before: 'Recorded', after: 'Sent', legend: 'Red is what the recording sent; green is what this run sent.' };
  readonly responseLabels = { title: 'Response', before: 'Recorded', after: 'This run', legend: 'Red is what the recording had; green is what came back this run.' };

  toggle(): void {
    this.open.set(!this.open());
  }

  select(key: string): void {
    this.picked.set(key as Box);
  }

  isMarked(path: string): boolean {
    return this.markedPaths().has(`${this.step().key}|${path}`);
  }

  formatValue(value: string | null): string {
    if (value == null) return '(not present)';
    if (!value) return '(empty)';
    return this.mask(formatReasonDetail(value));
  }

  mask(text: string): string {
    const secrets = this.variableDefs().filter((v) => v.secret).map((v) => v.name);
    return maskRelive(text, secrets, this.variables());
  }

  private maskHttp(http: OriginalHttp | null): OriginalHttp | null {
    if (!http) return null;
    return {
      ...http,
      headers: Object.fromEntries(Object.entries(http.headers ?? {}).map(([name, value]) => [name, this.mask(value)])),
      body: http.body ? this.mask(http.body) : http.body,
    };
  }
}
