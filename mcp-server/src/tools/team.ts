import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { AlfredError, seg, type AlfredClient, type RequestOptions } from '../alfred-client.ts';
import { chunkText, invalid, notFound, ok, run } from '../reply.ts';
import { cardByNumber } from './board.ts';

/**
 * The team's tracker (specs/028): read LIVE through Alfred with the token the user entered on the Team tab - Claude never
 * holds a token, and with none live a read answers TOKEN_MISSING. Nothing found is stored. Every write Claude asks for
 * becomes a consent bundle that waits for the user's approval on the card or board; Claude never approves one.
 */
interface ConnectionRow {
  readonly id: string;
  readonly kind: string;
  readonly name: string;
  readonly capabilities: readonly string[];
}

interface Person { readonly extId: string | null; readonly name: string; readonly email: string | null }

interface BadgeRow { readonly boardId: string; readonly name: string | null; readonly role: string; readonly changed: boolean }

interface SearchRow {
  readonly id: string;
  readonly type: string;
  readonly title: string;
  readonly state: string | null;
  readonly assigned: Person | null;
  readonly iteration: string | null;
  readonly area: string | null;
  readonly changedAt: string | null;
  readonly url: string | null;
  readonly boards: readonly BadgeRow[];
  readonly cards: readonly string[];
}

interface SearchPage { readonly items: readonly SearchRow[]; readonly total: number; readonly fullText: boolean; readonly page: number; readonly pageSize: number }

interface ItemRow {
  readonly extId: string;
  readonly type: string;
  readonly title: string;
  readonly state: string | null;
  readonly assignee: string | null;
  readonly squad: string | null;
  readonly sprint: string | null;
  readonly area: string | null;
  readonly url: string | null;
  readonly rev: number;
  readonly changedAt: string | null;
  readonly fields: Readonly<Record<string, string>>;
  readonly links: readonly { toId: string; kind: string }[];
  readonly identities: Readonly<Record<string, Person>>;
}

interface ItemView {
  readonly item: ItemRow;
  readonly stateCategory: string | null;
  readonly comments: readonly { id: string; by: string | null; at: string | null; text: string }[] | null;
  readonly history: readonly { rev: number; by: string | null; at: string | null; changes: readonly { field: string; from: string | null; to: string | null }[] }[] | null;
  readonly attachments: readonly { name: string; mime: string; size: number }[] | null;
  readonly copyRev: number | null;
  readonly diff: readonly { field: string; from: string | null; to: string | null }[] | null;
  readonly boards: readonly BadgeRow[];
  readonly cards: readonly { cardId: string; boardId: string | null }[];
}

interface BoardItem {
  readonly row: { conn: string; item: string; role: string; relation: string; linkKind: string | null; parent: string | null; depth: number;
    type: string | null; title: string | null; state: string | null; leftTreeAt: string | null };
  readonly hasCopy: boolean;
  readonly copyRev: number | null;
  readonly changed: boolean;
  readonly cards: readonly string[];
}

interface BoardItemsView { readonly main: BoardItem | null; readonly items: readonly BoardItem[]; readonly syncedAt: string | null; readonly live: boolean }

interface CardItemRow {
  readonly conn: string; readonly item: string; readonly type: string | null; readonly title: string; readonly state: string | null;
  readonly changed: boolean; readonly closedInAzure: boolean; readonly copyRev: number; readonly url: string | null;
  readonly comments: readonly { by: string | null; at: string | null; text: string }[];
}

interface IncomingRow {
  readonly conn: string; readonly item: string; readonly source: string; readonly type: string | null; readonly title: string | null;
  readonly matchCard: string | null; readonly matchScore: number | null; readonly proposalAction: string | null; readonly proposalCard: string | null;
  readonly proposalReason: string | null; readonly state: string;
}

interface BundleRow { readonly id: number; readonly title: string; readonly state: string; readonly steps: readonly { kind: string; ticked: boolean }[] }

interface SeedRow {
  readonly item: ItemRow;
  readonly provider: string;
  readonly purpose: string | null;
  readonly steps: string | null;
  readonly acceptance: string | null;
  readonly context: string | null;
  readonly parentAcceptance: string | null;
  readonly children: readonly string[];
  readonly attachments: readonly { name: string; size: number; url: string; held: boolean }[];
  readonly links: readonly { toId: string; kind: string }[];
  readonly board: string | null;
}

const AS_CLAUDE: Pick<RequestOptions, 'headers'> = { headers: { 'X-Alfred-Actor': 'claude' } };
const SEED_PARTS = ['purpose', 'steps', 'acceptance', 'context', 'parentAcceptance'] as const;

