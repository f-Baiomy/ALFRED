import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { seg, type AlfredClient } from '../alfred-client.ts';
import { maskContext, maskMeta, maskText, type MaskContext } from '../masking.ts';
import { fitItems, invalid, notFound, ok, preview, run } from '../reply.ts';
import { MaskSchema } from './cycles.ts';

/**
 * Read-only views of what changes traffic: interception rules (why a call came back ⚡ changed) and
 * Relive runs (what a replay found). Nothing here edits a rule, runs a cycle or touches a live call -
 * those stay in the UI, where their effect on live traffic is visible.
 */

interface Rule {
  id: string;
  name: string;
  enabled: boolean;
  priority: number;
  match?: { source?: string; serviceNames?: string[]; methods?: string[]; host?: string; pathContains?: string; body?: unknown[] };
  actions?: { type: string; enabled?: boolean }[];
}

interface ReliveCycleRow { id: string; name: string; stepCount: number; lastRun: unknown; updatedAt: string; isTransient?: boolean }
interface RunRow { id: string; status: string; driver: string; startedAt: string; finishedAt: string | null; summary: Record<string, number> }
interface StepResult {
  stepKey: string;
  attempt: number;
  state: string;
  mode: string;
  durationMs: number | null;
  error: string | null;
  actualResponse?: { status?: number } | null;
  differences?: { part: string; path: string; recorded: unknown; actual: unknown; kind: string }[];
  assertions?: { passed?: boolean; description?: string; message?: string }[];
}
interface RunDetail extends RunRow {
  definition?: { steps?: { key: string; label: string }[] } | null;
  stepResults?: StepResult[];
}

/** Run detail carries the whole cycle definition with every recorded body - megabytes; given time to arrive. */
const RUN_TIMEOUT_MS = 60_000;
const DIFFERENCES_SHOWN = 8;

function ruleRow(r: Rule) {
  const m = r.match ?? {};
  return {
    id: r.id,
    name: r.name,
    enabled: r.enabled,
    priority: r.priority,
    match: [m.source, m.methods?.join('|'), m.host, m.pathContains, m.serviceNames?.length ? `projects ${m.serviceNames.join(',')}` : null,
      m.body?.length ? `${m.body.length} body condition(s)` : null].filter(Boolean).join(' '),
    actions: (r.actions ?? []).filter((a) => a.enabled !== false).map((a) => a.type),
  };
}

async function findReliveCycle(client: AlfredClient, idOrName: string): Promise<ReliveCycleRow> {
  const all = await client.get<ReliveCycleRow[]>('/relive-cycles');
  const byId = all.find((c) => c.id === idOrName);
  if (byId) return byId;
  const needle = idOrName.toLowerCase();
  const matches = all.filter((c) => c.name.toLowerCase().includes(needle));
  if (matches.length === 1) return matches[0];
  if (!matches.length) throw notFound(`No Relive cycle with id or name "${idOrName}". Use list_relive_cycles.`);
  throw invalid(`"${idOrName}" matches ${matches.length} Relive cycles: ${matches.map((c) => `${c.name} (${c.id})`).join('; ')}. Pass the id.`);
}

/** A recorded or actual value as shown: masked when masking is on, shortened (the run in the UI has it whole). */
function shown(ctx: MaskContext, value: unknown): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value) ?? 'null';
  return preview(maskText(ctx, text), 200, 'see the run in the UI');
}

