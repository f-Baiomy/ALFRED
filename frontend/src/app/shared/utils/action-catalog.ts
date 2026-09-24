import { ActionPhase, ActionType, RuleAction, isTerminalAction } from '../../core/models/interception.model';

/**
 * How the rule editor's "Add action" picker files every action: the group it sits under, the goals
 * ("make it slow", "make it fail"…) it serves and a one-line hint (the chip's tooltip; its ⓘ
 * shows the full help from interception-help.ts). Plus the
 * recipes (several actions in one click) and the one place that says when an action cannot be
 * added and why. Pure - the picker draws it, the editor inserts what it returns.
 *
 * Every ActionType the backend offers must be in CATALOG (the spec enforces it), so a new action
 * lands in a group rather than silently missing from the menu.
 */

export type ActionGoal = 'slow' | 'fail' | 'fake' | 'change' | 'redirect' | 'inspect';

export interface ActionGroup {
  readonly id: string;
  readonly label: string;
  /** An SvgIconComponent name. */
  readonly icon: string;
}

export const GROUPS: Readonly<Record<'request' | 'response', readonly ActionGroup[]>> = {
  request: [
    { id: 'timing', label: 'Timing', icon: 'clock' },
    { id: 'headers', label: 'Headers & trailers', icon: 'list' },
    { id: 'url', label: 'URL & method', icon: 'link' },
    { id: 'body', label: 'Body', icon: 'braces' },
    { id: 'cookies', label: 'Cookies', icon: 'cookie' },
    { id: 'transport', label: 'Transport', icon: 'bolt' },
    { id: 'answer', label: 'Answer instead of the host', icon: 'reply' },
    { id: 'control', label: 'Control', icon: 'branch' },
  ],
  response: [
    { id: 'timing', label: 'Timing', icon: 'clock' },
    { id: 'status', label: 'Status & headers', icon: 'list' },
    { id: 'body', label: 'Body', icon: 'braces' },
    { id: 'cookies', label: 'Cookies', icon: 'cookie' },
    { id: 'replace', label: 'Replace the whole response', icon: 'swap' },
    { id: 'control', label: 'Control', icon: 'branch' },
  ],
};

export const GOALS: readonly { readonly id: ActionGoal | 'all'; readonly label: string; readonly icon: string }[] = [
  { id: 'all', label: 'All', icon: 'grid' },
  { id: 'slow', label: 'Make it slow', icon: 'hourglass' },
  { id: 'fail', label: 'Make it fail', icon: 'alert' },
  { id: 'fake', label: 'Fake the answer', icon: 'bubble' },
  { id: 'change', label: 'Change it', icon: 'pencil' },
  { id: 'redirect', label: 'Send it elsewhere', icon: 'fork' },
  { id: 'inspect', label: 'Stop and inspect', icon: 'pause' },
];

export interface CatalogEntry {
  readonly group: string;
  readonly goals: readonly ActionGoal[];
  readonly hint: string;
  /** Suggested when the rule's calls carry a body of this kind. */
  readonly fits?: 'json' | 'xml' | 'any-body';
}

