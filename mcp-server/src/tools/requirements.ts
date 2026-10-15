import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { AlfredError, seg, type AlfredClient, type RequestOptions } from '../alfred-client.ts';
import { serializeMention } from '../frontend.ts';
import { maskContext, maskMeta, maskText, type MaskContext } from '../masking.ts';
import { fitItems, invalid, ok, run } from '../reply.ts';
import { requireCycle } from '../cycle-calls.ts';
import { MaskSchema } from './cycles.ts';

/**
 * The requirement check (specs/018): each Acceptance item's evidence - the endpoint whose calls show it and the checks
 * each such call must pass - and its verdict, worked out by Alfred in code as calls arrive. Claude drafts the evidence
 * from the spec (no approval needed; the user's edit wins); a missing feature becomes a card without any model run.
 */

const AS_CLAUDE: Pick<RequestOptions, 'headers'> = { headers: { 'X-Alfred-Actor': 'claude' } };

export interface EvidenceCheckRow {
  kind: 'REQUEST_SHAPE' | 'REQUEST_WHEN' | 'ROWS_MATCH_FILTER' | 'ROWS_PRESENT' | 'STATUS';
  path?: string | null; shape?: string | null; rows?: string | null; field?: string | null; min?: number | null; range?: string | null;
}
export interface EvidenceRow {
  cycleId: string; fileName: string; itemKey: string; project: string; endpoint: string; checks: EvidenceCheckRow[]; howTo: string;
  updatedBy: 'USER' | 'CLAUDE' | null; updatedAt: string | null;
}
export type Verdict = 'MISSING' | 'WRONG' | 'MET' | 'NO_DATA' | 'UNKNOWN' | 'NOT_EXERCISED' | 'MANUAL' | 'NO_EVIDENCE';
export interface VerdictRow {
  verdict: Verdict; callId: string | null; reason: string | null; cardId: string | null; judgedAt: string | null;
  counts: { contradicts: number; wrong: number; meets: number; noData: number; unknown: number; skipped?: number };
}
export interface RequirementRow {
  fileName: string; itemKey: string; text: string; mark: string | null; evidence: EvidenceRow | null; verdict: VerdictRow;
  cardNumber: number | null; cardStatus: string | null;
  /** The few words every mention of the item reads (specs/021). */
  shortName?: string | null;
}
export interface RequirementsView { cycleId: string; items: RequirementRow[]; counts: Partial<Record<Verdict, number>> }

/** Worst first - the order counts are shown in. */
export const VERDICT_ORDER: readonly Verdict[] = ['MISSING', 'WRONG', 'MET', 'NO_DATA', 'UNKNOWN', 'NOT_EXERCISED', 'MANUAL', 'NO_EVIDENCE'];
const VERDICT_WORD: Record<Verdict, string> = {
  MISSING: 'missing', WRONG: 'wrong', MET: 'met', NO_DATA: 'no data', UNKNOWN: 'unknown', NOT_EXERCISED: 'not exercised',
  MANUAL: 'manual', NO_EVIDENCE: 'no evidence',
};

export async function readRequirements(client: AlfredClient, cycleId: string): Promise<RequirementsView | null> {
  try {
    return await client.get<RequirementsView>(`/board/cycles/${seg(cycleId)}/requirements`);
  } catch (error) {
    if (error instanceof AlfredError && error.kind === 'not_found') return null; // an Alfred without specs/018
    throw error;
  }
}

/** "5 missing · 0 wrong · 2 met · …" - only the verdicts that occur, worst first. */
export function countsLine(view: RequirementsView): string {
  return VERDICT_ORDER.filter((v) => (view.counts[v] ?? 0) > 0).map((v) => `${view.counts[v]} ${VERDICT_WORD[v]}`).join(' · ') || 'no items';
}

