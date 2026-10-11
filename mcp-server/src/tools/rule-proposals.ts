import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { seg, type AlfredClient, type RequestOptions } from '../alfred-client.ts';
import { segmentOf } from '../cycle-calls.ts';
import { toCallRecord, type CallRecord, type CallSummaryDto } from '../frontend.ts';
import { fitItems, invalid, ok, run } from '../reply.ts';
import { resolveCall } from './calls.ts';

/**
 * Claude PROPOSES interception rules (docs/interception.md "Rules from Claude"). A rule from here is saved switched off,
 * must be narrow (a host or project AND a path) and never pauses calls; switching it on - for good or "on for 30 min" -
 * editing, deleting and the master switch are the user's, and the backend refuses them to Claude whatever is asked
 * (ClaudeRulesGuard). The tools help Claude make a rule that is right the first time: recipes instead of raw action
 * JSON, a draft from a logged call, a preview against recent calls, and the hits once the user switched it on.
 */
const AS_CLAUDE: Pick<RequestOptions, 'headers'> = { headers: { 'X-Alfred-Actor': 'claude' } };
const PREVIEW_CALLS = 300;

export const Match = z.object({
  source: z.enum(['outbound', 'inbound']).describe('outbound = calls to suppliers; inbound = calls into a project'),
  projects: z.array(z.string().min(1)).max(10).default([]).describe('Project names (inbound), or the project making the outbound call'),
  host: z.string().max(300).optional().describe('Exact host, or *.example.com'),
  methods: z.array(z.string().min(1).max(10)).max(10).default([]),
  pathContains: z.string().max(500).optional(),
  pathRegex: z.string().max(500).optional(),
});
export type MatchInput = z.infer<typeof Match>;

export const Recipe = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('status'), status: z.number().int().min(100).max(599), body: z.string().max(64 * 1024).optional(),
    contentType: z.string().max(100).optional() }).describe('Answer at once with this status (and body) - the real host is never called'),
  z.object({ kind: z.literal('status_after'), status: z.number().int().min(100).max(599) })
    .describe('Let the real call happen, then change its status'),
  z.object({ kind: z.literal('slow'), ms: z.number().int().min(1).max(120_000) }).describe('Delay the call by ms'),
  z.object({ kind: z.literal('failure'), failure: z.string().min(1), ms: z.number().int().min(0).max(120_000).optional() })
    .describe('A network failure: rule_recipes lists the failures (e.g. CONNECTION_RESET, HANG_THEN_DROP with ms)'),
  z.object({ kind: z.literal('empty_body') }).describe('The real response, with an empty body'),
  z.object({ kind: z.literal('malformed_json') }).describe('The real response, with a body that is not valid JSON'),
  z.object({ kind: z.literal('drop_field'), path: z.string().min(1).max(300) }).describe('Remove a JSON field from the real response ($.offers[0].price)'),
  z.object({ kind: z.literal('field_value'), path: z.string().min(1).max(300), value: z.unknown() })
    .describe('Set a JSON field of the real response to a wrong value'),
  z.object({ kind: z.literal('recorded'), callId: z.string().min(1), direction: z.enum(['outbound', 'inbound']) })
    .describe('Answer with what a logged call answered (its secrets are stripped)'),
]);
export type RecipeInput = z.infer<typeof Recipe>;

type ActionRow = Record<string, unknown>;