export const CATALOG: Readonly<Partial<Record<ActionType, CatalogEntry>>> = {
  DELAY_REQUEST: { group: 'timing', goals: ['slow'], hint: 'Hold the call before it goes out.' },
  SET_REQUEST_HEADER: { group: 'headers', goals: ['change'], hint: 'Add or overwrite one header.' },
  REMOVE_REQUEST_HEADER: { group: 'headers', goals: ['change', 'fail'], hint: 'Strip one header.' },
  SET_REQUEST_TRAILER: { group: 'headers', goals: ['change'], hint: 'A trailer, sent after the body.' },
  REMOVE_REQUEST_TRAILER: { group: 'headers', goals: ['change'], hint: 'Strip one trailer.' },
  REWRITE_URL: { group: 'url', goals: ['redirect'], hint: 'Send the call somewhere else.' },
  SET_METHOD: { group: 'url', goals: ['change'], hint: 'Change the verb.' },
  SET_QUERY_PARAM: { group: 'url', goals: ['change'], hint: 'Add or overwrite one query parameter.' },
  REMOVE_QUERY_PARAM: { group: 'url', goals: ['change'], hint: 'Strip one query parameter.' },
  SET_REQUEST_JSON_FIELD: { group: 'body', goals: ['change'], hint: 'Change one value in a JSON body, by path.', fits: 'json' },
  REMOVE_REQUEST_JSON_FIELD: { group: 'body', goals: ['change'], hint: 'Delete one value from a JSON body.', fits: 'json' },
  REPLACE_IN_REQUEST_BODY: {
    group: 'body',
    goals: ['change'],
    hint: 'Text or regex - works on any body, XML and SOAP included. Try it on a call.',
    fits: 'any-body',
  },
  SET_REQUEST_BODY: { group: 'body', goals: ['change'], hint: 'A whole new body - or copy one from a call.', fits: 'xml' },
  SET_FORM_FIELD: { group: 'body', goals: ['change'], hint: 'One field of a form-encoded body.' },
  REMOVE_FORM_FIELD: { group: 'body', goals: ['change'], hint: 'Strip one form field.' },
  SET_REQUEST_COOKIE: { group: 'cookies', goals: ['change'], hint: 'Add or overwrite one cookie.' },
  REMOVE_REQUEST_COOKIE: { group: 'cookies', goals: ['change', 'fail'], hint: 'Strip one cookie - e.g. log the caller out.' },
  DISABLE_CACHE: { group: 'transport', goals: ['change'], hint: 'Strip the conditional headers, so the host always sends the full response.' },
  DISABLE_COMPRESSION: { group: 'transport', goals: ['change'], hint: 'Ask for an uncompressed answer - readable bodies in the log.' },
  MOCK_RESPONSE: { group: 'answer', goals: ['fake', 'fail'], hint: 'Answer yourself; the host is never contacted.' },
  ANSWER_WITH_RECORDED_CALL: { group: 'answer', goals: ['fake'], hint: "Replay a logged call's response." },
  ANSWER_WITH_FILE: { group: 'answer', goals: ['fake'], hint: 'Serve an uploaded file as the answer.' },
  SIMULATE_FAILURE: {
    group: 'answer',
    goals: ['fail'],
    hint: 'A network failure, not a status: reset, hang, empty reply, gateway error.',
  },
  ABORT_REQUEST: { group: 'answer', goals: ['fail'], hint: 'Kill the connection.' },
  PAUSE_REQUEST: { group: 'control', goals: ['inspect'], hint: 'A breakpoint: see and edit the call live, then let it go.' },
  SEND_TO_HOST: { group: 'control', goals: ['change'], hint: 'Forward now - the response lane runs on the answer.' },
  IF_REQUEST: {
    group: 'control',
    goals: ['change', 'fail', 'fake', 'slow'],
    hint: 'If / else on a header, the body, the query… - different actions per case.',
  },
  DELAY_RESPONSE: { group: 'timing', goals: ['slow'], hint: 'Hold the answer before the caller gets it.' },
  SET_RESPONSE_STATUS: { group: 'status', goals: ['fail', 'change'], hint: 'Change the status code; the body stays.' },
  SET_RESPONSE_HEADER: { group: 'status', goals: ['change'], hint: 'Add or overwrite one header.' },
  REMOVE_RESPONSE_HEADER: { group: 'status', goals: ['change'], hint: 'Strip one header.' },
  SET_RESPONSE_TRAILER: { group: 'status', goals: ['change'], hint: 'A trailer, sent after the body.' },
  REMOVE_RESPONSE_TRAILER: { group: 'status', goals: ['change'], hint: 'Strip one trailer.' },
  SET_RESPONSE_ENCODING: { group: 'status', goals: ['change'], hint: 'Re-encode the body.' },
  SET_RESPONSE_JSON_FIELD: { group: 'body', goals: ['change'], hint: 'Change one value in a JSON body, by path.', fits: 'json' },
  REMOVE_RESPONSE_JSON_FIELD: { group: 'body', goals: ['change'], hint: 'Delete one value from a JSON body.', fits: 'json' },
  REPLACE_IN_RESPONSE_BODY: {
    group: 'body',
    goals: ['change', 'fail'],
    hint: 'Text or regex - works on any body, XML and SOAP included. Try it on a call.',
    fits: 'any-body',
  },
  SET_RESPONSE_BODY: { group: 'body', goals: ['change', 'fake'], hint: 'A whole new body - or copy one from a call.', fits: 'xml' },
  SET_RESPONSE_COOKIE: { group: 'cookies', goals: ['change'], hint: 'Set a cookie - by default one that expires a session.' },
  REMOVE_RESPONSE_COOKIE: { group: 'cookies', goals: ['change'], hint: 'Strip one Set-Cookie.' },
  REPLACE_RESPONSE: { group: 'replace', goals: ['fake', 'fail'], hint: 'Status, headers and body of your own - the host was still called.' },
  REPLACE_WITH_RECORDED_RESPONSE: { group: 'replace', goals: ['fake'], hint: "A logged call's response instead of the real one." },
  PAUSE_RESPONSE: { group: 'control', goals: ['inspect'], hint: 'A breakpoint after the supplier answers: edit the reply live.' },
  IF_RESPONSE: {
    group: 'control',
    goals: ['change', 'fail', 'fake', 'slow'],
    hint: 'If / else on the status, a header, the body…',
  },
  REPLACE_IN_MESSAGE: { group: 'message', goals: ['change'], hint: 'Text or regex in each WebSocket message.' },
  DROP_MESSAGE: { group: 'message', goals: ['fail'], hint: 'Drop matching messages.' },
  DELAY_MESSAGE: { group: 'message', goals: ['slow'], hint: 'Hold each message.' },
};