/** "AB#1234", "#1234" or "1234" -> "1234"; "conn/1234" names the connection too; an item URL -> its id. */
export function itemRef(ref: string): { conn?: string; id: string } {
  const t = ref.trim();
  const url = /\/_workitems\/edit\/(\d+)/.exec(t);
  if (url) return { id: url[1] };
  const slash = t.lastIndexOf('/');
  const conn = slash > 0 ? t.slice(0, slash) : undefined;
  const id = (slash > 0 ? t.slice(slash + 1) : t).replace(/^[A-Za-z]*#/, '');
  return conn ? { conn, id } : { id };
}

const Conn = z.string().min(1).max(100).optional()
  .describe('A connection id; omitted: the only connection (the tool says which ones exist when there are several)');
const Id = z.string().min(1).max(300).describe('The item: 1234, AB#1234, <conn>/1234 or its URL');
const Card = { project: z.string().max(200).describe('The card\'s project ("" for No project)'), number: z.number().int().min(1) };
const AskedIn = z.string().min(1).max(40).optional()
  .describe('Only when the user asked for exactly this: the chat message id (or "terminal") where they asked - without it a write waits for approval');
const Extend = z.number().int().min(1).optional().describe('Add these steps to a waiting bundle of the same card instead of a new one');

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

/** A live read: TOKEN_MISSING / TOKEN_REJECTED become one plain sentence for the user. */
async function live<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (e) {
    if (e instanceof AlfredError && (e.code === 'TOKEN_MISSING' || e.code === 'TOKEN_REJECTED')) {
      throw invalid(`${e.code}: no token is live - ask the user to enter their personal access token in the Team tab. `
        + 'You never hold a token; do not ask for it in chat.');
    }
    throw e;
  }
}

function person(p: Person | null | undefined): string {
  return p ? p.name + (p.email ? ` <${p.email}>` : '') : '-';
}

function badges(b: readonly BadgeRow[], cards: readonly string[]): string {
  const parts = b.map((x) => `${x.role === 'MAIN' ? 'main of' : x.role === 'CARD' ? 'card on' : 'related to'} ${x.name ?? x.boardId}${x.changed ? ' (changed since the copy)' : ''}`);
  if (cards.length) parts.push(`cards ${cards.join(', ')}`);
  return parts.length ? ' · in Alfred: ' + parts.join('; ') : '';
}

export function rowLine(r: SearchRow): string {
  return `${r.id} · ${r.type} · "${r.title}" · ${r.state ?? '-'} · ${r.assigned ? r.assigned.name : 'unassigned'}`
    + (r.iteration ? ' · ' + r.iteration.split('\\').pop() : '') + badges(r.boards, r.cards);
}

/** A field longer than this is shown in parts: team_item with field + offset reads the rest (never cut, only paged). */
export const FIELD_PART = 3000;

function plain(s: string): string {
  return s.replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|li|tr)>/gi, '\n').replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&')
    .replace(/\n{3,}/g, '\n\n').trim();
}

function fieldsOf(fields: Readonly<Record<string, string>>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, raw] of Object.entries(fields)) {
    if (raw === null || raw === '') continue;
    const v = plain(raw);
    const head = chunkText(v, 0, FIELD_PART);
    out[k] = head.nextOffset === null ? v : `${head.text} [… ${head.totalLength - head.length} more characters: team_item field "${k}" offset ${head.nextOffset}]`;
  }
  return out;
}

function boardItemLine(i: BoardItem): string {
  const r = i.row;
  return `${'  '.repeat(Math.max(0, r.depth + 2))}${r.role === 'MAIN' ? '★ ' : ''}${r.item} · ${r.type ?? ''} · "${r.title ?? ''}" · ${r.state ?? '-'}`
    + ` · ${i.hasCopy ? `full copy rev ${i.copyRev ?? '?'}` : 'reference'}${i.changed ? ' · CHANGED since the copy' : ''}`
    + (r.linkKind ? ` · ${r.linkKind}` : '') + (r.leftTreeAt ? ' · left the tree' : '') + (i.cards.length ? ` · cards ${i.cards.join(', ')}` : '');
}

function bundleReply(b: BundleRow): Record<string, unknown> {
  return { bundle: b.id, title: b.title, state: b.state, steps: b.steps.map((s) => s.kind),
    note: b.state === 'WAITING' ? 'Waits for the user: they tick, edit and approve it on the card. Tell them it is there; never say it was sent.' : undefined };
}