/** The rule's actions for a recipe; a recorded answer needs its stored answer id, made by the caller first. */
export function recipeActions(recipe: RecipeInput, answerId?: string): ActionRow[] {
  switch (recipe.kind) {
    case 'status': return [{ type: 'MOCK_RESPONSE', status: recipe.status, body: recipe.body ?? '', ...(recipe.contentType ? { contentType: recipe.contentType } : {}) }];
    case 'status_after': return [{ type: 'SET_RESPONSE_STATUS', status: recipe.status }];
    case 'slow': return [{ type: 'DELAY_REQUEST', durationMs: recipe.ms }];
    case 'failure': return [{ type: 'SIMULATE_FAILURE', failure: recipe.failure, ...(recipe.ms !== undefined ? { durationMs: recipe.ms } : {}) }];
    case 'empty_body': return [{ type: 'SET_RESPONSE_BODY', body: '' }];
    case 'malformed_json': return [{ type: 'SET_RESPONSE_BODY', body: '{"alfred": "malformed', contentType: 'application/json' }];
    case 'drop_field': return [{ type: 'REMOVE_RESPONSE_JSON_FIELD', path: recipe.path }];
    case 'field_value': return [{ type: 'SET_RESPONSE_JSON_FIELD', path: recipe.path, value: recipe.value }];
    case 'recorded': return [{ type: 'ANSWER_WITH_RECORDED_CALL', answerId }];
  }
}

/** The backend's RuleMatch for the tool's match. */
export function ruleMatch(m: MatchInput): Record<string, unknown> {
  return {
    source: m.source, serviceNames: m.projects, methods: m.methods.map((x) => x.toUpperCase()),
    ...(m.host ? { host: m.host } : {}), ...(m.pathContains ? { pathContains: m.pathContains } : {}), ...(m.pathRegex ? { pathRegex: m.pathRegex } : {}),
  };
}

/** A draft that matches this call: its direction, project, method, host and path (without the query). */
export function draftFromCall(call: CallRecord): { name: string; match: MatchInput } {
  const url = safeUrl(call.url);
  const path = url?.pathname ?? call.url;
  const source = call.source === 'internal' ? 'inbound' : 'outbound';
  return {
    name: `${call.method} ${url?.host ?? ''}${path}`.trim().slice(0, 120),
    match: {
      source, projects: call.service_name ? [call.service_name] : [], methods: [call.method],
      ...(source === 'outbound' && url?.host ? { host: url.host } : {}), pathContains: path,
    },
  };
}

/**
 * Which of these calls the match would catch - the same cheap checks the proxy makes first (direction, project, method,
 * host, path). Header, query, cookie and body tests are not part of a proposal's match, so nothing is left unchecked.
 */
export function previewMatch(m: MatchInput, calls: readonly CallRecord[]): CallRecord[] {
  const regex = m.pathRegex ? new RegExp(m.pathRegex) : null;
  const methods = new Set(m.methods.map((x) => x.toUpperCase()));
  return calls.filter((call) => {
    if ((m.source === 'inbound') !== (call.source === 'internal')) return false;
    if (m.projects.length && !m.projects.includes(call.service_name ?? '')) return false;
    if (methods.size && !methods.has(call.method.toUpperCase())) return false;
    const url = safeUrl(call.url);
    if (m.host && !hostMatches(m.host, url?.host ?? '')) return false;
    const pathAndQuery = url ? url.pathname + url.search : call.url;
    if (m.pathContains && !pathAndQuery.includes(m.pathContains)) return false;
    if (regex && !regex.test(pathAndQuery)) return false;
    return true;
  });
}

function hostMatches(pattern: string, host: string): boolean {
  const p = pattern.toLowerCase();
  const h = host.toLowerCase().replace(/:\d+$/, '');
  return p.startsWith('*.') ? h.endsWith(p.slice(1)) : h === p;
}

function safeUrl(text: string): URL | null {
  try {
    return new URL(text, 'http://inbound.local');
  } catch {
    return null;
  }
}

function narrowProblems(m: MatchInput): string[] {
  const problems: string[] = [];
  if (!m.host && !m.projects.length) problems.push('name a host or a project - a rule may not catch all traffic');
  if (!m.pathContains && !m.pathRegex) problems.push('name a path (pathContains or pathRegex)');
  return problems;
}

async function recentCalls(client: AlfredClient, source: 'outbound' | 'inbound'): Promise<CallRecord[]> {
  const endpoint = source === 'inbound' ? 'internal' : 'external';
  const page = await client.get<{ calls: CallSummaryDto[] }>(`/${segmentOf(endpoint)}`, { query: { sort: 'newest-call', offset: 0, limit: PREVIEW_CALLS } });
  return page.calls.map((dto) => toCallRecord(dto, endpoint));
}

