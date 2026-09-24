import { Component, DestroyRef, OnInit, computed, inject, input, output, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { CallRecord } from '../../core/models/call.model';
import { CallRef } from '../../core/models/call-ref.model';
import { MATCH_TEST_KINDS, MATCH_TEST_OPERATOR_LABELS, MatchTestOperator, matchTestNeedsValue } from '../../core/models/interception.model';
import { CallRefDetailService } from '../../core/services/call-ref-detail.service';
import { InterceptionStateService } from '../../core/state/interception-state.service';
import {
  MatchChoices,
  MatchFill,
  MatchForm,
  MatchSource,
  TestChoice,
  buildMatchFill,
  defaultMatchChoices,
  hostVariants,
  matchSourceOf,
  pathVariants,
} from '../../shared/utils/match-from-call';
import { CallFinderComponent, FoundCall } from '../call-finder/call-finder.component';
import { CopyPreload } from '../copy-from-call/copy-from-call.component';
import { SelectOption, SelectPickerComponent } from '../select-picker/select-picker.component';

/** What "Fill match" hands the rule editor: the fields to write, and the call they came from (for the live check). */
export interface MatchFillResult {
  readonly fill: MatchFill;
  readonly source: MatchSource;
  /** "POST api.sabre.com/v2/flight/search" - for the banner. */
  readonly label: string;
}

/**
 * "Fill from a call…" for the rule editor's Match section: find a call (the shared finder), then
 * check and adjust which of its parts become the match - direction, project, host (exact or
 * `*.parent`), path (whole, a prefix, or a generalised regex), method - and which headers, query
 * parameters and cookies become "Only when…" tests. Nothing is saved; the result is written into
 * the ordinary form fields, where it stays editable (see match-from-call.ts).
 */
@Component({
  selector: 'app-match-from-call',
  standalone: true,
  imports: [CallFinderComponent, SelectPickerComponent],
  templateUrl: './match-from-call.component.html',
})
export class MatchFromCallComponent implements OnInit {
  private readonly refDetail = inject(CallRefDetailService);
  private readonly interception = inject(InterceptionStateService);
  private readonly destroyRef = inject(DestroyRef);

  /** The form's match as it is now - the "Now in rule" column, and the finder's "Matches this rule". */
  readonly current = input.required<MatchForm>();
  readonly preload = input<CopyPreload | null>(null);

  readonly applied = output<MatchFillResult>();
  readonly cancelled = output<void>();
  readonly pickAnywhere = output<void>();

  readonly loading = signal(false);
  readonly error = signal<string | null>(null);
  readonly where = signal('');
  readonly source = signal<MatchSource | null>(null);
  readonly choices = signal<MatchChoices | null>(null);

  readonly kindLabels = MATCH_TEST_KINDS;
  readonly operatorOptions: readonly SelectOption[] = (Object.keys(MATCH_TEST_OPERATOR_LABELS) as MatchTestOperator[]).map((o) => ({
    value: o,
    label: MATCH_TEST_OPERATOR_LABELS[o],
  }));
  readonly hostOptions = computed<readonly SelectOption[]>(() =>
    hostVariants(this.source()?.host ?? '').map((v) => ({ value: v.value, label: `${v.label} · ${v.value}` }))
  );
  private readonly pathVariantList = computed(() => pathVariants(this.source()?.path ?? ''));
  readonly pathOptions = computed<readonly SelectOption[]>(() => this.pathVariantList().map((v, i) => ({ value: String(i), label: v.label })));
  /** Which preset the path box currently shows - '' once the user has typed their own. */
  readonly pathPreset = computed(() => {
    const c = this.choices();
    if (!c) return '';
    const i = this.pathVariantList().findIndex((v) => v.form === c.pathForm && v.value === c.pathValue);
    return i < 0 ? '' : String(i);
  });
  readonly checkedTests = computed(() => this.choices()?.tests.filter((t) => t.on).length ?? 0);

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
          const source = matchSourceOf(call, ref.source === 'internal' ? 'inbound' : 'outbound', this.interception.sensitiveNames() ?? null);
          this.where.set(where);
          this.source.set(source);
          this.choices.set(defaultMatchChoices(source));
        },
        error: () => {
          this.loading.set(false);
          this.error.set('Could not load that call - it may have left the log.');
        },
      });
  }

  toggle(field: 'direction' | 'project' | 'host' | 'path' | 'method', event: Event): void {
    const on = (event.target as HTMLInputElement).checked;
    this.choices.update((c) => (c ? { ...c, [field]: on } : c));
  }

  setHost(value: string): void {
    this.choices.update((c) => (c ? { ...c, host: true, hostValue: value } : c));
  }

  choosePath(index: string): void {
    const variant = this.pathVariantList()[Number(index)];
    if (!variant) return;
    this.choices.update((c) => (c ? { ...c, path: true, pathForm: variant.form, pathValue: variant.value } : c));
  }

  setPathValue(value: string): void {
    this.choices.update((c) => (c ? { ...c, path: true, pathValue: value } : c));
  }

  setPathForm(form: 'contains' | 'regex'): void {
    this.choices.update((c) => (c ? { ...c, path: true, pathForm: form } : c));
  }

  patchTest(index: number, patch: Partial<TestChoice>): void {
    this.choices.update((c) => (c ? { ...c, tests: c.tests.map((t, i) => (i === index ? { ...t, ...patch } : t)) } : c));
  }

  /** Editing a test's operator or value checks it - the user plainly wants it. */
  editTest(index: number, patch: Partial<TestChoice>): void {
    this.patchTest(index, { ...patch, on: true });
  }

  setAllTests(on: boolean): void {
    this.choices.update((c) => (c ? { ...c, tests: c.tests.map((t) => ({ ...t, on })) } : c));
  }


  needsValue(test: TestChoice): boolean {
    return matchTestNeedsValue(test.operator);
  }

  isSoapAction(test: TestChoice): boolean {
    return test.kind === 'headers' && test.name.toLowerCase() === 'soapaction';
  }

  back(): void {
    this.source.set(null);
    this.choices.set(null);
  }

  apply(): void {
    const source = this.source();
    const choices = this.choices();
    if (!source || !choices) return;
    this.applied.emit({ fill: buildMatchFill(source, choices), source, label: `${source.method} ${source.host}${source.path}` });
  }

  /** "Now in rule" for one field, or "any" when empty. */
  now(field: 'direction' | 'project' | 'host' | 'path' | 'method'): string {
    const m = this.current();
    switch (field) {
      case 'direction':
        return m.source === 'both' ? 'any' : m.source;
      case 'project':
        return m.serviceNames.length ? m.serviceNames.join(', ') : 'any';
      case 'host':
        return m.host.trim() || 'any';
      case 'path':
        return [m.pathContains.trim() && `contains ${m.pathContains.trim()}`, m.pathRegex.trim() && `regex ${m.pathRegex.trim()}`].filter(Boolean).join(' · ') || 'any';
      case 'method':
        return m.methods.length ? m.methods.join(', ') : 'every method';
    }
  }
}