const SearchFilters = {
  text: z.string().max(500).optional().describe('Words searched in title, description and comments (full-text when the organisation has Search)'),
  types: z.array(z.string().max(100)).max(20).optional(),
  states: z.array(z.string().max(100)).max(30).optional(),
  openOnly: z.boolean().default(true).describe('Hide items whose state is Completed or Removed (default on)'),
  areas: z.array(z.string().max(300)).max(20).optional(),
  teams: z.array(z.string().max(300)).max(20).optional().describe('"Project\\\\Team" names'),
  iterations: z.array(z.string().max(300)).max(20).optional().describe('Iteration paths, or "@current"'),
  assigned: z.string().max(200).optional().describe('A unique name (email), or "me"'),
  createdBy: z.string().max(200).optional().describe('A unique name (email), or "me"'),
  changedWithinDays: z.number().int().min(1).max(3650).optional(),
  tags: z.array(z.string().max(100)).max(20).optional(),
  parent: z.string().max(100).optional().describe('Only items under this parent id'),
  mine: z.union([z.boolean(), z.array(z.enum(['ASSIGNED', 'CREATED', 'CHANGED', 'MENTIONED', 'FOLLOWED']))]).optional()
    .describe('true: assigned to, created by, changed by, mentioning or followed by "me"; or a list of those sources'),
  sort: z.enum(['CHANGED', 'ID', 'PRIORITY']).default('CHANGED'),
  page: z.number().int().min(0).default(0),
  pageSize: z.number().int().min(1).max(50).default(50),
};

