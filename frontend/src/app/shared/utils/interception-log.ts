import { Observable } from 'rxjs';
import { AppliedInterception, CallInterception, InterceptionRule, actionPhase } from '../../core/models/interception.model';

/**
 * Groups a call's `interception.applied` entries by consecutive run of the same rule (or "Manual
 * edit" for a hand-made breakpoint change) - shared by CallCardComponent's interception log and
 * CallWaterfallComponent's hover card, so the two never drift on how a rule's actions are grouped
 * or numbered. See docs/interception.md and CallCardComponent's own doc on why runs stay separate.
 */
export interface InterceptionLogGroup {
  readonly ruleId: string | null;
  readonly ruleName: string;
  readonly actions: readonly InterceptionLogAction[];
}

export interface InterceptionLogAction {
  readonly entry: AppliedInterception;
  readonly number: number;
  readonly label: string;
  readonly phase: string;
}

export function buildInterceptionLogGroups(interception: CallInterception | null | undefined): readonly InterceptionLogGroup[] {
  const groups: { ruleId: string | null; ruleName: string; actions: InterceptionLogAction[] }[] = [];
  for (const [index, entry] of (interception?.applied ?? []).entries()) {
    const ruleId = entry.ruleId ?? null;
    const ruleName = entry.ruleName || 'Manual edit';
    let group = groups[groups.length - 1];
    // Keep separate runs separate, so actions from different rules remain in execution order.
    if (!group || group.ruleId !== ruleId || group.ruleName !== ruleName) {
      group = { ruleId, ruleName, actions: [] };
      groups.push(group);
    }
    group.actions.push({
      entry,
      number: index + 1,
      label: friendlyInterceptionAction(entry.action),
      phase: actionPhase(entry.action) === 'response' ? 'Response' : actionPhase(entry.action) === 'message' ? 'Message' : 'Request',
    });
  }
  return groups;
}

export function friendlyInterceptionAction(action: string): string {
  if (action.startsWith('CAPTURE_')) return 'Captured variable';
  if (action.startsWith('SET_') && action.includes('JSON_FIELD')) return 'Set JSON field';
  if (action.startsWith('DELAY_')) return 'Waited';
  return action.toLowerCase().replaceAll('_', ' ').replace(/^./, (letter) => letter.toUpperCase());
}

/**
 * A GLOBAL capture's detail ends with ` -> {{name}}` (contracts.md §5) - the variable a rule
 * promoted this call's value into. Parsed here so the log can render it as a link into
 * GlobalVariablesService.focusVariable(name) rather than dead text, without the frontend re-deriving
 * the wire format's own regex (`-> {{([^}]+)}}$`) in more than one place.
 */
export interface ParsedCaptureLink {
  readonly prefix: string;
  readonly name: string;
}

const CAPTURE_LINK_PATTERN = /^(.*)\s->\s\{\{([^{}]+)\}\}$/s;

export function parseCaptureLink(detail: string | null | undefined): ParsedCaptureLink | null {
  if (!detail) return null;
  const match = CAPTURE_LINK_PATTERN.exec(detail);
  if (!match) return null;
  return { prefix: match[1], name: match[2] };
}

/** DELAY_REQUEST/DELAY_RESPONSE detail is like "1500 ms" (contracts.md's proxy delay wording) -
 * parsed once here so the waterfall's injected-delay segment and its label agree on the same number. */
export function parseDelayMs(detail: string | null | undefined): number | null {
  if (!detail) return null;
  const match = /(\d+(?:\.\d+)?)\s*ms/i.exec(detail);
  if (!match) return null;
  const ms = Number(match[1]);
  return Number.isFinite(ms) && ms > 0 ? ms : null;
}

/** Minimal surface this needs from InterceptionApiService/RuleDialogService - kept narrow so a
 * caller doesn't have to inject the concrete classes just to satisfy this helper's types. */
export interface RuleLookup {
  listRules(): Observable<readonly InterceptionRule[]>;
}
export interface RuleOpener {
  openRule(rule: InterceptionRule): void;
}

/**
 * "Edit rule ↗" / "Open rule" on an applied-interception entry - looks the rule up (it may have
 * been deleted or edited since) and opens it in the popup editor, or reports why not. Shared by
 * CallCardComponent's interception log and CallWaterfallComponent's hover card so the two success/
 * failure paths (rule gone, fetch failed) can't drift apart.
 */
export function openInterceptionRule(
  api: RuleLookup,
  dialog: RuleOpener,
  ruleId: string,
  callbacks: { readonly onError: (message: string) => void; readonly onDone: () => void }
): void {
  api.listRules().subscribe({
    next: (rules) => {
      callbacks.onDone();
      const rule = rules.find((item) => item.id === ruleId);
      if (rule) dialog.openRule(rule);
      else callbacks.onError('This rule no longer exists.');
    },
    error: () => {
      callbacks.onDone();
      callbacks.onError('Could not load the rule. Try again.');
    },
  });
}