/** One item as a line: its number, verdict, card and why - the call that decided it as a mention. */
export function requirementLine(ctx: MaskContext, r: RequirementRow, n: number, cycleId: string): string {
  const v = r.verdict;
  const card = r.cardNumber ? ` (#${r.cardNumber}${r.cardStatus && r.cardStatus !== 'INBOX' ? ` ${r.cardStatus}` : ''})` : '';
  const call = v.callId ? ` ${serializeMention({ type: 'call', ref: `in:${v.callId}@${cycleId}`, label: `call ${v.callId.slice(0, 8)}` })}` : '';
  const why = v.reason ? ` - ${maskText(ctx, v.reason)}` : v.verdict === 'NO_EVIDENCE' ? ' - board_evidence_put writes how the calls show it'
    : v.verdict === 'NOT_EXERCISED' && r.evidence?.howTo ? ` - how: ${maskText(ctx, r.evidence.howTo)}` : '';
  // specs/020: the endpoint WAS called - its REQUEST_WHEN left every call out; never call that "not exercised" unchecked
  const skipped = v.verdict === 'NOT_EXERCISED' && (v.counts?.skipped ?? 0) > 0
    ? ` · BUT ${v.counts.skipped} call${v.counts.skipped === 1 ? '' : 's'} to the endpoint did not match its REQUEST_WHEN - read them (an app's own "all" `
      + 'marker such as -11 needs shape has:-11) and fix the evidence with board_evidence_put before saying nobody tried it' : '';
  // specs/021: the few words its mentions read - "no short name" asks Claude to give one (board_short_name)
  const named = r.shortName ? ` "${r.shortName}"` : ' (no short name)';
  return `AC${n}${named} ${v.verdict}${card}${call} [${r.itemKey}] ${maskText(ctx, r.text)}${why}${skipped}`;
}

const CheckSchema = z.object({
  kind: z.enum(['REQUEST_SHAPE', 'REQUEST_WHEN', 'ROWS_MATCH_FILTER', 'ROWS_PRESENT', 'STATUS']),
  path: z.string().max(200).optional().describe('Request JSON path: $.branchIds, or $.branch* for the one key starting so'),
  shape: z.string().max(104).optional().describe('REQUEST_SHAPE: list | scalar | present. REQUEST_WHEN: none | one | list | list>=2 | present | has:<value> (an app marker, e.g. has:-11 for "All")'),
  rows: z.string().max(200).optional().describe('ROWS_*: the response list, e.g. $.payload'),
  field: z.string().max(100).optional().describe('ROWS_MATCH_FILTER: the row key compared with the request filter at path, e.g. branchId or branch*'),
  min: z.number().int().min(1).max(10_000).optional().describe('ROWS_PRESENT: rows needed (1)'),
  range: z.string().max(10).optional().describe('STATUS: 2xx | 200 | !405 | !5xx'),
});

const ItemSchema = z.object({
  item: z.string().min(1).max(400).describe('The Acceptance item: its full key, its number as board_requirements lists it (AC5), or the start of its text'),
  endpoint: z.string().min(1).max(300).describe('METHOD /path whose calls show the item (ids may stay as they are or be {x}), or UI when no call can show it'),
  checks: z.array(CheckSchema).max(10).default([]),
  howTo: z.string().max(300).default('').describe('What to do in the app to make that call'),
});

/** The item a reference names: a full key, ACn / n (as listed), or the unique start of its text. */
export function resolveItem(items: readonly RequirementRow[], ref: string): RequirementRow | string {
  const r = ref.trim();
  const byKey = items.find((i) => i.itemKey === r);
  if (byKey) return byKey;
  const num = /^(?:AC|R)?\s*(\d{1,3})$/i.exec(r);
  if (num) {
    const n = Number(num[1]);
    return items[n - 1] ?? `There is no AC${n} - the cycle has ${items.length} Acceptance items.`;
  }
  const text = r.toLowerCase();
  const hits = items.filter((i) => i.text.toLowerCase().startsWith(text) || i.text.toLowerCase() === text);
  if (hits.length === 1) return hits[0];
  return hits.length ? `"${r}" starts ${hits.length} items - use the key or AC number` : `No Acceptance item starts "${r}" - board_requirements lists them`;
}

