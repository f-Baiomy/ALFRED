import { ACTION_LABELS, ActionType, RuleAction, actionPhase } from '../../core/models/interception.model';
import { SVG_ICON_NAMES } from '../components/svg-icon/svg-icon.component';
import {
  CATALOG,
  GOALS,
  COMMON,
  GROUPS,
  PickContext,
  RECIPES,
  blockedReason,
  fitsRule,
  pickItems,
  recentActions,
  recipeActions,
  rememberAction,
} from './action-catalog';

const ALL = Object.keys(ACTION_LABELS) as ActionType[];
const REQUEST = ALL.filter((t) => actionPhase(t) === 'request');
const top = (types: ActionType[] = [], bodyKind: PickContext['bodyKind'] = null): PickContext => ({ topLevel: true, topLevelTypes: types, bodyKind });

describe('action-catalog', () => {
  it('files every action type under a group of its own phase', () => {
    for (const type of ALL) {
      const entry = CATALOG[type];
      expect(entry).withContext(`${type} is missing from CATALOG`).toBeTruthy();
      const phase = actionPhase(type);
      if (phase === 'message') {
        expect(entry!.group).toBe('message');
        continue;
      }
      expect(GROUPS[phase].map((g) => g.id)).withContext(type).toContain(entry!.group);
      expect(entry!.hint.length).withContext(`${type} has no hint`).toBeGreaterThan(0);
    }
  });

  it('draws every group and goal with an icon that exists', () => {
    for (const group of [...GROUPS.request, ...GROUPS.response]) expect(SVG_ICON_NAMES).withContext(group.label).toContain(group.icon);
    for (const goal of GOALS) expect(SVG_ICON_NAMES).withContext(goal.label).toContain(goal.icon);
  });

  it('lists a phase in group order, narrowed by goal and by search over label, group and hint', () => {
    const all = pickItems('request', REQUEST, ACTION_LABELS, 'all', '');
    expect(all.length).toBe(REQUEST.length);
    const order = GROUPS.request.map((g) => g.id);
    const seen = all.map((i) => order.indexOf(i.group.id));
    expect(seen).toEqual([...seen].sort((a, b) => a - b));

    expect(pickItems('request', REQUEST, ACTION_LABELS, 'slow', '').map((i) => i.type)).toEqual(['DELAY_REQUEST', 'IF_REQUEST']);
    expect(pickItems('request', REQUEST, ACTION_LABELS, 'all', 'soap').map((i) => i.type)).toEqual(['REPLACE_IN_REQUEST_BODY']);
    expect(pickItems('request', REQUEST, ACTION_LABELS, 'all', 'cookie').every((i) => i.group.id === 'cookies' || i.entry.hint.toLowerCase().includes('cookie'))).toBeTrue();
    // Only what the list may hold: a branch that takes no conditionals does not list one.
    expect(pickItems('request', REQUEST.filter((t) => t !== 'IF_REQUEST'), ACTION_LABELS, 'all', 'if').some((i) => i.type === 'IF_REQUEST')).toBeFalse();
  });

  it('refuses the same three contradictions the editor warns about - at the top level only', () => {
    expect(blockedReason('MOCK_RESPONSE', top())).toBeNull();
    expect(blockedReason('SIMULATE_FAILURE', top(['MOCK_RESPONSE']))).toContain('already answers');
    expect(blockedReason('PAUSE_REQUEST', top(['MOCK_RESPONSE']))).toContain('before it could pause');
    expect(blockedReason('PAUSE_RESPONSE', top(['PAUSE_REQUEST']))).toContain('only be paused once');
    expect(blockedReason('MOCK_RESPONSE', top(['PAUSE_REQUEST']))).toContain('pause never happens');
    expect(blockedReason('SET_REQUEST_HEADER', top(['MOCK_RESPONSE']))).toBeNull();
    // Inside a branch an answer is exactly what a condition is for.
    expect(blockedReason('MOCK_RESPONSE', { ...top(['MOCK_RESPONSE']), topLevel: false })).toBeNull();
  });

  it('tags what suits the rule body', () => {
    expect(fitsRule('REPLACE_IN_REQUEST_BODY', top([], 'xml'))).toBeTrue();
    expect(fitsRule('SET_REQUEST_JSON_FIELD', top([], 'xml'))).toBeFalse();
    expect(fitsRule('SET_REQUEST_JSON_FIELD', top([], 'json'))).toBeTrue();
    expect(fitsRule('REPLACE_IN_REQUEST_BODY', top([], null))).toBeFalse();
  });

  it('builds a recipe over each action type defaults, skipping what the rule would refuse', () => {
    const defaults = (type: ActionType): RuleAction => ({ type, durationMs: 1, name: 'default' });
    const serverError = RECIPES.response.find((r) => r.id === 'server-error')!;
    expect(recipeActions(serverError, defaults, top())).toEqual([
      { type: 'SET_RESPONSE_STATUS', durationMs: 1, name: 'default', status: 503 },
      { type: 'SET_RESPONSE_HEADER', durationMs: 1, name: 'Retry-After', value: '30' },
    ]);
    const down = RECIPES.request.find((r) => r.id === 'supplier-down')!;
    expect(recipeActions(down, defaults, top(['MOCK_RESPONSE']))).toEqual([]);
  });

  it('only offers common chips of the phase they are for', () => {
    for (const phase of ['request', 'response'] as const) {
      for (const type of COMMON[phase]) expect(actionPhase(type)).toBe(phase);
      for (const recipe of RECIPES[phase]) for (const step of recipe.actions) expect(actionPhase(step.type)).toBe(phase);
    }
  });

  it('remembers the last four per phase, newest first, and survives bad storage', () => {
    const store = new Map<string, string>();
    const storage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) };
    for (const t of ['DELAY_REQUEST', 'SET_METHOD', 'REWRITE_URL', 'SET_QUERY_PARAM', 'DELAY_REQUEST', 'SET_REQUEST_COOKIE'] as ActionType[]) {
      rememberAction(t, 'request', storage);
    }
    rememberAction('DELAY_RESPONSE', 'response', storage);
    expect(recentActions('request', storage)).toEqual(['SET_REQUEST_COOKIE', 'DELAY_REQUEST', 'SET_QUERY_PARAM', 'REWRITE_URL']);
    expect(recentActions('response', storage)).toEqual(['DELAY_RESPONSE']);
    store.set('alfred_recent_actions', '{not json');
    expect(recentActions('request', storage)).toEqual([]);
  });
});