/** Shown beside "Add action" until the user has a history of their own. */
export const COMMON: Readonly<Record<'request' | 'response', readonly ActionType[]>> = {
  request: ['DELAY_REQUEST', 'SET_REQUEST_HEADER', 'MOCK_RESPONSE', 'REPLACE_IN_REQUEST_BODY'],
  response: ['SET_RESPONSE_STATUS', 'DELAY_RESPONSE', 'SET_RESPONSE_JSON_FIELD', 'REPLACE_IN_RESPONSE_BODY'],
};

export interface Recipe {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  /** Merged over the action's own defaults, in order. */
  readonly actions: readonly ({ readonly type: ActionType } & Partial<RuleAction>)[];
}

export const RECIPES: Readonly<Record<'request' | 'response', readonly Recipe[]>> = {
  request: [
    {
      id: 'timeout',
      label: 'Timeout',
      description: 'Hold the call until the caller gives up.',
      actions: [{ type: 'SIMULATE_FAILURE', failure: 'HANG_UNTIL_CALLER_GIVES_UP' }],
    },
    {
      id: 'supplier-down',
      label: 'Supplier down',
      description: 'Answer 503 with Retry-After - the host is never contacted.',
      actions: [{ type: 'MOCK_RESPONSE', status: 503, headers: { 'Content-Type': 'application/json', 'Retry-After': '30' }, body: '{"error":"Service unavailable"}' }],
    },
    {
      id: 'swap-currency',
      label: 'Swap currency',
      description: 'Find & replace EUR with USD in the request body.',
      actions: [{ type: 'REPLACE_IN_REQUEST_BODY', pattern: 'EUR', replacement: 'USD' }],
    },
  ],
  response: [
    {
      id: 'server-error',
      label: 'Server error',
      description: 'Status 503 plus a Retry-After header.',
      actions: [
        { type: 'SET_RESPONSE_STATUS', status: 503 },
        { type: 'SET_RESPONSE_HEADER', name: 'Retry-After', value: '30' },
      ],
    },
    {
      id: 'slow-answer',
      label: 'Slow answer',
      description: 'Hold the answer 10 seconds.',
      actions: [{ type: 'DELAY_RESPONSE', durationMs: 10000 }],
    },
    {
      id: 'zero-price',
      label: 'Zero the price',
      description: 'Set the JSON field price to 0.',
      actions: [{ type: 'SET_RESPONSE_JSON_FIELD', path: 'price', value: 0 }],
    },
  ],
};

/** What the picker needs to know about the rule to grey out, and to suggest. */
export interface PickContext {
  /** Adding at the top level of the rule (not inside a condition's branch). */
  readonly topLevel: boolean;
  /** Top-level action types already in the rule. */
  readonly topLevelTypes: readonly ActionType[];
  /** 'json' / 'xml' when the rule's calls are known to carry that body, else null. */
  readonly bodyKind: 'json' | 'xml' | null;
}

const PAUSES = new Set<ActionType>(['PAUSE_REQUEST', 'PAUSE_RESPONSE']);

