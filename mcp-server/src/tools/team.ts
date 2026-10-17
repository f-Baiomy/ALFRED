import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { seg, type AlfredClient } from '../alfred-client.ts';
import { chunkText, invalid, notFound, ok, run } from '../reply.ts';

/**
 * The team's tracker (specs/027 US7), read from Alfred's shared cache only: work items, one item with where its fields
 * go in a board's seed, the changes feed and the squads. These tools never reach the tracker and hold no token - what
 * they show is what the last Refresh (by any user) fetched.
 */
interface ConnectionRow {
  readonly id: string;
  readonly kind: string;
  readonly name: string;
  readonly fetchedAt: string | null;
  readonly fetchedBy: string | null;
  readonly newChanges: number;
}

interface ItemRow {
  readonly conn: string;
  readonly extId: string;
  readonly type: string;
  readonly title: string;
  readonly state: string | null;
  readonly assignee: string | null;
  readonly squad: string | null;
  readonly sprint: string | null;
  readonly url: string;
  readonly changedAt: string | null;
}

interface ItemDetailRow {
  readonly item: ItemRow;
  readonly fields: readonly { key: string; value: string | null; mappedTo: string | null }[];
  readonly links: readonly { toId: string; kind: string }[];
  readonly board: string | null;
}

interface ChangeRow {
  readonly id: number;
  readonly extId: string;
  readonly rev: number;
  readonly by: string | null;
  readonly at: string;
  readonly summary: string;
  readonly title: string | null;
  readonly fresh: boolean;
}

interface SquadRow {
  readonly extId: string;
  readonly name: string;
  readonly project: string | null;
  readonly alfredProject: string | null;
  readonly alfredTeam: string | null;
  readonly members: readonly string[];
}

const Conn = z.string().min(1).max(100).optional()
  .describe('A connection id; omitted: the only connection (the tool says which ones exist when there are several)');

async function pickConnection(client: AlfredClient, conn: string | undefined): Promise<ConnectionRow> {
  const all = await client.get<ConnectionRow[]>('/teamboards/connections');
  if (conn) {
    const c = all.find((x) => x.id === conn);
    if (!c) throw notFound(`No connection ${conn}. Connections: ${all.map((x) => x.id).join(', ') || 'none'}`);
    return c;
  }
  if (all.length === 1) return all[0];
  throw invalid(all.length ? `Several connections - pass conn: ${all.map((x) => `${x.id} (${x.name})`).join(', ')}`
    : 'No team tracker is connected - the user adds one in Settings → Team trackers');
}

function fetched(c: ConnectionRow): string {
  return `${c.name} (${c.kind}) · ${c.fetchedAt ? `fetched ${c.fetchedAt}${c.fetchedBy ? ' by ' + c.fetchedBy : ''}` : 'never fetched - ask the user to Refresh on the Team tab'}`;
}

export function itemLine(i: ItemRow): string {
  return `${i.extId} · ${i.type} · "${i.title}" · ${i.state ?? '-'}${i.assignee ? ' · ' + i.assignee : ''}${i.squad ? ' · ' + i.squad : ''}`
    + (i.sprint ? ' · ' + i.sprint.split('\\').pop() : '');
}

/** A field longer than this is shown in parts: team_item with field + offset reads the rest (never cut, only paged). */
export const FIELD_PART = 3000;

/** An item's fields grouped by where they go in a board's seed; unmapped ones stay as context. */
export function seedOf(d: ItemDetailRow): Record<string, string[]> {
  const out: Record<string, string[]> = { purpose: [], steps: [], acceptance: [], context: [] };
  for (const f of d.fields) {
    if (!f.value) continue;
    const target = (f.mappedTo ?? 'CONTEXT').toLowerCase();
    const part = chunkText(f.value, 0, FIELD_PART);
    const line = part.nextOffset === null ? `${f.key}: ${f.value}`
      : `${f.key}: ${part.text} [… ${part.totalLength - part.length} more characters: team_item field "${f.key}" offset ${part.nextOffset}]`;
    (out[target] ?? out.context).push(line);
  }
  return out;
}

