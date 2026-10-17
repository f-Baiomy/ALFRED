import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { AlfredError, seg, type AlfredClient, type RequestOptions } from '../alfred-client.ts';
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

interface SeedRow {
  readonly item: ItemRow;
  readonly provider: string;
  readonly purpose: string | null;
  readonly steps: string | null;
  readonly acceptance: string | null;
  readonly context: string | null;
  readonly parentAcceptance: string | null;
  readonly children: readonly string[];
  readonly attachments: readonly { name: string; size: number; url: string }[];
  readonly links: readonly { toId: string; kind: string }[];
  readonly board: string | null;
}

const AS_CLAUDE: Pick<RequestOptions, 'headers'> = { headers: { 'X-Alfred-Actor': 'claude' } };
const SEED_PARTS = ['purpose', 'steps', 'acceptance', 'context', 'parentAcceptance'] as const;

/** "AB#1234", "#1234" or "1234" -> "1234"; "conn/1234" names the connection too. */
export function itemRef(ref: string): { conn?: string; id: string } {
  const t = ref.trim();
  const slash = t.lastIndexOf('/');
  const conn = slash > 0 ? t.slice(0, slash) : undefined;
  const id = (slash > 0 ? t.slice(slash + 1) : t).replace(/^[A-Za-z]*#/, '');
  return conn ? { conn, id } : { id };
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
    description: 'One work item from the cache as a board seed: purpose, steps, acceptance and context (by the field maps the user set '
      + 'in Settings), the acceptance of the parent, the children of a Feature, its attachments by name and link, links, and the Alfred board it opened '
      + 'if any. id may be "AB#1234" or "<conn>/1234". Long parts come in parts: pass part (or field) with offset; nothing is cut.',
    inputSchema: {
      conn: Conn,
      id: z.string().min(1).max(200).describe('The item: 1234, AB#1234 or <conn>/1234'),
      part: z.enum(SEED_PARTS).optional().describe('Read one long seed part in parts (with offset)'),
      field: z.string().min(1).max(300).optional().describe('Read one raw field in parts (with offset)'),
      offset: z.number().int().min(0).default(0),
    },
  }, (input) => run(async () => {
    const ref = itemRef(input.id);
    const c = await pickConnection(client, input.conn ?? ref.conn);
    if (input.field) {
      const d = await client.get<ItemDetailRow>(`/teamboards/items/${seg(c.id)}/${seg(ref.id)}`);
      const f = d.fields.find((x) => x.key === input.field);
      if (!f) throw notFound(`Item ${ref.id} has no field ${input.field}`);
      return ok({ field: f.key, ...chunkText(f.value ?? '', input.offset, 12_000) });
    }
    const s = await client.get<SeedRow>(`/teamboards/items/${seg(c.id)}/${seg(ref.id)}/seed`);
    if (input.part) return ok({ part: input.part, ...chunkText(s[input.part] ?? '', input.offset, 12_000) });
    const seed: Record<string, string | null> = {};
    for (const p of SEED_PARTS) {
      const v = s[p];
      if (!v) { seed[p] = null; continue; }
      const head = chunkText(v, 0, FIELD_PART);
      seed[p] = head.nextOffset === null ? v
        : `${head.text} [… ${head.totalLength - head.length} more characters: team_item part "${p}" offset ${head.nextOffset}]`;
    }
    return ok({ item: itemLine(s.item), conn: c.id, provider: s.provider, url: s.item.url, board: s.board ?? 'none', seed,
      children: s.children, attachments: s.attachments.map((a) => `${a.name} (${a.size >= 0 ? a.size + ' bytes' : 'size unknown'}) ${a.url}`),
      links: s.links.map((l) => `${l.kind} → ${l.toId}`) });
  }));

  server.registerTool('team_link', {
    description: 'Link a board to the work item it was set up from (/alfred-setup does this last). Alfred keeps a snapshot of the item, '
      + 'so the board shows what changes in the tracker later, and moves onto the board the attachments that the Start of the user fetched. '
      + 'Refused when the item already has another board.',
    inputSchema: { board: z.string().min(1).max(200), id: z.string().min(1).max(200).describe('1234, AB#1234 or <conn>/1234'), conn: Conn },
  }, (input) => run(async () => {
    const ref = itemRef(input.id);
    const c = await pickConnection(client, input.conn ?? ref.conn);
    const r = await client.put<{ attached: string[]; notAttached: string[] }>(`/teamboards/links/${seg(input.board)}`,
      { body: { conn: c.id, extId: ref.id }, ...AS_CLAUDE });
    return ok({ linked: `${input.board} ↔ ${c.id}/${ref.id}`, attached: r.attached, notAttached: r.notAttached,
      ...(r.notAttached.length ? { note: 'List the files not attached in the brief by name and link; the user fetches them with "Fetch attachments".' } : {}) });
  }));

  server.registerTool('team_start', {
    description: 'Start a board from a work item - the same as the Start button - ONLY when the user asked for it (in a board chat or '
      + 'this terminal); askedIn is the id of that chat message or "terminal". It posts /alfred-setup for the item in the chat of the mapped board. '
      + 'Without a mapping it answers NEEDS_TARGET: ask the user which project (and board), then pass project/board. Never start on your own.',
    inputSchema: {
      id: z.string().min(1).max(200).describe('1234, AB#1234 or <conn>/1234'),
      conn: Conn,
      askedIn: z.string().min(1).max(40),
      project: z.string().min(1).max(200).optional(),
      board: z.string().min(1).max(200).optional(),
      remember: z.boolean().default(false).describe('Save project/board as the mapping for the squad (or area) of the item'),
    },
  }, (input) => run(async () => {
    const ref = itemRef(input.id);
    const c = await pickConnection(client, input.conn ?? ref.conn);
    const target = input.project ? { project: input.project, boardId: input.board ?? null, remember: input.remember } : null;
    try {
      const r = await client.post<{ state: string; project: string; boardId: string | null; messageId: number }>(
        `/teamboards/items/${seg(c.id)}/${seg(ref.id)}/start`, { body: { target, askedIn: input.askedIn }, ...AS_CLAUDE });
      return ok({ result: r.state, project: r.project, board: r.boardId ?? 'the default board of the project', message: r.messageId,
        next: '/alfred-setup ' + c.id + '/' + ref.id + ' now waits in that board chat' });
    } catch (e) {
      if (e instanceof AlfredError && (e.code === 'NEEDS_TARGET' || e.code === 'ALREADY_STARTED')) {
        return ok({ result: e.code, note: e.code === 'NEEDS_TARGET' ? 'No mapping: ask the user which Alfred project (and board), then call again with project'
          : e.message });
      }
      throw e;
    }
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