/**
 * Why `type` cannot be added here, or null. The same three contradictions the editor's
 * conflictHint reports after the fact - said up front instead. Only at the top level: inside a
 * branch, an answer or a pause is exactly what a condition is for.
 */
export function blockedReason(type: ActionType, context: PickContext): string | null {
  if (!context.topLevel) return null;
  const terminal = context.topLevelTypes.some((t) => isTerminalAction(t));
  const paused = context.topLevelTypes.some((t) => PAUSES.has(t));
  if (isTerminalAction(type) && terminal) return 'The rule already answers the call - a second answer would never run.';
  if (PAUSES.has(type) && paused) return 'A call can only be paused once.';
  if (PAUSES.has(type) && terminal) return 'The rule answers the call before it could pause.';
  if (isTerminalAction(type) && paused) return 'The rule pauses the call - answering it here means the pause never happens.';
  return null;
}

/** Whether `type` suits the rule's body - "fits this rule". */
export function fitsRule(type: ActionType, context: PickContext): boolean {
  const fits = CATALOG[type]?.fits;
  if (!fits || !context.bodyKind) return false;
  return fits === 'any-body' || fits === context.bodyKind;
}

export interface PickItem {
  readonly type: ActionType;
  readonly group: ActionGroup;
  readonly entry: CatalogEntry;
}

/** The phase's actions filtered by goal and search, in group order - what the picker lists. */
export function pickItems(
  phase: 'request' | 'response',
  types: readonly ActionType[],
  labels: Readonly<Record<ActionType, string>>,
  goal: ActionGoal | 'all',
  query: string
): PickItem[] {
  const q = query.trim().toLowerCase();
  const offered = new Set(types);
  const out: PickItem[] = [];
  for (const group of GROUPS[phase]) {
    for (const [type, entry] of Object.entries(CATALOG) as [ActionType, CatalogEntry][]) {
      if (entry.group !== group.id || !offered.has(type)) continue;
      if (goal !== 'all' && !entry.goals.includes(goal)) continue;
      if (q && !`${labels[type]} ${group.label} ${entry.hint}`.toLowerCase().includes(q)) continue;
      out.push({ type, group, entry });
    }
  }
  // A type the catalog has not filed yet still shows, under its phase's last group, rather than vanish.
  for (const type of types) {
    if (CATALOG[type] || out.some((i) => i.type === type)) continue;
    if (q && !labels[type]?.toLowerCase().includes(q)) continue;
    if (goal !== 'all') continue;
    const groups = GROUPS[phase];
    out.push({ type, group: groups[groups.length - 1], entry: { group: groups[groups.length - 1].id, goals: [], hint: '' } });
  }
  return out;
}

/** The recipe's actions over each type's defaults, dropping any the rule would refuse here. */
export function recipeActions(recipe: Recipe, defaults: (type: ActionType) => RuleAction, context: PickContext): RuleAction[] {
  const out: RuleAction[] = [];
  const types = [...context.topLevelTypes];
  for (const step of recipe.actions) {
    if (blockedReason(step.type, { ...context, topLevelTypes: types })) continue;
    out.push({ ...defaults(step.type), ...step } as RuleAction);
    if (context.topLevel) types.push(step.type);
  }
  return out;
}

const RECENT_KEY = 'alfred_recent_actions';

/** The last few action types added in this browser, per phase - newest first. */
export function recentActions(phase: ActionPhase, storage: Pick<Storage, 'getItem'> = localStorage): ActionType[] {
  try {
    const all = JSON.parse(storage.getItem(RECENT_KEY) ?? '{}') as Record<string, ActionType[]>;
    return Array.isArray(all[phase]) ? all[phase].slice(0, 4) : [];
  } catch {
    return [];
  }
}

export function rememberAction(type: ActionType, phase: ActionPhase, storage: Pick<Storage, 'getItem' | 'setItem'> = localStorage): void {
  try {
    const all = JSON.parse(storage.getItem(RECENT_KEY) ?? '{}') as Record<string, ActionType[]>;
    all[phase] = [type, ...(all[phase] ?? []).filter((t) => t !== type)].slice(0, 4);
    storage.setItem(RECENT_KEY, JSON.stringify(all));
  } catch {
    // Storage full or disabled - recent chips are a convenience, not state.
  }
}
