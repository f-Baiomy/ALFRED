import { Component, DestroyRef, computed, effect, inject, input, output, signal, untracked } from '@angular/core';
import { Condition, RESPONSE_SUBJECTS } from '../../core/models/interception.model';
import { ReliveApiService } from '../../core/services/relive-api.service';
import { COMBINE_OPTIONS, ConditionOption, SUBJECT_OPTIONS } from '../../shared/utils/condition-edit';
import { PathEntry, asText, jsonPathIndex, parseJson, valuesAt } from '../../shared/utils/json-paths';
import { headerSuggestions } from '../../shared/utils/name-suggestions';
import {
  CheckGroup,
  CheckGroupResult,
  CheckOnMiss,
  StepChecks,
  defaultCheck,
  effectiveOnMiss,
  evaluationRequest,
  foundLine,
} from '../../shared/utils/relive-checks';
import { FrozenCall } from '../../shared/utils/relive-types';
import { ConditionRowComponent } from '../condition-row/condition-row.component';
import { SelectPickerComponent } from '../select-picker/select-picker.component';

const PREVIEW_DELAY_MS = 400;

/**
 * A step's "Check the response": groups of the rule editor's own condition rows (app-condition-row),
 * each joined all of / any of, each with what a miss means. Under every row, "On the recording"
 * shows how that condition fares on the step's recorded answer - evaluated by the proxy, with the
 * same code a run uses, refreshed shortly after each edit.
 */
@Component({
  selector: 'app-relive-checks-editor',
  standalone: true,
  imports: [ConditionRowComponent, SelectPickerComponent],
  templateUrl: './relive-checks-editor.component.html',
})
export class ReliveChecksEditorComponent {
  private readonly api = inject(ReliveApiService);

  readonly checks = input.required<StepChecks>();
  readonly recording = input.required<FrozenCall>();
  readonly checksChange = output<StepChecks>();

  readonly combineOptions = COMBINE_OPTIONS;
  readonly subjectOptions: readonly ConditionOption[] = SUBJECT_OPTIONS.filter((o) => RESPONSE_SUBJECTS.has(o.value as Condition['subject']));
  readonly defaultOptions: readonly ConditionOption[] = [
    { value: 'FAIL', label: '✗ Fail · stop the run' },
    { value: 'WARN', label: '⚠ Warn · continue' },
  ];
  readonly groupOptions = computed<readonly ConditionOption[]>(() => [
    { value: 'DEFAULT', label: `as default (${this.checks().onMiss === 'FAIL' ? 'fail' : 'warn'})` },
    ...this.defaultOptions,
  ]);

  readonly paths = computed<readonly PathEntry[] | null>(() => {
    const doc = parseJson(this.recording().responseBody);
    return doc === undefined ? null : jsonPathIndex(doc);
  });
  readonly headerNames = computed(() => headerSuggestions(this.recording().responseHeaders));

  /** The proxy's verdicts on the recording, per group - null while waiting or when it could not answer. */
  readonly preview = signal<readonly CheckGroupResult[] | null>(null);
  readonly previewError = signal<string | null>(null);

  constructor() {
    let timer: ReturnType<typeof setTimeout> | null = null;
    inject(DestroyRef).onDestroy(() => timer && clearTimeout(timer));
    effect(() => {
      const checks = this.checks();
      const recording = this.recording();
      if (timer) clearTimeout(timer);
      if (!checks.groups.some((g) => g.conditions.length)) {
        untracked(() => this.preview.set(null));
        return;
      }
      timer = setTimeout(() => this.refreshPreview(checks, recording), PREVIEW_DELAY_MS);
    }, { allowSignalWrites: true });
  }

  private refreshPreview(checks: StepChecks, recording: FrozenCall): void {
    const request = evaluationRequest(checks, { status: recording.status, headers: recording.responseHeaders, body: recording.responseBody ?? null }, recording.durationMs);
    this.api.evaluateChecks(request).subscribe({
      next: (answer) => {
        this.previewError.set(null);
        this.preview.set(answer.groups);
      },
      error: () => {
        this.preview.set(null);
        this.previewError.set('preview unavailable - the proxy did not answer');
      },
    });
  }

  rowPreview(gi: number, ci: number): { readonly holds: boolean; readonly text: string } | null {
    const row = this.preview()?.[gi]?.rows?.[ci];
    return row ? { holds: row.holds, text: foundLine(row) } : null;
  }

  valueHints(condition: Condition): readonly string[] {
    if (condition.subject !== 'RESPONSE_JSON_FIELD' || !condition.name) return [];
    const doc = parseJson(this.recording().responseBody);
    if (doc === undefined) return [];
    const values = valuesAt(doc, condition.name.trim());
    const items = values.length === 1 && Array.isArray(values[0]) ? (values[0] as unknown[]) : values;
    return [...new Set(items.filter((v) => v === null || typeof v !== 'object').map(asText))].slice(0, 20);
  }

  onMissOf(group: CheckGroup): CheckOnMiss {
    return effectiveOnMiss(this.checks(), group);
  }

  private emitGroups(groups: readonly CheckGroup[]): void {
    this.checksChange.emit({ ...this.checks(), groups });
  }

  private patchGroup(gi: number, change: (g: CheckGroup) => CheckGroup): void {
    this.emitGroups(this.checks().groups.map((g, i) => (i === gi ? change(g) : g)));
  }

  setDefault(onMiss: string): void {
    this.checksChange.emit({ ...this.checks(), onMiss: onMiss === 'WARN' ? 'WARN' : 'FAIL' });
  }

  setCombine(gi: number, combine: string): void {
    this.patchGroup(gi, (g) => ({ ...g, combine: combine === 'ANY' ? 'ANY' : 'ALL' }));
  }

  setGroupOnMiss(gi: number, onMiss: string): void {
    this.patchGroup(gi, (g) => ({ ...g, onMiss: onMiss as CheckGroup['onMiss'] }));
  }

  setCondition(gi: number, ci: number, condition: Condition): void {
    this.patchGroup(gi, (g) => ({ ...g, conditions: g.conditions.map((c, i) => (i === ci ? condition : c)) }));
  }

  removeCondition(gi: number, ci: number): void {
    const group = this.checks().groups[gi];
    if (group.conditions.length <= 1) {
      this.removeGroup(gi);
      return;
    }
    this.patchGroup(gi, (g) => ({ ...g, conditions: g.conditions.filter((_, i) => i !== ci) }));
  }

  addCondition(gi: number): void {
    this.patchGroup(gi, (g) => ({ ...g, conditions: [...g.conditions, defaultCheck()] }));
  }

  removeGroup(gi: number): void {
    this.emitGroups(this.checks().groups.filter((_, i) => i !== gi));
  }

  /** "＋ Add check": a group of one - a single check with its own fail / warn. */
  addGroup(combine: 'ALL' | 'ANY' = 'ALL'): void {
    this.emitGroups([...this.checks().groups, { combine, onMiss: 'DEFAULT', conditions: [defaultCheck()] }]);
  }
}