export function register(server: McpServer, client: AlfredClient): void {
  server.registerTool('team_items', {
    description: 'Work items of the team\'s tracker (Azure DevOps), read from Alfred\'s cache - filter by text, type, state, squad, assignee '
      + 'or sprint. Read-only; the cache is as fresh as the last Refresh a user did on the Team tab.',
    inputSchema: {
      conn: Conn,
      q: z.string().max(200).optional(),
      type: z.string().max(100).optional(),
      state: z.string().max(100).optional(),
      squad: z.string().max(200).optional(),
      assignee: z.string().max(200).optional(),
      sprint: z.string().max(300).optional(),
      offset: z.number().int().min(0).default(0),
      limit: z.number().int().min(1).max(200).default(50),
    },
  }, (input) => run(async () => {
    const c = await pickConnection(client, input.conn);
    const page = await client.get<{ items: ItemRow[]; total: number }>(`/teamboards/connections/${seg(c.id)}/items`, {
      query: { q: input.q, type: input.type, state: input.state, squad: input.squad, assignee: input.assignee, sprint: input.sprint,
        offset: input.offset, limit: input.limit },
    });
    return ok({ connection: fetched(c), total: page.total, items: page.items.map(itemLine),
      ...(input.offset + page.items.length < page.total ? { more: `offset ${input.offset + page.items.length}` } : {}) });
  }));

  server.registerTool('team_item', {
    description: 'One work item in full from the cache: every field (none cut), grouped by where it goes in a board\'s seed '
      + '(purpose, steps, acceptance, context - the user maps fields in Settings), its links, and the Alfred board it opened if any.',
    inputSchema: {
      conn: Conn,
      id: z.string().min(1).max(100).describe('The item id, e.g. 1234'),
      field: z.string().min(1).max(300).optional().describe('Read one long field in parts (with offset)'),
      offset: z.number().int().min(0).default(0),
    },
  }, (input) => run(async () => {
    const c = await pickConnection(client, input.conn);
    const d = await client.get<ItemDetailRow>(`/teamboards/items/${seg(c.id)}/${seg(input.id)}`);
    if (input.field) {
      const f = d.fields.find((x) => x.key === input.field);
      if (!f) throw notFound(`Item ${input.id} has no field ${input.field}`);
      return ok({ field: f.key, ...chunkText(f.value ?? '', input.offset, 12_000) });
    }
    return ok({ item: itemLine(d.item), url: d.item.url, board: d.board ?? 'none', seed: seedOf(d),
      links: d.links.map((l) => `${l.kind} → ${l.toId}`) });
  }));

  server.registerTool('team_changes', {
    description: 'What changed in the tracker, newest first, from the cache: one line per item revision ("State Active → Resolved"). '
      + 'fresh = nobody marked it seen yet. Page older with after = the last id shown.',
    inputSchema: {
      conn: Conn,
      squad: z.string().max(200).optional(),
      person: z.string().max(200).optional(),
      after: z.number().int().optional(),
      limit: z.number().int().min(1).max(200).default(50),
    },
  }, (input) => run(async () => {
    const c = await pickConnection(client, input.conn);
    const rows = await client.get<ChangeRow[]>(`/teamboards/connections/${seg(c.id)}/changes`, {
      query: { squad: input.squad, person: input.person, after: input.after, limit: input.limit },
    });
    return ok({ connection: fetched(c), changes: rows.map((r) => `[${r.id}] ${r.at} · ${r.extId} "${r.title ?? ''}" · ${r.summary}`
      + `${r.by ? ' · ' + r.by : ''}${r.fresh ? ' · new' : ''}`), ...(rows.length === input.limit ? { more: `after ${rows.at(-1)!.id}` } : {}) });
  }));

  server.registerTool('team_squads', {
    description: 'The tracker\'s squads (teams) with their members, and the Alfred project and board team each is mapped to.',
    inputSchema: { conn: Conn },
  }, (input) => run(async () => {
    const c = await pickConnection(client, input.conn);
    const rows = await client.get<SquadRow[]>(`/teamboards/connections/${seg(c.id)}/squads`);
    return ok({ connection: fetched(c), squads: rows.map((s) => `${s.name}${s.project ? ' (' + s.project + ')' : ''} · `
      + `${s.alfredProject ? 'Alfred ' + s.alfredProject + (s.alfredTeam ? ' / ' + s.alfredTeam : '') : 'not mapped'} · members: ${s.members.join(', ') || '-'}`) });
  }));
}