export function register(server: McpServer, client: AlfredClient): void {
  server.registerTool('list_rules', {
    description: 'Interception rules (read-only): what each matches and does, whether it is on, and whether interception is on at all. '
      + 'A call a rule changed shows ⚡ with the rule name in get_cycle and get_call.',
    inputSchema: { enabledOnly: z.boolean().default(false) },
  }, (input) => run(async () => {
    const [rules, enabled] = await Promise.all([client.get<Rule[]>('/interception/rules'), client.get<{ enabled: boolean }>('/interception/enabled')]);
    const rows = rules.filter((r) => !input.enabledOnly || r.enabled).map(ruleRow);
    const fitted = fitItems(rows, 300);
    return ok({
      interceptionEnabled: enabled.enabled, total: rows.length, rules: fitted.items,
      ...(fitted.cut ? { more: 'Not all rules fit - pass enabledOnly, or read one with get_rule.' } : {}),
    });
  }));

  server.registerTool('get_rule', {
    description: 'One interception rule in full (read-only): its match conditions, actions and settings.',
    inputSchema: { ruleId: z.string().min(1) },
  }, (input) => run(async () => ok(await client.get<Rule>(`/interception/rules/${seg(input.ruleId)}`, { notFound: `Rule ${input.ruleId} not found.` }))));

  server.registerTool('list_relive_cycles', {
    description: 'Relive cycles (read-only): replay workflows built from recorded calls, with step count and last run.',
    inputSchema: { nameContains: z.string().optional() },
  }, (input) => run(async () => {
    const all = await client.get<ReliveCycleRow[]>('/relive-cycles');
    const rows = all.filter((c) => !c.isTransient && (!input.nameContains || c.name.toLowerCase().includes(input.nameContains.toLowerCase())))
      .map((c) => ({ id: c.id, name: c.name, steps: c.stepCount, lastRun: c.lastRun, updatedAt: c.updatedAt }));
    const fitted = fitItems(rows, 200);
    return ok({ total: rows.length, cycles: fitted.items });
  }));

  server.registerTool('list_relive_runs', {
    description: 'Runs of one Relive cycle (read-only), newest first: status and how many steps completed, differed, failed or were skipped.',
    inputSchema: { reliveCycle: z.string().min(1).describe('Relive cycle id or name text'), limit: z.number().int().min(1).max(50).default(10) },
  }, (input) => run(async () => {
    const cycle = await findReliveCycle(client, input.reliveCycle);
    const runs = await client.get<RunRow[]>(`/relive-cycles/${seg(cycle.id)}/runs`, { query: { limit: input.limit } });
    return ok({
      reliveCycle: { id: cycle.id, name: cycle.name },
      runs: runs.map((r) => ({ id: r.id, status: r.status, driver: r.driver, startedAt: r.startedAt, finishedAt: r.finishedAt, summary: r.summary })),
    });
  }));

  server.registerTool('get_relive_run', {
    description: 'One Relive run step by step (read-only): each step\'s label, state, status, duration, error, and what differed from the '
      + 'recording (part, path, recorded vs actual). Filter by state (e.g. FAILED, COMPLETED_WITH_DIFFERENCES); page with offset/limit.',
    inputSchema: {
      reliveCycle: z.string().min(1).describe('Relive cycle id or name text'),
      runId: z.string().min(1),
      state: z.string().optional().describe('Only steps in this state'),
      offset: z.number().int().min(0).default(0),
      limit: z.number().int().min(1).max(100).default(30),
      mask: MaskSchema,
    },
  }, (input) => run(async () => {
    const ctx = await maskContext(client, input.mask);
    const cycle = await findReliveCycle(client, input.reliveCycle);
    const detail = await client.get<RunDetail>(`/relive-cycles/${seg(cycle.id)}/runs/${seg(input.runId)}`, {
      notFound: `Run ${input.runId} not found in "${cycle.name}".`, timeoutMs: RUN_TIMEOUT_MS,
    });
    const steps = detail.definition?.steps ?? [];
    const order = new Map(steps.map((s, i) => [s.key, i]));
    const labelOf = new Map(steps.map((s) => [s.key, s.label]));
    const results = [...(detail.stepResults ?? [])]
      .sort((a, b) => (order.get(a.stepKey) ?? Number.MAX_SAFE_INTEGER) - (order.get(b.stepKey) ?? Number.MAX_SAFE_INTEGER) || a.attempt - b.attempt)
      .filter((r) => !input.state || r.state.toUpperCase() === input.state.toUpperCase());
    const rows = results.slice(input.offset, input.offset + input.limit).map((r) => {
      const failedAssertions = (r.assertions ?? []).filter((a) => a.passed === false);
      return {
        n: order.has(r.stepKey) ? order.get(r.stepKey)! + 1 : null,
        step: labelOf.get(r.stepKey) ?? r.stepKey,
        state: r.state,
        mode: r.mode,
        attempt: r.attempt,
        status: r.actualResponse?.status ?? null,
        durationMs: r.durationMs,
        ...(r.error ? { error: shown(ctx, r.error) } : {}),
        ...(r.differences?.length ? {
          differences: r.differences.slice(0, DIFFERENCES_SHOWN).map((d) => ({ part: d.part, path: d.path, kind: d.kind, recorded: shown(ctx, d.recorded), actual: shown(ctx, d.actual) })),
          ...(r.differences.length > DIFFERENCES_SHOWN ? { moreDifferences: r.differences.length - DIFFERENCES_SHOWN } : {}),
        } : {}),
        ...(failedAssertions.length ? { failedAssertions: failedAssertions.map((a) => shown(ctx, a.message ?? a.description ?? a)) } : {}),
      };
    });
    const fitted = fitItems(rows, 600);
    const end = input.offset + fitted.items.length;
    return ok({
      run: { id: detail.id, status: detail.status, driver: detail.driver, startedAt: detail.startedAt, finishedAt: detail.finishedAt, summary: detail.summary },
      total: results.length, offset: input.offset, nextOffset: end < results.length ? end : null, steps: fitted.items, ...maskMeta(ctx),
    });
  }));
}