function callLine(c: CallRecord): string {
  return `${c.method} ${c.url} · ${c.response?.status ?? c.state ?? '?'}${c.service_name ? ` (${c.service_name})` : ''} · ${c.timestamp} · id ${c.id}`;
}

interface RuleRow { id: string; name: string; enabled: boolean; description?: string | null; origin?: { createdBy: string; card?: string | null; proposed: boolean } | null;
  expiresAt?: string | null }

export function register(server: McpServer, client: AlfredClient): void {
  server.registerTool('rule_recipes', {
    description: 'How to say what a proposed interception rule does: the recipes create_rule takes (status, status_after, slow, failure, '
      + 'empty_body, malformed_json, drop_field, field_value, recorded), the network failures Alfred can reproduce, and the rules for '
      + 'Claude\'s rules: saved OFF for the user to switch on, narrow (a host or project AND a path), never pausing calls.',
    inputSchema: {},
  }, () => run(async () => {
    const failures = await client.get<unknown>('/interception/failure-modes').catch(() => null);
    return ok({
      recipes: Recipe.options.map((o) => `${o.shape.kind.value}: ${o.description ?? ''} - fields ${Object.keys(o.shape).filter((k) => k !== 'kind').join(', ') || 'none'}`),
      failures,
      yourLimits: 'You only propose: the rule is saved off; the user switches it on (optionally for N minutes), edits or deletes it. '
        + 'Never tell the user a rule is on - check list_rules. Paused calls are not available to you.',
    });
  }));

  server.registerTool('rule_from_call', {
    description: 'A draft rule match from a logged call - its direction, project, method, host and path - to pass to rule_preview and create_rule. '
      + 'Nothing is created.',
    inputSchema: { callId: z.string().min(1), direction: z.enum(['inbound', 'outbound']).optional(), cycleId: z.string().optional() },
  }, (input) => run(async () => {
    const { call } = await resolveCall(client, input.callId, input.direction, input.cycleId);
    return ok({ ...draftFromCall(call), next: 'rule_preview with this match, then create_rule with a recipe and your reason' });
  }));

  server.registerTool('rule_preview', {
    description: `Which of the last ${PREVIEW_CALLS} calls a proposed match would catch, before you create the rule: a count and examples. `
      + 'Too many (it catches flows the test is not about) or none (wrong host/path) means fix the match first.',
    inputSchema: { match: Match },
  }, (input) => run(async () => {
    const problems = narrowProblems(input.match);
    if (problems.length) throw invalid(`Not narrow enough: ${problems.join('; ')}.`);
    if (input.match.pathRegex) {
      try { new RegExp(input.match.pathRegex); } catch (e) { throw invalid(`pathRegex does not compile: ${(e as Error).message}`); }
    }
    const calls = await recentCalls(client, input.match.source);
    const hits = previewMatch(input.match, calls);
    const fitted = fitItems(hits.slice(0, 20).map(callLine), 300);
    return ok({ scanned: calls.length, matches: hits.length, examples: fitted.items,
      ...(hits.length === 0 ? { hint: 'No recent call matches - check host, path and method against rule_from_call.' } : {}) });
  }));

  server.registerTool('create_rule', {
    description: 'Propose an interception rule: it is saved SWITCHED OFF in Interception under "Proposed by Claude" for the user to switch '
      + 'on (they may pick "on for N min"), edit or dismiss - you cannot switch it on, edit or delete it. Use it to reproduce a bug (a supplier '
      + 'failing, slow or answering wrong) or to check that a fix handles the failure. Give a recipe (rule_recipes), a narrow match '
      + '(rule_from_call / rule_preview) and the reason; with card, the card gets an @[rule:...] link and a comment asking the user to '
      + 'switch it on. After the user switches it on, rule_hits shows what it did.',
    inputSchema: {
      name: z.string().min(1).max(120),
      match: Match,
      recipe: Recipe,
      reason: z.string().min(1).max(2000).describe('Why the rule exists - shown to the user on the rule'),
      card: z.object({ project: z.string().default(''), number: z.number().int().min(1) }).optional().describe('The board card it reproduces'),
    },
  }, (input) => run(async () => {
    const problems = narrowProblems(input.match);
    if (problems.length) throw invalid(`Not narrow enough: ${problems.join('; ')}.`);
    let answerId: string | undefined;
    if (input.recipe.kind === 'recorded') {
      const answer = await client.post<{ id: string }>('/interception/answers/from-call', { ...AS_CLAUDE,
        body: { direction: input.recipe.direction, callId: input.recipe.callId, keepSecrets: false } });
      answerId = answer.id;
    }
    const cardRef = input.card ? `${input.card.project}#${input.card.number}` : undefined;
    const rule = await client.post<RuleRow>('/interception/rules', { ...AS_CLAUDE, body: {
      name: input.name, description: input.reason, enabled: false, match: ruleMatch(input.match),
      actions: recipeActions(input.recipe, answerId), reason: input.reason, card: cardRef,
    } });
    let linked: string | undefined;
    if (input.card) {
      const card = await client.get<{ id: string; number: number }>(`/board/cards/by-number/${seg(input.card.number)}`,
        { query: { project: input.card.project }, notFound: `No card #${input.card.number} on the ${input.card.project || 'No project'} board.` });
      const mention = `@[rule:${rule.id}|${rule.name}]`;
      await client.post(`/board/cards/${seg(card.id)}/links`, { ...AS_CLAUDE, body: { type: 'rule', ref: rule.id, label: rule.name } });
      await client.post(`/board/cards/${seg(card.id)}/comments`, { ...AS_CLAUDE, body: { reply:
        `Proposed interception rule ${mention} (off) - ${input.reason}. To reproduce: switch it on in Interception (or "on for 30 min"), `
        + 'run the flow, then switch it off.' } });
      linked = `#${card.number}`;
    }
    return ok({ created: rule.name, id: rule.id, state: 'off - proposed; the user switches it on in Interception',
      mention: `@[rule:${rule.id}|${rule.name}]`, ...(linked ? { linkedTo: linked } : {}) });
  }));

  server.registerTool('rule_hits', {
    description: `What one rule did to the last ${PREVIEW_CALLS} calls of its direction: the calls it touched (⚡) and the actions applied. `
      + 'Use after the user switched your rule on, then comment the result on its card (board_comment).',
    inputSchema: { ruleId: z.string().min(1) },
  }, (input) => run(async () => {
    const rule = await client.get<RuleRow & { match?: { source?: string } }>(`/interception/rules/${seg(input.ruleId)}`, { notFound: `Rule ${input.ruleId} not found.` });
    const sources: ('outbound' | 'inbound')[] = rule.match?.source === 'inbound' ? ['inbound'] : rule.match?.source === 'outbound' ? ['outbound'] : ['outbound', 'inbound'];
    const calls = (await Promise.all(sources.map((s) => recentCalls(client, s)))).flat();
    const hits = calls.filter((c) => c.interception?.applied?.some((a) => a.ruleId === rule.id));
    const fitted = fitItems(hits.slice(0, 20).map((c) => `${callLine(c)} · ${c.interception!.applied.filter((a) => a.ruleId === rule.id)
      .map((a) => `${a.action}${a.detail ? ` (${a.detail})` : ''}`).join(', ')}`), 300);
    return ok({ rule: rule.name, state: rule.enabled ? `on${rule.expiresAt ? ` until ${rule.expiresAt}` : ''}` : 'off', hits: hits.length,
      calls: fitted.items, ...(rule.enabled || hits.length ? {} : { hint: 'The rule is off - the user switches it on in Interception.' }) });
  }));
}