export function register(server: McpServer, client: AlfredClient): void {
  server.registerTool('board_requirements', {
    description: 'Every Acceptance item of a cycle with its verdict BY THE CALLS, worked out by Alfred in code as calls arrive (specs/018): '
      + 'MISSING (a call cannot meet it - e.g. one branchId where several branches must fit; Alfred opened a "Missing feature" card), '
      + 'WRONG (the request can, the answer breaks it - a "Wrong result" bug), MET, NO_DATA (the right request, no rows to prove it), '
      + 'UNKNOWN (could not be read), NOT_EXERCISED (no call matched yet), MANUAL (UI only - check the frontend code or ask), '
      + 'NO_EVIDENCE (write it with board_evidence_put). Each line has the deciding call and the reason. Never second-guess a MISSING '
      + 'with "old code": that is what MISSING means.',
    inputSchema: { cycleId: z.string().min(1).describe('Cycle id or text from its name'), mask: MaskSchema },
  }, (input) => run(async () => {
    const cycle = await requireCycle(client, input.cycleId);
    const view = await readRequirements(client, cycle.id);
    if (!view) throw invalid('This Alfred has no requirement check (specs/018) - update Alfred.');
    const ctx = await maskContext(client, input.mask);
    const lines = view.items.map((r, i) => requirementLine(ctx, r, i + 1, cycle.id));
    const fitted = fitItems(lines, 400);
    return ok({ cycleId: cycle.id, counts: countsLine(view), items: fitted.items, ...(fitted.cut ? { more: 'Some items did not fit.' } : {}),
      ...maskMeta(ctx) });
  }));

  server.registerTool('board_evidence_put', {
    description: 'Write how the calls show Acceptance items (specs/018) - several in one call. Alfred then judges every call to the endpoint in '
      + 'code and opens a "Missing feature" / "Wrong result" card the moment a call shows an item is not built or answers wrong. Saved at '
      + 'once (no approval); refused for an item whose evidence the user wrote. Checks, in the order they are applied:\n'
      + '- REQUEST_SHAPE {path, shape: list|scalar|present} - what the request must be ABLE to carry whatever the user chose; a call that '
      + 'fails it makes the item MISSING. Use it for the capability the item needs ("several branches" → $.branch* list).\n'
      + '- REQUEST_WHEN {path, shape: none|one|list|list>=2|present|has:<value>} - which calls exercise the item; others are about another '
      + 'choice and do not count ("All Branches" → $.branch* none, or has:-11 when the app sends its own "all" marker - read a recorded '
      + 'call first; "two branches" → list>=2).\n'
      + '- STATUS {range} and ROWS_MATCH_FILTER {rows, field, path} - what the answer must be (every row\'s branch in the request\'s '
      + 'branches); a failure is WRONG.\n'
      + '- ROWS_PRESENT {rows, min} - without rows nothing is proven: NO_DATA.\n'
      + 'A path\'s last key may end in * ($.branch*) when the field\'s new name is not known: it must name exactly one key, else the call is '
      + 'UNKNOWN (never MISSING). Example for "Searching with several branches returns requests of any selected branch (OR)": endpoint '
      + '"POST /odeysysadmin/Booking2/refunded-requests/search", checks [REQUEST_SHAPE $.branch* list, REQUEST_WHEN $.branch* list>=2, '
      + 'ROWS_MATCH_FILTER rows $.payload field branch* path $.branch*, ROWS_PRESENT rows $.payload]. A pure UI item: endpoint "UI", no checks.',
    inputSchema: {
      cycleId: z.string().min(1).describe('Cycle id or text from its name'),
      project: z.string().default('').describe('The project whose calls show it (odeysys)'),
      items: z.array(ItemSchema).min(1).max(50),
    },
  }, (input) => run(async () => {
    const cycle = await requireCycle(client, input.cycleId);
    const view = await readRequirements(client, cycle.id);
    if (!view) throw invalid('This Alfred has no requirement check (specs/018) - update Alfred.');
    const saved: string[] = [];
    const refused: string[] = [];
    for (const it of input.items) {
      const item = resolveItem(view.items, it.item);
      if (typeof item === 'string') {
        refused.push(`${it.item}: ${item}`);
        continue;
      }
      const n = view.items.indexOf(item) + 1;
      try {
        await client.put(`/board/cycles/${seg(cycle.id)}/evidence`, { ...AS_CLAUDE, body: {
          fileName: item.fileName, itemKey: item.itemKey, project: input.project, endpoint: it.endpoint, checks: it.checks, howTo: it.howTo } });
        saved.push(`AC${n} ${item.text.slice(0, 80)}`);
      } catch (error) {
        refused.push(`AC${n}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return ok({ saved, ...(refused.length ? { refused } : {}),
      next: 'Alfred judges every call to these endpoints now and as they arrive - board_requirements shows the verdicts.' });
  }));
}
