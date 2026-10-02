import { Injectable, signal } from '@angular/core';
import { Observable, of } from 'rxjs';
import { InterceptionRule, InterceptionRuleDraft } from '../../core/models/interception.model';
import { RuleEditorTarget } from '../../components/rule-editor/rule-editor-target';

export type RuleEditorScope = 'CYCLE' | 'CALL' | 'UNEXPECTED';

/** Which rule is open, and how saving it should be applied back to the cycle draft. */
export interface ReliveRuleDialogRequest {
  readonly scope: RuleEditorScope;
  /** CALL: the step key whose callRule this is. CYCLE/UNEXPECTED: the rule's id, or null when new. */
  readonly targetKey: string | null;
  readonly rule: InterceptionRule | null;
}

/**
 * The rule editor opened from the Relive cycle page (research D14, modelled on
 * `RuleDialogService`) - a call's own call rule, a cycle rule, or an unexpected-call rule, all
 * through the same `RuleEditorComponent` with a `RULE_EDITOR_TARGET` that writes into THIS cycle's
 * draft instead of the global rules store. "Pick from anywhere" parks the same way the global
 * dialog does; its `returnUrl` is `/relive/:id`, so Return lands back on this same cycle page,
 * which reopens the editor from the picker's `resume` blob.
 */
@Injectable({ providedIn: 'root' })
export class ReliveRuleDialogService {
  readonly request = signal<ReliveRuleDialogRequest | null>(null);

  open(scope: RuleEditorScope, targetKey: string | null, rule: InterceptionRule | null): void {
    this.request.set({ scope, targetKey, rule });
  }

  close(): void {
    this.request.set(null);
  }

  /** A `RuleEditorTarget` that writes the saved draft back into the cycle via `apply`, then
   *  closes. `apply` is the cycle page's own mutator (`ReliveCycleEditorState.update`-shaped). */
  targetFor(apply: (scope: RuleEditorScope, targetKey: string | null, draft: InterceptionRuleDraft) => void): RuleEditorTarget {
    const req = this.request();
    return {
      pauseCarriesOn: true,
      save: (draft, ruleId): Observable<InterceptionRuleDraft | null> => {
        if (!req) return of(null);
        apply(req.scope, ruleId ?? req.targetKey, draft);
        this.close();
        return of(draft);
      },
    };
  }
}