export function register(server: McpServer, client: AlfredClient): void {
  // ------------------------------------------------------------------------------------------------------ reads

  server.registerTool('team_search', {
    description: 'Search the team\'s tracker (Azure DevOps) LIVE: text plus filters (types, states, areas, teams, iterations or @current, '
      + 'assigned/createdBy incl. "me", changed within, tags, parent, mine). Open only by default. Each row says where it already sits in Alfred. '
      + '50 a page. Nothing found is stored. Needs the user\'s token to be live (TOKEN_MISSING otherwise).',
    inputSchema: { conn: Conn, ...SearchFilters },
  }, (input) => run(async () => {
    const c = await pickConnection(client, input.conn);
    const { conn: _c, mine, ...rest } = input;
    const body = { ...rest, mine: mine === true ? ['ASSIGNED', 'CREATED', 'CHANGED', 'MENTIONED', 'FOLLOWED'] : mine === false ? [] : mine ?? [] };
    const r = await live(() => client.post<SearchPage>(`/teamboards/connections/${seg(c.id)}/search`, { body, ...AS_CLAUDE }));
    const pages = Math.max(1, Math.ceil(r.total / Math.max(1, r.pageSize)));
    return ok({ connection: c.name, total: r.total, page: `${r.page + 1} of ${pages}`, ...(r.fullText ? {} : { note: 'No full-text search here: titles were matched' }),
      items: r.items.map(rowLine), ...(r.page + 1 < pages ? { more: `page ${r.page + 1}` } : {}) });
  }));

  server.registerTool('team_query', {
    description: 'Run a WIQL query (SELECT only) on the tracker LIVE, up to 200 items. For what team_search filters cannot say.',
    inputSchema: { conn: Conn, wiql: z.string().min(10).max(32000), max: z.number().int().min(1).max(200).default(200) },
  }, (input) => run(async () => {
    const c = await pickConnection(client, input.conn);
    const r = await live(() => client.post<SearchPage>(`/teamboards/connections/${seg(c.id)}/query`, { body: { wiql: input.wiql, max: input.max }, ...AS_CLAUDE }));
    return ok({ total: r.total, items: r.items.map(rowLine) });
  }));

  server.registerTool('team_item', {
    description: 'One work item read LIVE: every field (HTML as text; long fields in parts with field + offset, never cut), links, '
      + 'comments, attachments by name, and where it sits in Alfred. For an item Alfred keeps in full (a board\'s main or a card\'s item) '
      + 'also what changed since the saved copy. include: comments, history, attachments.',
    inputSchema: {
      conn: Conn,
      id: Id,
      include: z.array(z.enum(['comments', 'history', 'attachments'])).default(['comments', 'attachments']),
      field: z.string().min(1).max(300).optional().describe('Read one field in parts (with offset)'),
      seed: z.boolean().default(false).describe('The item as a board seed (/alfred-setup): purpose, steps, acceptance, context by the field maps, '
        + 'the parent acceptance, children, attachments - from the copy Alfred keeps, else live'),
      part: z.enum(SEED_PARTS).optional().describe('With seed: read one long seed part in parts (with offset)'),
      offset: z.number().int().min(0).default(0),
    },
  }, (input) => run(async () => {
    const ref = itemRef(input.id);
    const c = await pickConnection(client, input.conn ?? ref.conn);
    if (input.seed || input.part) {
      const s = await live(() => client.get<SeedRow>(`/teamboards/items/${seg(c.id)}/${seg(ref.id)}/seed`, AS_CLAUDE));
      if (input.part) return ok({ part: input.part, ...chunkText(s[input.part] ?? '', input.offset, 12_000) });
      const seed: Record<string, string | null> = {};
      for (const p of SEED_PARTS) {
        const v = s[p];
        if (!v) { seed[p] = null; continue; }
        const head = chunkText(v, 0, FIELD_PART);
        seed[p] = head.nextOffset === null ? v : `${head.text} [… ${head.totalLength - head.length} more characters: team_item seed part "${p}" offset ${head.nextOffset}]`;
      }
      return ok({ item: `${s.item.extId} · ${s.item.type} · "${s.item.title}" · ${s.item.state ?? '-'}`, conn: c.id, provider: s.provider, url: s.item.url,
        board: s.board ?? 'none', seed, children: s.children, links: s.links.map((l) => `${l.kind} → ${l.toId}`),
        attachments: s.attachments.map((a) => `${a.name} (${a.size >= 0 ? a.size + ' bytes' : 'size unknown'})${a.held ? ' · on the board' : ''}`) });
    }
    const v = await live(() => client.get<ItemView>(`/teamboards/connections/${seg(c.id)}/items/${seg(ref.id)}`,
      { query: { include: input.include.join(',') }, ...AS_CLAUDE }));
    if (input.field) {
      const raw = v.item.fields[input.field];
      if (raw === undefined) throw notFound(`Item ${ref.id} has no field ${input.field}. Fields: ${Object.keys(v.item.fields).join(', ')}`);
      return ok({ field: input.field, ...chunkText(plain(raw), input.offset, 12_000) });
    }
    const i = v.item;
    return ok({
      item: `${i.extId} · ${i.type} · "${i.title}" · ${i.state ?? '-'} (${v.stateCategory ?? '?'})`, conn: c.id, url: i.url, rev: i.rev,
      assigned: person(i.identities['assigned']), area: i.area, iteration: i.sprint, changed: `${i.changedAt ?? '-'} by ${person(i.identities['changed'])}`,
      inAlfred: badges(v.boards, v.cards.map((x) => x.cardId)).replace(/^ · in Alfred: /, '') || 'nowhere',
      ...(v.copyRev !== null ? { savedCopy: `rev ${v.copyRev}`, changedSinceCopy: (v.diff ?? []).map((d) => `${d.field}: ${plain(d.from ?? '') || '-'} → ${plain(d.to ?? '') || '-'}`) } : {}),
      fields: fieldsOf(i.fields),
      links: i.links.map((l) => `${l.kind} → ${l.toId}`),
      ...(v.comments ? { comments: v.comments.map((x) => `${x.at ?? ''} ${x.by ?? ''}: ${plain(x.text)}`) } : {}),
      ...(v.history ? { history: v.history.map((h) => `rev ${h.rev} ${h.at ?? ''} ${h.by ?? ''}: ${h.changes.map((ch) => ch.field).join(', ')}`) } : {}),
      ...(v.attachments ? { attachments: v.attachments.map((a) => `${a.name} (${a.mime}, ${a.size} bytes) - team_attachment to read`) } : {}),
    });
  }));

  server.registerTool('team_items_live', {
    description: 'Up to 200 work items read LIVE in one call (fields only by default): id, type, title, state, assigned, where they sit in Alfred.',
    inputSchema: { conn: Conn, ids: z.array(z.string().min(1).max(100)).min(1).max(200), include: z.array(z.enum(['comments', 'history', 'attachments'])).default([]) },
  }, (input) => run(async () => {
    const c = await pickConnection(client, input.conn);
    const ids = input.ids.map((x) => itemRef(x).id);
    const views = await live(() => client.post<ItemView[]>(`/teamboards/connections/${seg(c.id)}/items`, { body: { ids, include: input.include.join(',') }, ...AS_CLAUDE }));
    return ok({ items: views.map((v) => `${v.item.extId} · ${v.item.type} · "${v.item.title}" · ${v.item.state ?? '-'} · ${person(v.item.identities['assigned'])}`
      + badges(v.boards, v.cards.map((x) => x.cardId))), missing: ids.filter((id) => !views.some((v) => v.item.extId === id)) });
  }));

  server.registerTool('team_tree', {
    description: 'The tree of a board\'s main item as Alfred keeps it (ancestors, descendants, one hop of links, items added by hand; '
      + 'full copy or reference, changed since the copy) - or, for an item on no board, its links read live.',
    inputSchema: { board: z.string().min(1).max(200).optional(), conn: Conn, id: Id.optional() },
  }, (input) => run(async () => {
    if (input.board) {
      const v = await client.get<BoardItemsView>(`/teamboards/boards/${seg(input.board)}/items`);
      return ok({ board: input.board, main: v.main ? boardItemLine(v.main) : 'none', syncedAt: v.syncedAt ?? 'never',
        items: v.items.map(boardItemLine) });
    }
    if (!input.id) throw invalid('Pass board, or conn + id');
    const ref = itemRef(input.id);
    const c = await pickConnection(client, input.conn ?? ref.conn);
    const v = await live(() => client.get<ItemView>(`/teamboards/connections/${seg(c.id)}/items/${seg(ref.id)}`, { query: { include: '' }, ...AS_CLAUDE }));
    const ids = v.item.links.map((l) => l.toId).slice(0, 200);
    const linked = ids.length ? await live(() => client.post<ItemView[]>(`/teamboards/connections/${seg(c.id)}/items`, { body: { ids, include: '' }, ...AS_CLAUDE })) : [];
    return ok({ item: `${v.item.extId} · ${v.item.type} · "${v.item.title}"`,
      links: v.item.links.map((l) => {
        const o = linked.find((x) => x.item.extId === l.toId);
        return `${l.kind} → ${l.toId}${o ? ` · ${o.item.type} · "${o.item.title}" · ${o.item.state ?? '-'}` : ''}`;
      }) });
  }));

  server.registerTool('team_attachment', {
    description: 'Read one attachment of a work item LIVE: text files as text (in parts), others by type and size. At most 10 MB.',
    inputSchema: { conn: Conn, id: Id, name: z.string().min(1).max(300), offset: z.number().int().min(0).default(0) },
  }, (input) => run(async () => {
    const ref = itemRef(input.id);
    const c = await pickConnection(client, input.conn ?? ref.conn);
    const f = await live(() => client.bytes(`/teamboards/connections/${seg(c.id)}/items/${seg(ref.id)}/attachments/${seg(input.name)}`));
    if (f.data.length > 10 * 1024 * 1024) return ok({ name: input.name, type: f.mime, size: f.data.length, note: 'Over 10 MB - not read' });
    const textual = /^text\/|json|xml|csv|yaml|javascript/.test(f.mime);
    if (!textual) return ok({ name: input.name, type: f.mime, size: f.data.length, note: 'Binary - not shown as text' });
    return ok({ name: input.name, type: f.mime, ...chunkText(f.data.toString('utf8'), input.offset, 12_000) });
  }));

  server.registerTool('team_people', {
    description: 'People of the tracker\'s organisation by name (from the lists Alfred keeps), or one person\'s card (teams, open items '
      + 'assigned, Alfred cards they own or are mentioned on), and who "me" is. Mention a person in board text as @[person:<conn>/<id>|Name].',
    inputSchema: { conn: Conn, query: z.string().max(200).optional(), id: z.string().max(200).optional() },
  }, (input) => run(async () => {
    const c = await pickConnection(client, input.conn);
    const me = await client.get<{ person: Person; source: string } | null>(`/teamboards/connections/${seg(c.id)}/me`).catch(() => null);
    if (input.id) {
      const p = await client.get<{ person: Person; me: boolean; teams: { name: string }[]; assignedOpen: number | null;
        cardsOwned: { project: string; number: number; title: string }[]; cardsMentioning: { project: string; number: number; title: string }[]; boards: string[] }>(
        `/teamboards/connections/${seg(c.id)}/people/${seg(input.id)}`);
      return ok({ person: person(p.person), mention: `@[person:${c.id}/${p.person.extId ?? input.id}|${p.person.name}]`, me: p.me,
        teams: p.teams.map((t) => t.name), assignedOpen: p.assignedOpen ?? 'unknown (no token live)',
        cardsOwned: p.cardsOwned.map((x) => `${x.project}#${x.number} ${x.title}`), cardsMentioning: p.cardsMentioning.map((x) => `${x.project}#${x.number} ${x.title}`),
        boards: p.boards });
    }
    const all = await client.get<Person[]>(`/teamboards/connections/${seg(c.id)}/people`);
    const q = (input.query ?? '').toLowerCase();
    const hits = all.filter((p) => !q || p.name.toLowerCase().includes(q) || (p.email ?? '').toLowerCase().includes(q)).slice(0, 100);
    return ok({ me: me ? `${person(me.person)} (${me.source === 'OVERRIDE' ? 'picked as "This is me"' : 'the token owner'})` : 'unknown - no token live',
      people: hits.map((p) => `${person(p)} · id ${p.extId ?? '-'}`), total: hits.length });
  }));

  server.registerTool('team_board_items', {
    description: 'A board\'s related work items: its main (full copy), card items (full copies) and references, each with whether it '
      + 'changed since the copy, and the cards linked to it.',
    inputSchema: { board: z.string().min(1).max(200) },
  }, (input) => run(async () => {
    const v = await client.get<BoardItemsView>(`/teamboards/boards/${seg(input.board)}/items`);
    const all = v.main ? [v.main, ...v.items.filter((i) => i.row.item !== v.main!.row.item)] : v.items;
    return ok({ board: input.board, main: v.main ? boardItemLine(v.main) : 'none - the user adds one (Related items, or Start)',
      cardItems: all.filter((i) => i.row.role === 'CARD').map(boardItemLine), references: all.filter((i) => i.row.role === 'REF').map(boardItemLine),
      syncedAt: v.syncedAt ?? 'never' });
  }));

  server.registerTool('team_card_items', {
    description: 'The work items a card is linked to (many to many), from Alfred\'s saved copies: state, changed since the copy, closed '
      + 'in the tracker, and the tracker\'s comments on them.',
    inputSchema: { ...Card },
  }, (input) => run(async () => {
    const card = await cardByNumber(client, input.project, input.number);
    const rows = await client.get<CardItemRow[]>(`/teamboards/cards/${seg(card.id)}/items`);
    return ok({ card: `#${card.number} ${card.title}`, items: rows.map((i) => ({
      item: `${i.conn}/${i.item} · ${i.type ?? ''} · "${i.title}" · ${i.state ?? '-'}${i.changed ? ' · CHANGED since the copy' : ''}${i.closedInAzure ? ' · CLOSED in the tracker' : ''}`,
      url: i.url, comments: i.comments.map((c) => `${c.at ?? ''} ${c.by ?? ''}: ${plain(c.text)}`),
    })) });
  }));

  server.registerTool('team_incoming', {
    description: 'A board\'s Incoming lane: work items waiting for a decision (new in the main\'s tree, watch rule, hook, by hand), each with '
      + 'its closest card and any proposal. Propose with team_propose_card; the user decides.',
    inputSchema: { board: z.string().min(1).max(200) },
  }, (input) => run(async () => {
    const rows = await client.get<IncomingRow[]>(`/teamboards/boards/${seg(input.board)}/incoming`);
    return ok({ waiting: rows.filter((r) => r.state === 'WAITING').map((r) => `${r.conn}/${r.item} · ${r.type ?? ''} · "${r.title ?? ''}" · from ${r.source.toLowerCase()}`
      + (r.matchCard ? ` · looks like ${r.matchCard} (${r.matchScore})` : '') + (r.proposalAction ? ` · proposed ${r.proposalAction}${r.proposalCard ? ' ' + r.proposalCard : ''}` : '')) });
  }));

  server.registerTool('team_watch_rules', {
    description: 'A board\'s watch rules: saved searches whose new matches land once in its Incoming.',
    inputSchema: { board: z.string().min(1).max(200) },
  }, (input) => run(async () => {
    const rows = await client.get<{ id: number; name: string; queryJson: string; lastRunAt: string | null; lastNew: number }[]>(
      `/teamboards/boards/${seg(input.board)}/watch-rules`);
    return ok({ rules: rows.map((r) => `${r.id} · ${r.name} · ${r.queryJson} · ${r.lastRunAt ? `ran ${r.lastRunAt}, ${r.lastNew} new` : 'not run yet'}`) });
  }));

  // --------------------------------------------------------------------------------- writes (consent bundles)

  server.registerTool('team_board_link', {
    description: 'Add a work item to a board (asMain: as its main item, with its tree). Without askedIn this is a proposal the user approves.',
    inputSchema: { board: z.string().min(1).max(200), conn: Conn, id: Id, asMain: z.boolean().default(false), askedIn: AskedIn },
  }, (input) => run(async () => {
    const ref = itemRef(input.id);
    const c = await pickConnection(client, input.conn ?? ref.conn);
    try {
      const v = await live(() => client.post<BoardItemsView>(`/teamboards/boards/${seg(input.board)}/items`,
        { body: { conn: c.id, item: ref.id, asMain: input.asMain, askedIn: input.askedIn }, ...AS_CLAUDE }));
      return ok({ added: `${c.id}/${ref.id} → ${input.board}${input.asMain ? ' as main' : ''}`, main: v.main ? boardItemLine(v.main) : 'none', items: v.items.length });
    } catch (e) {
      if (e instanceof AlfredError && e.code === 'CONFLICT') return ok({ result: 'proposed', note: e.message + ' - it waits for the user on the board.' });
      throw e;
    }
  }));

  server.registerTool('team_board_unlink', {
    description: 'Removing an item from a board is the user\'s: this tells you so. Propose it to the user in the board chat instead.',
    inputSchema: { board: z.string().min(1).max(200), conn: Conn, id: Id },
  }, (input) => run(async () => {
    const ref = itemRef(input.id);
    const c = await pickConnection(client, input.conn ?? ref.conn);
    await client.del(`/teamboards/boards/${seg(input.board)}/items/${seg(c.id)}/${seg(ref.id)}`, AS_CLAUDE);
    return ok({ removed: `${c.id}/${ref.id}` });
  }));

  server.registerTool('team_link_card', {
    description: 'Link a card to a work item (many to many). Alfred links it at once only when the user asked (askedIn); otherwise it is a '
      + 'proposal. The tracker markers (hyperlink back, comment, tag) always wait for the user\'s approval as a bundle.',
    inputSchema: { ...Card, conn: Conn, id: Id, hyperlink: z.boolean().default(true), comment: z.boolean().default(false), tag: z.boolean().default(false),
      askedIn: AskedIn },
  }, (input) => run(async () => {
    const ref = itemRef(input.id);
    const c = await pickConnection(client, input.conn ?? ref.conn);
    const card = await cardByNumber(client, input.project, input.number);
    const r = await live(() => client.post<{ items: CardItemRow[]; bundle: BundleRow | null }>(`/teamboards/cards/${seg(card.id)}/items`,
      { body: { conn: c.id, item: ref.id, markers: { hyperlink: input.hyperlink, comment: input.comment, tag: input.tag }, askedIn: input.askedIn }, ...AS_CLAUDE }));
    return ok({ card: `#${card.number}`, linked: r.items.some((i) => i.item === ref.id) ? `${c.id}/${ref.id}` : 'not yet - waits for the user',
      ...(r.bundle ? bundleReply(r.bundle) : {}) });
  }));

  server.registerTool('team_unlink_card', {
    description: 'Unlinking a card from a work item is the user\'s: this tells you so. Propose it in the card instead.',
    inputSchema: { ...Card, conn: Conn, id: Id },
  }, (input) => run(async () => {
    const ref = itemRef(input.id);
    const c = await pickConnection(client, input.conn ?? ref.conn);
    const card = await cardByNumber(client, input.project, input.number);
    await client.del(`/teamboards/cards/${seg(card.id)}/items/${seg(c.id)}/${seg(ref.id)}`, AS_CLAUDE);
    return ok({ unlinked: `${c.id}/${ref.id}` });
  }));

  server.registerTool('team_create_item', {
    description: 'Prepare a new work item from a card (type, title, description defaults to the card\'s): a bundle the user approves; '
      + 'it is linked to the card once created. Epics and Features are the team\'s to create.',
    inputSchema: { ...Card, conn: Conn, type: z.string().min(1).max(200), title: z.string().min(1).max(255), description: z.string().max(64_000).optional(),
      area: z.string().max(300).optional(), iteration: z.string().max(300).optional(), assignee: z.string().max(200).optional() },
  }, (input) => run(async () => {
    const c = await pickConnection(client, input.conn);
    const card = await cardByNumber(client, input.project, input.number);
    const b = await client.post<BundleRow>(`/teamboards/cards/${seg(card.id)}/create`, { body: { conn: c.id, type: input.type, title: input.title,
      description: input.description, area: input.area, iteration: input.iteration, assignee: input.assignee }, ...AS_CLAUDE });
    return ok(bundleReply(b));
  }));

  async function step(input: { conn?: string; id: string; board?: string; project?: string; number?: number; askedIn?: string; extend?: number },
                      kind: 'STATE' | 'COMMENT', payload: Record<string, string>) {
    const ref = itemRef(input.id);
    const c = await pickConnection(client, input.conn ?? ref.conn);
    const card = input.number ? await cardByNumber(client, input.project ?? '', input.number) : null;
    if (!card && !input.board && !input.extend) {
      throw new Error('Name the card (project + number) or the board this change is for: the user approves it there');
    }
    if (input.extend) {
      const b = await client.post<BundleRow>('/teamboards/writes', { body: { conn: c.id, item: ref.id, card: card?.id ?? null, board: input.board ?? null,
        steps: [{ kind, payload, ticked: true, unmasked: false }], askedIn: input.askedIn, extend: input.extend }, ...AS_CLAUDE });
      return ok(bundleReply(b));
    }
    const body = kind === 'STATE' ? { state: payload['state'] } : { comment: payload['text'] };
    const b = await client.patch<BundleRow>(`/teamboards/connections/${seg(c.id)}/items/${seg(ref.id)}`,
      { body: { ...body, card: card?.id ?? null, board: input.board ?? null, askedIn: input.askedIn }, ...AS_CLAUDE });
    return ok(bundleReply(b));
  }

  server.registerTool('team_comment', {
    description: 'Prepare a comment on a work item (Alfred adds the "via Alfred" footer). Name the card (project + number) or the board: the user approves '
      + 'the bundle there - never sent by you. No secrets, tokens or raw request bodies in the text; evidence files are built (masked) by the user\'s browser on the card.',
    inputSchema: { conn: Conn, id: Id, text: z.string().min(1).max(64_000), board: z.string().min(1).max(200).optional(), project: Card.project.optional(), number: Card.number.optional(), askedIn: AskedIn,
      extend: Extend },
  }, (input) => run(() => step(input, 'COMMENT', { text: input.text })));

  server.registerTool('team_move_state', {
    description: 'Prepare a state change of a work item (e.g. Resolved). Name the card (project + number) or the board: the user approves the bundle there - never sent by you.',
    inputSchema: { conn: Conn, id: Id, state: z.string().min(1).max(200), board: z.string().min(1).max(200).optional(), project: Card.project.optional(), number: Card.number.optional(), askedIn: AskedIn,
      extend: Extend },
  }, (input) => run(() => step(input, 'STATE', { state: input.state })));

  // --------------------------------------------------------------------------------------- proposals and runs

  server.registerTool('team_propose_card', {
    description: 'Propose what to do with an Incoming item: NEW (a new card) or LINK (to an existing card id), with your reason. '
      + 'The user accepts or not. Read board_similar first.',
    inputSchema: { board: z.string().min(1).max(200), conn: Conn, id: Id, action: z.enum(['NEW', 'LINK']), cardId: z.string().max(100).optional(),
      reason: z.string().min(1).max(2000) },
  }, (input) => run(async () => {
    const ref = itemRef(input.id);
    const c = await pickConnection(client, input.conn ?? ref.conn);
    if (input.action === 'LINK' && !input.cardId) throw invalid('LINK names the card (cardId)');
    await client.post(`/teamboards/boards/${seg(input.board)}/incoming/${seg(c.id)}/${seg(ref.id)}/proposal`,
      { body: { action: input.action, cardId: input.cardId, reason: input.reason }, ...AS_CLAUDE });
    return ok({ proposed: `${input.action}${input.cardId ? ' ' + input.cardId : ''} for ${c.id}/${ref.id}`, note: 'It waits in Incoming for the user.' });
  }));

  server.registerTool('team_refresh_item', {
    description: 'Sync a board now (its main, card items and tree; diffs saved, new children offered in Incoming) - or read one item live '
      + 'with what changed since Alfred\'s copy.',
    inputSchema: { board: z.string().min(1).max(200).optional(), conn: Conn, id: Id.optional() },
  }, (input) => run(async () => {
    if (input.board) {
      await live(() => client.post(`/teamboards/boards/${seg(input.board!)}/sync`, { body: { force: true }, ...AS_CLAUDE }));
      return ok({ syncing: input.board, note: 'Runs in the background; read team_board_items in a moment.' });
    }
    if (!input.id) throw invalid('Pass board, or conn + id');
    const ref = itemRef(input.id);
    const c = await pickConnection(client, input.conn ?? ref.conn);
    const v = await live(() => client.get<ItemView>(`/teamboards/connections/${seg(c.id)}/items/${seg(ref.id)}`, { query: { include: '' }, ...AS_CLAUDE }));
    return ok({ item: `${v.item.extId} · ${v.item.state ?? '-'} · rev ${v.item.rev}`, savedCopy: v.copyRev ?? 'none',
      changedSinceCopy: (v.diff ?? []).map((d) => `${d.field}: ${plain(d.from ?? '') || '-'} → ${plain(d.to ?? '') || '-'}`) });
  }));

  server.registerTool('team_watch_run', {
    description: 'Run a board\'s watch rules now; new matches land once in its Incoming.',
    inputSchema: { board: z.string().min(1).max(200) },
  }, (input) => run(async () => {
    const r = await live(() => client.post<{ new: number }>(`/teamboards/boards/${seg(input.board)}/watch-rules/run`, AS_CLAUDE));
    return ok({ newInIncoming: r.new });
  }));

  server.registerTool('team_link', {
    description: 'Make a work item the main item of a board (/alfred-setup does this last after a Start). Alfred keeps its full copy and '
      + 'tree, so the board shows what changes later, and moves the attachments the Start fetched onto the board.',
    inputSchema: {
      board: z.string().min(1).max(200),
      id: Id,
      conn: Conn,
      askedIn: z.string().min(1).max(40).optional().describe('Only when no Start waits for the item: the chat message id (or "terminal") where the user asked'),
    },
  }, (input) => run(async () => {
    const ref = itemRef(input.id);
    const c = await pickConnection(client, input.conn ?? ref.conn);
    const r = await live(() => client.put<{ attached: string[]; notAttached: string[] }>(`/teamboards/links/${seg(input.board)}`,
      { body: { conn: c.id, extId: ref.id, askedIn: input.askedIn }, ...AS_CLAUDE }));
    return ok({ main: `${input.board} ★ ${c.id}/${ref.id}`, attached: r.attached, notAttached: r.notAttached,
      ...(r.notAttached.length ? { note: 'List the files not attached in the brief by name; the user fetches them with "Fetch attachments".' } : {}) });
  }));

  server.registerTool('team_start', {
    description: 'Start a board from a work item - the same as the Start button - ONLY when the user asked for it (in a board chat or '
      + 'this terminal); askedIn is the id of that chat message or "terminal". It posts /alfred-setup for the item in the chat of the mapped board. '
      + 'Without a mapping it answers NEEDS_TARGET: ask the user which project (and board), then pass project/board. Never start on your own.',
    inputSchema: {
      id: Id,
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
}
