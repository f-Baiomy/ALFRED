import { InjectionToken } from '@angular/core';
import { Observable } from 'rxjs';
import { InterceptionRule, InterceptionRuleDraft } from '../../core/models/interception.model';
import { InterceptionStateService } from '../../core/state/interception-state.service';

/**
 * Where a saved rule actually goes (research D14). The rule editor's own `save()` no longer calls
 * `InterceptionStateService` directly - it calls this token, so a host other than Interception
 * (Relive's call/cycle/unexpected-call rules) can save into its own draft instead, using the exact
 * same component, every action, condition, recipe and helper it offers there - never a copy
 * (FR-029a). Only the save target and the `scope` input differ; nothing about how a rule is built
 * changes.
 *
 * No `providedIn` default: injected with `{optional: true}` in `RuleEditorComponent`, falling back
 * to `defaultRuleEditorTarget` (today's Interception behaviour) when nothing provided it - so
 * neither existing host (Interception, the rule dialog) needs a provider added for this to work
 * unchanged, and a new host (Relive) opts in by providing it at its own injector.
 */
export interface RuleEditorTarget {
  /** `null` result means the caller rejected it (validation problems) - the editor stays open. */
  save(draft: InterceptionRuleDraft, ruleId: string | null): Observable<InterceptionRule | InterceptionRuleDraft | null>;
  /** Releasing a pause carries on with the rest of the rule (a Relive call rule), so a pause and a
   *  mock in one rule do not contradict each other. */
  readonly pauseCarriesOn?: boolean;
}

export const RULE_EDITOR_TARGET = new InjectionToken<RuleEditorTarget>('RULE_EDITOR_TARGET');

/** Today's behaviour: save through InterceptionStateService.createRule/updateRule. */
export function defaultRuleEditorTarget(state: InterceptionStateService): RuleEditorTarget {
  return {
    save: (draft, ruleId) => (ruleId ? state.updateRule(ruleId, draft) : state.createRule(draft)),
  };
}
