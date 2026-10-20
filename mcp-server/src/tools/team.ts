import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { AlfredError, seg, type AlfredClient, type RequestOptions } from '../alfred-client.ts';
import { chunkText, invalid, notFound, ok, run } from '../reply.ts';
import { cardByNumber } from './board.ts';
import { boardIdOf } from '../board-ref.ts';

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
  readonly parent?: string | null;
}

interface SearchPage {
  readonly items: readonly SearchRow[];
  readonly total: number;
  readonly fullText: boolean;
  readonly page: number;
  readonly pageSize: number;
  readonly context?: readonly SearchRow[];
  readonly contextLeftOut?: number;
}

/**
 * Matches and their context as indented lines (specs/029): a row under its parent when the parent is on the page;
 * context rows end with "(parent)" or "(child)" - they did not match the search.
 */
export function treeText(items: readonly SearchRow[], context: readonly SearchRow[]): string[] {
  const all = new Map<string, SearchRow>();
  for (const r of [...items, ...context]) if (!all.has(r.id)) all.set(r.id, r);
  const matches = new Set(items.map((i) => i.id));
  const kids = new Map<string, string[]>();
  const roots: string[] = [];
  for (const [id, r] of all) {
    if (r.parent && r.parent !== id && all.has(r.parent)) kids.set(r.parent, [...(kids.get(r.parent) ?? []), id]);
    else roots.push(id);
  }
  const above = new Set<string>();
  for (const id of matches) {
    let p = all.get(id)?.parent;
    for (let hop = 0; p && all.has(p) && !above.has(p) && hop < 50; hop++) {
      above.add(p);
      p = all.get(p)?.parent;
    }
  }
  const out: string[] = [];
  const seen = new Set<string>();
  const walk = (id: string, depth: number) => {
    if (seen.has(id)) return;
    seen.add(id);
    const tag = matches.has(id) ? '' : above.has(id) ? ' (parent)' : ' (child)';
    out.push('  '.repeat(depth) + rowLine(all.get(id)!) + tag);
    (kids.get(id) ?? []).forEach((k) => walk(k, depth + 1));
  };
  roots.forEach((id) => walk(id, 0));
  return out;
}

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

/** POST /teamboards/boards/{board}/sync with wait (specs/030): what Refresh from Azure found. */
export interface SyncResultRow {
  readonly boardId: string; readonly checked: number; readonly changed: number; readonly newInTree: number; readonly leftTree: number;
  readonly skipped: boolean;
  readonly newItems?: readonly { conn: string; item: string; type: string | null; title: string | null; state: string | null }[];
  readonly changedItems?: readonly { conn: string; item: string; title: string | null; fields: readonly string[]; newComments: number }[];
  readonly mainState?: { conn: string; item: string; fromState: string | null; toState: string | null; category: string | null; closed: boolean;
    fromIteration: string | null; toIteration: string | null } | null;
  readonly matches?: number;
}

/** The refresh result as lines Claude reads: counts, then each new or changed item, the main's move and the matches. */
export function syncText(board: string, r: SyncResultRow): Record<string, unknown> {
  const m = r.mainState;
  return {
    board,
    summary: `${r.changed} changed · ${r.newInTree} new in the tree · ${r.leftTree} left the tree · ${r.matches ?? 0} possible card matches`,
    newItems: (r.newItems ?? []).map((i) => `${i.conn}/${i.item} · ${i.type ?? ''} · "${i.title ?? ''}" · ${i.state ?? '-'} (waits in Incoming)`),
    changedItems: (r.changedItems ?? []).map((i) => `${i.conn}/${i.item} "${i.title ?? ''}": ${i.fields.join(', ') || 'fields'}`
      + (i.newComments ? ` · ${i.newComments} new comment(s)` : '')),
    ...(m ? { mainMoved: `${m.conn}/${m.item}: ${m.fromState ?? '-'} → ${m.toState ?? '-'}${m.category ? ` (${m.category})` : ''}`
      + (m.fromIteration !== m.toIteration ? ` · iteration ${m.fromIteration ?? '-'} → ${m.toIteration ?? '-'}` : '')
      + (m.closed ? ' · CLOSED in the tracker: propose closing the open cards as Not in this flow; the user decides' : '') } : {}),
    ...(r.matches ? { next: 'team_card_matches on each unlinked card: judge the proposals and write why.' } : {}),
  };
}

interface MatchRow {
  readonly row: { readonly conn: string; readonly item: string; readonly state: string; readonly why: string | null; readonly score: number };
  readonly type: string | null; readonly title: string; readonly state: string | null;
}

interface IncomingRow {
  readonly conn: string; readonly item: string; readonly source: string; readonly type: string | null; readonly title: string | null;
  readonly matchCard: string | null; readonly matchScore: number | null; readonly proposalAction: string | null; readonly proposalCard: string | null;
  readonly proposalReason: string | null; readonly state: string;
}

interface BundleRow { readonly id: number; readonly title: string; readonly state: string;
  readonly steps: readonly { kind: string; ticked: boolean; payload?: Record<string, string>; result?: unknown }[] }

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
  readonly childItems?: readonly SeedChildRow[];
  readonly parents?: readonly SeedParentRow[];
  readonly comments?: readonly SeedCommentRow[];
}

interface SeedCommentRow { readonly by: string | null; readonly at: string | null; readonly text: string }
interface SeedChildRow {
  readonly id: string; readonly type: string; readonly title: string; readonly state: string | null; readonly category: string | null;
  readonly done: boolean; readonly assignee: string | null; readonly url: string | null;
  readonly purpose: string | null; readonly steps: string | null; readonly acceptance: string | null; readonly context: string | null;
  readonly comments: readonly SeedCommentRow[]; readonly grandchildren: readonly string[];
}
interface SeedParentRow {
  readonly id: string; readonly type: string | null; readonly title: string | null; readonly state: string | null; readonly url: string | null;
  readonly purpose: string | null; readonly acceptance: string | null;
}

function commentsText(cs: readonly SeedCommentRow[], indent = ''): string[] {
  return cs.map((c) => `${indent}- ${c.by ?? 'someone'}${c.at ? ' (' + c.at.slice(0, 10) + ')' : ''}: ${plain(c.text)}`);
}

/** Every child in full as one text (specs/030): a section per child with its parts, comments and its own children. */
export function seedChildrenText(kids: readonly SeedChildRow[]): string {
  return kids.map((k) => {
    const out = [`### ${k.id} · ${k.type} · ${k.title} · ${k.state ?? '-'}${k.done ? ' · DONE in the tracker' : ''}${k.assignee ? ' · ' + k.assignee : ''}`];
    for (const [name, v] of [['Purpose', k.purpose], ['Steps', k.steps], ['Acceptance', k.acceptance], ['Context', k.context]] as const) {
      if (v) out.push(`${name}:`, plain(v));
    }
    if (k.comments.length) out.push('Comments:', ...commentsText(k.comments, '  '));
    if (k.grandchildren.length) out.push('Its children: ' + k.grandchildren.join('; '));
    return out.join('\n');
  }).join('\n\n');
}

/** The parent chain, nearest first, up to the top. */
export function seedParentsText(ps: readonly SeedParentRow[]): string {
  return ps.map((p, i) => {
    const out = [`### ${'up '.repeat(i + 1).trim()} · ${p.id} · ${p.type ?? '?'} · ${p.title ?? '(not readable)'} · ${p.state ?? '-'}`];
    if (p.purpose) out.push('Purpose:', plain(p.purpose));
    if (p.acceptance) out.push('Acceptance:', plain(p.acceptance));
    return out.join('\n');
  }).join('\n\n');
}

const AS_CLAUDE: Pick<RequestOptions, 'headers'> = { headers: { 'X-Alfred-Actor': 'claude' } };
const SEED_PARTS = ['purpose', 'steps', 'acceptance', 'context', 'parentAcceptance'] as const;
/** Read in parts like the fields: every child in full, the parent chain, the item's own comments (specs/030). */
const SEED_TREE_PARTS = ['children', 'parents', 'comments'] as const;

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

/** One state of a type, as the connection's lists give it (category: Proposed, InProgress, Resolved, Completed, Removed). */
export interface StateRow { readonly type: string; readonly name: string; readonly category: string }

const CATEGORY_OF: Record<string, string> = { resolved: 'Resolved', closed: 'Completed', done: 'Completed', removed: 'Removed',
  active: 'InProgress', new: 'Proposed', proposed: 'Proposed' };

/**
 * The state to propose for an item of {@code type} (specs/030 FR-012): the one asked when the type has it, else the first of
 * the type's states in the same category (Resolved falls back to Completed), with a note saying so. Unknown lists: as asked.
 */
export function pickState(wanted: string, type: string | null, states: readonly StateRow[]): { state: string; note?: string } {
  const mine = type ? states.filter((s) => s.type.toLowerCase() === type.toLowerCase()) : [];
  if (!mine.length) return { state: wanted };
  const exact = mine.find((s) => s.name.toLowerCase() === wanted.trim().toLowerCase());
  if (exact) return { state: exact.name };
  const category = states.find((s) => s.name.toLowerCase() === wanted.trim().toLowerCase())?.category
    ?? CATEGORY_OF[wanted.trim().toLowerCase()] ?? null;
  const order = category === 'Resolved' ? ['Resolved', 'Completed'] : category ? [category] : [];
  for (const cat of order) {
    const hit = mine.find((s) => s.category === cat);
    if (hit) return { state: hit.name, note: `"${wanted}" is not a state of ${type} here - proposed "${hit.name}" (${cat}) instead. Say so in the bundle.` };
  }
  return { state: wanted, note: `"${wanted}" is not a state of ${type} here and no state of the same kind was found: ${mine.map((s) => s.name).join(', ')}. Ask the user which.` };
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
  areaExact: z.boolean().default(false).describe('Areas match only themselves (default: the area and its sub-areas)'),
  teams: z.array(z.string().max(300)).max(20).optional().describe('"Project\\\\Team" names'),
  iterations: z.array(z.string().max(300)).max(20).optional().describe('Iteration paths, or "@current" (each picked team\'s current sprint)'),
  assigned: z.union([z.string().max(200), z.array(z.string().max(200)).max(50)]).optional()
    .describe('Unique names (emails), "me", or "none" for unassigned - one or several (any of them)'),
  createdBy: z.union([z.string().max(200), z.array(z.string().max(200)).max(50)]).optional()
    .describe('Unique names (emails) or "me" - one or several (any of them)'),
  changedWithinDays: z.number().int().min(1).max(3650).optional(),
  tags: z.array(z.string().max(100)).max(20).optional(),
  tagsAll: z.boolean().default(false).describe('Every tag must be on the item (default: any one)'),
  parent: z.union([z.string().max(100), z.array(z.string().max(100)).max(50)]).optional()
    .describe('Only direct children of these parent ids (one or several)'),
  show: z.enum(['items', 'parents', 'tree']).default('items')
    .describe('items: the matches; parents: each under its parent chain; tree: parents and children (context items are marked)'),
  childDepth: z.number().int().min(0).max(1).default(1).describe('With show tree: 1 = one level of children, 0 = every level'),
  saved: z.string().min(1).max(80).optional()
    .describe('Run a saved search by its name (team_saved lists them); a filter given beside it replaces that filter of the saved one'),
  mine: z.union([z.boolean(), z.array(z.enum(['ASSIGNED', 'CREATED', 'CHANGED', 'MENTIONED', 'FOLLOWED']))]).optional()
    .describe('true: assigned to, created by, changed by, mentioning or followed by "me"; or a list of those sources'),
  sort: z.enum(['CHANGED', 'ID', 'PRIORITY']).default('CHANGED'),
  page: z.number().int().min(0).default(0),
  pageSize: z.number().int().min(1).max(50).default(50),
};

interface SavedRow { readonly id: number; readonly name: string; readonly query: Record<string, unknown>; readonly lastCount: number | null }

/** team_search's defaults: left as they are beside a saved search's name, they do not replace its own. */
const SEARCH_DEFAULTS: Record<string, unknown> = { openOnly: true, areaExact: false, tagsAll: false, sort: 'CHANGED', page: 0, pageSize: 50,
  childDepth: 1, show: 'ITEMS' };

/** A saved search in one line: its filters as the Team tab's chips say them. */
export function savedLine(s: SavedRow): string {
  const q = s.query;
  const parts: string[] = [];
  const add = (label: string, v: unknown, join = ' or ') => {
    const a = Array.isArray(v) ? v : typeof v === 'string' && v ? [v] : [];
    if (a.length) parts.push(`${label}: ${a.join(join)}`);
  };
  if (typeof q['text'] === 'string' && q['text']) parts.push(`"${q['text']}"`);
  add('type', q['types']);
  add('state', q['states']);
  add('team', q['teams']);
  add('iteration', q['iterations']);
  add(q['areaExact'] ? 'area (only)' : 'area', q['areas']);
  add('assigned', q['assigned']);
  add('created by', q['createdBy']);
  add('tags', q['tags'], q['tagsAll'] ? ' and ' : ' or ');
  add('under', q['parents']);
  if (q['changedWithinDays']) parts.push(`changed in ${q['changedWithinDays']} d`);
  if (q['openOnly'] === false) parts.push('closed too');
  if (q['show'] && q['show'] !== 'ITEMS') parts.push(`show ${String(q['show']).toLowerCase()}`);
  return `"${s.name}"${s.lastCount === null ? '' : ` (${s.lastCount} last time)`}: ${parts.join(' · ') || 'everything open'}`;
}

export function register(server: McpServer, client: AlfredClient): void {
  // ------------------------------------------------------------------------------------------------------ reads

  server.registerTool('team_search', {
    description: 'Search the team\'s tracker (Azure DevOps) LIVE: text plus filters, each taking several values (ORed; filters ANDed): '
      + 'types, states, areas (areaExact), teams, iterations or @current, assigned incl. "me"/"none", createdBy incl. "me", changed within, '
      + 'tags (tagsAll), parent ids, mine. Open only by default. show: items, parents or tree (matches under their parents, with children). '
      + 'Each row says where it already sits in Alfred. 50 matches a page. Nothing found is stored. Needs the user\'s token to be live '
      + '(TOKEN_MISSING otherwise).',
    inputSchema: { conn: Conn, ...SearchFilters },
  }, (input) => run(async () => {
    const c = await pickConnection(client, input.conn);
    const { conn: _c, mine, assigned, createdBy, parent, show, saved: savedName, ...rest } = input;
    const list = (v: string | string[] | undefined) => (v === undefined ? [] : Array.isArray(v) ? v : [v]);
    const asked: Record<string, unknown> = { ...rest, show: show.toUpperCase(),
      ...(assigned !== undefined ? { assigned: list(assigned) } : {}), ...(createdBy !== undefined ? { createdBy: list(createdBy) } : {}),
      ...(parent !== undefined ? { parents: list(parent) } : {}),
      ...(mine !== undefined ? { mine: mine === true ? ['ASSIGNED', 'CREATED', 'CHANGED', 'MENTIONED', 'FOLLOWED'] : mine === false ? [] : mine } : {}) };
    let body: Record<string, unknown> = { assigned: [], createdBy: [], parents: [], mine: [], ...asked };
    if (savedName) {
      const all = await client.get<SavedRow[]>(`/teamboards/connections/${seg(c.id)}/saved`, AS_CLAUDE);
      const s = all.find((x) => x.name.toLowerCase() === savedName.trim().toLowerCase());
      if (!s) {
        throw new Error(`No saved search "${savedName}" - ${all.length ? 'saved: ' + all.map((x) => `"${x.name}"`).join(', ') : 'none saved yet (the user saves them in the Team tab)'}`);
      }
      // what was given beside the name replaces that filter; a default left as it is keeps the saved one's
      const given = Object.fromEntries(Object.entries(asked).filter(([k, v]) => v !== undefined && !(k in SEARCH_DEFAULTS && SEARCH_DEFAULTS[k] === v)));
      body = { ...s.query, ...given, page: input.page, saved: s.id };
    }
    const r = await live(() => client.post<SearchPage>(`/teamboards/connections/${seg(c.id)}/search`, { body, ...AS_CLAUDE }));
    const pages = Math.max(1, Math.ceil(r.total / Math.max(1, r.pageSize)));
    const head = { connection: c.name, total: r.total, page: `${r.page + 1} of ${pages}`,
      ...(r.fullText ? {} : { note: 'No full-text search here: titles were matched' }) };
    const more = r.page + 1 < pages ? { more: `page ${r.page + 1}` } : {};
    if (body['show'] === 'ITEMS' || !r.context) return ok({ ...head, items: r.items.map(rowLine), ...more });
    return ok({ ...head, tree: treeText(r.items, r.context),
      ...(r.contextLeftOut ? { contextLeftOut: `${r.contextLeftOut} more parents/children not read (500 a page)` } : {}), ...more });
  }));

  server.registerTool('team_saved', {
    description: 'The saved searches of the Team tab (the user\'s pills): name, last count, and what each searches for. Run one with '
      + 'team_search saved: "<name>". Only the user saves, changes or deletes them.',
    inputSchema: { conn: Conn },
  }, (input) => run(async () => {
    const c = await pickConnection(client, input.conn);
    const all = await client.get<SavedRow[]>(`/teamboards/connections/${seg(c.id)}/saved`, AS_CLAUDE);
    return ok({ connection: c.name, saved: all.map(savedLine), ...(all.length ? {} : { note: 'None saved yet - the user saves searches in the Team tab (☆ Save search)' }) });
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
        + 'the parent acceptance, children, attachments - from the copy Alfred keeps, else live. Since specs/030 also every child in full '
        + '(part "children"), the parent chain up to the top (part "parents") and the item\'s comments (part "comments")'),
      part: z.enum([...SEED_PARTS, ...SEED_TREE_PARTS]).optional().describe('With seed: read one long seed part in parts (with offset)'),
      offset: z.number().int().min(0).default(0),
    },
  }, (input) => run(async () => {
    const ref = itemRef(input.id);
    const c = await pickConnection(client, input.conn ?? ref.conn);
    if (input.seed || input.part) {
      const s = await live(() => client.get<SeedRow>(`/teamboards/items/${seg(c.id)}/${seg(ref.id)}/seed`, AS_CLAUDE));
      const tree: Record<(typeof SEED_TREE_PARTS)[number], string> = {
        children: seedChildrenText(s.childItems ?? []),
        parents: seedParentsText(s.parents ?? []),
        comments: commentsText(s.comments ?? []).join('\n'),
      };
      if (input.part) {
        const text = (SEED_TREE_PARTS as readonly string[]).includes(input.part)
          ? tree[input.part as (typeof SEED_TREE_PARTS)[number]] : s[input.part as (typeof SEED_PARTS)[number]] ?? '';
        return ok({ part: input.part, ...chunkText(text, input.offset, 12_000) });
      }
      const seed: Record<string, string | null> = {};
      for (const p of [...SEED_PARTS, ...SEED_TREE_PARTS]) {
        const v = (SEED_TREE_PARTS as readonly string[]).includes(p) ? tree[p as (typeof SEED_TREE_PARTS)[number]] : s[p as (typeof SEED_PARTS)[number]];
        if (!v) { seed[p] = null; continue; }
        const head = chunkText(v, 0, FIELD_PART);
        seed[p] = head.nextOffset === null ? v : `${head.text} [… ${head.totalLength - head.length} more characters: team_item seed part "${p}" offset ${head.nextOffset}]`;
      }
      return ok({ item: `${s.item.extId} · ${s.item.type} · "${s.item.title}" · ${s.item.state ?? '-'}`, conn: c.id, provider: s.provider, url: s.item.url,
        board: s.board ?? 'none', seed, children: s.children,
        counts: { children: (s.childItems ?? []).length, done: (s.childItems ?? []).filter((k) => k.done).length, parents: (s.parents ?? []).length,
          comments: (s.comments ?? []).length }, links: s.links.map((l) => `${l.kind} → ${l.toId}`),
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
      const v = await client.get<BoardItemsView>(`/teamboards/boards/${seg(await boardIdOf(client, input.board))}/items`);
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
    const v = await client.get<BoardItemsView>(`/teamboards/boards/${seg(await boardIdOf(client, input.board))}/items`);
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

  server.registerTool('team_card_matches', {
    description: 'Work items that may be what a card with no linked item is about (specs/030): open Bug/Task/Issue items of the board\'s '
      + 'tree found by code (shared words, the same /api/ endpoint), best first, with the reason. Judge them: pass why (with id) to replace '
      + 'the code\'s reason with yours. Only the user links one or says "Not this one" (Team panel on the card); a rejected item never '
      + 'comes back. Refresh from Azure (the board sync) finds them anew.',
    inputSchema: { ...Card, id: Id.optional().describe('With why: the proposed item to judge (1234, AB#1234, <conn>/1234)'),
      why: z.string().min(1).max(2000).optional().describe('Your reason this item is (or is not) the card\'s, in a sentence or two') },
  }, (input) => run(async () => {
    const card = await cardByNumber(client, input.project, input.number);
    const base = `/teamboards/cards/${seg(card.id)}/matches`;
    let rows = await client.get<MatchRow[]>(base);
    if (input.why !== undefined) {
      if (!input.id) throw invalid('Name the proposed item to judge with id');
      const ref = itemRef(input.id);
      const m = rows.find((r) => r.row.item === ref.id && (!ref.conn || r.row.conn === ref.conn));
      if (!m) throw notFound(`Item ${input.id} is not a proposed match of card #${card.number}`);
      rows = await client.put<MatchRow[]>(`${base}/${seg(m.row.conn)}/${seg(m.row.item)}/why`, { body: { why: input.why }, ...AS_CLAUDE });
    }
    return ok({ card: `#${card.number} ${card.title}`, matches: rows.map((r) => ({
      item: `${r.row.conn}/${r.row.item} · ${r.type ?? ''} · "${r.title}" · ${r.state ?? '-'} · score ${r.row.score}`,
      why: r.row.why,
    })), ...(rows.length ? { note: 'Only the user links or rejects a match.' } : {}) });
  }));

  server.registerTool('team_incoming', {
    description: 'A board\'s Incoming lane: work items waiting for a decision (new in the main\'s tree, watch rule, hook, by hand), each with '
      + 'its closest card and any proposal. Propose with team_propose_card; the user decides.',
    inputSchema: { board: z.string().min(1).max(200) },
  }, (input) => run(async () => {
    const rows = await client.get<IncomingRow[]>(`/teamboards/boards/${seg(await boardIdOf(client, input.board))}/incoming`);
    return ok({ waiting: rows.filter((r) => r.state === 'WAITING').map((r) => `${r.conn}/${r.item} · ${r.type ?? ''} · "${r.title ?? ''}" · from ${r.source.toLowerCase()}`
      + (r.matchCard ? ` · looks like ${r.matchCard} (${r.matchScore})` : '') + (r.proposalAction ? ` · proposed ${r.proposalAction}${r.proposalCard ? ' ' + r.proposalCard : ''}` : '')) });
  }));

  server.registerTool('team_watch_rules', {
    description: 'A board\'s watch rules: saved searches whose new matches land once in its Incoming.',
    inputSchema: { board: z.string().min(1).max(200) },
  }, (input) => run(async () => {
    const rows = await client.get<{ id: number; name: string; queryJson: string; lastRunAt: string | null; lastNew: number }[]>(
      `/teamboards/boards/${seg(await boardIdOf(client, input.board))}/watch-rules`);
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
      const v = await live(async () => client.post<BoardItemsView>(`/teamboards/boards/${seg(await boardIdOf(client, input.board))}/items`,
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
    await client.del(`/teamboards/boards/${seg(await boardIdOf(client, input.board))}/items/${seg(c.id)}/${seg(ref.id)}`, AS_CLAUDE);
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

  // ------------------------------------------------------------------------------- specs/038: full writes, all approved by the user

  const FieldRef = z.string().min(3).max(200).regex(/^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z0-9_]+)+$/, 'a reference name such as Microsoft.VSTS.Common.Activity');
  const Fields = z.record(FieldRef, z.union([z.string().max(64_000), z.number(), z.boolean(), z.null()]))
    .describe('Any fields by reference name, e.g. {"Microsoft.VSTS.Common.Activity":"Development","Microsoft.VSTS.Scheduling.OriginalEstimate":16,'
      + '"Microsoft.VSTS.Scheduling.RemainingWork":16,"Microsoft.VSTS.Common.Priority":2}. team_item_type_fields lists what a type requires and allows. '
      + 'An empty value clears a field on an edit.');
  const LinkKind = z.enum(['Parent', 'Child', 'Related', 'Predecessor', 'Successor', 'Duplicate', 'Duplicate of', 'Tested by', 'Tests']);
  const Links = z.array(z.object({ kind: LinkKind, id: z.string().min(1).max(100) })).max(20);
  const Tags = z.array(z.string().min(1).max(100)).max(30);
  const Where = {
    board: z.string().min(1).max(200).optional().describe('The board where the bundle waits for the user (AB#123, its name or id) - or name a card'),
    project: Card.project.optional(), number: Card.number.optional().describe('A card: the new items are linked to it in Alfred, and the bundle waits on it'),
    askedIn: AskedIn, extend: Extend,
  };
  const NewItemShape = z.object({
    type: z.string().min(1).max(200).optional().describe('Task, Bug, User Story... (from a copy or a template when left out)'),
    title: z.string().min(1).max(255).optional(),
    description: z.string().max(64_000).optional().describe('HTML or Markdown; @[person:<id>|Name] mentions a person (team_people)'),
    parent: z.string().max(100).nullable().optional().describe('The parent item id; left out: the board\'s main item; null or "": no parent'),
    azureProject: z.string().max(200).optional().describe('The Azure project to create it in (left out: the parent\'s, else the first)'),
    area: z.string().max(300).optional(), iteration: z.string().max(300).optional(),
    assignee: z.string().max(200).optional().describe('An email / unique name'),
    fields: Fields.optional(), links: Links.optional(), tags: Tags.optional(),
    copyOf: z.string().max(100).optional().describe('Copy this item\'s writable fields (shown in full in the bundle); what you give wins'),
    template: z.string().max(80).optional().describe('Start from a saved template (team_templates); what you give wins'),
    inheritFromParent: z.boolean().optional().describe('Take area and iteration from the parent'),
  });

  /** One bundle on the board or card the user approves on - never sent by Claude. */
  async function draft(input: { conn?: string; board?: string; project?: string; number?: number; askedIn?: string; extend?: number },
                       item: string | null, title: string, steps: { kind: string; payload: Record<string, string> }[], extra: Record<string, unknown> = {}) {
    const c = await pickConnection(client, input.conn);
    const card = input.number ? await cardByNumber(client, input.project ?? '', input.number) : null;
    if (!card && !input.board && !input.extend) {
      throw invalid('Name the card (project + number) or the board this change is for: the user approves it there');
    }
    const board = input.board ? await boardIdOf(client, input.board) : null;
    const b = await live(() => client.post<BundleRow>('/teamboards/writes', { body: { conn: c.id, item, card: card?.id ?? null,
      board, title, askedIn: input.askedIn, extend: input.extend,
      steps: steps.map((s) => ({ kind: s.kind, payload: s.payload, ticked: true, unmasked: false })) }, ...AS_CLAUDE }));
    return ok({ ...bundleReply(b), checks: b.steps.map((s, i) => `step ${i + 1}: ${s.payload?.['azureCheck'] ?? '-'}`), ...extra });
  }

  function jsonFields(f: Record<string, string | number | boolean | null> | undefined): string | undefined {
    if (!f || !Object.keys(f).length) return undefined;
    return JSON.stringify(Object.fromEntries(Object.entries(f).map(([k, v]) => [k, v === null ? '' : v])));
  }

  function createPayload(i: z.infer<typeof NewItemShape>, cardDescription?: string | null): Record<string, string> {
    const p: Record<string, string> = {};
    const put = (k: string, v: string | undefined | null) => { if (v !== undefined && v !== null && v !== '') p[k] = v; };
    put('type', i.type); put('title', i.title); put('description', i.description ?? cardDescription ?? undefined); put('project', i.azureProject);
    put('area', i.area); put('iteration', i.iteration); put('assignee', i.assignee); put('copyOf', i.copyOf ? itemRef(i.copyOf).id : undefined);
    put('template', i.template); put('fields', jsonFields(i.fields));
    if (i.links?.length) p['links'] = JSON.stringify(i.links.map((l) => ({ kind: l.kind, id: itemRef(l.id).id })));
    if (i.tags?.length) p['tags'] = i.tags.join(';');
    if (i.parent === null || i.parent === '') p['parent'] = '';
    else if (i.parent !== undefined) p['parent'] = itemRef(i.parent).id;
    if (i.inheritFromParent) p['inherit'] = '1';
    if (!p['copyOf'] && !p['template'] && (!p['type'] || !p['title'])) throw invalid('Each new item needs a type and a title (or copyOf / a template)');
    return p;
  }

  server.registerTool('team_create_item', {
    description: 'Prepare new work items - one or up to 20 in ONE bundle the user approves (never sent by you): any type the project allows, '
      + 'any fields (Activity, estimates, priority, custom ones), any parent (left out: the board\'s main item), links, tags, a copy of an item '
      + '(copyOf) or a template. Azure checks the draft at once: a missing required field or a value it does not allow comes back to you now '
      + 'with its words - fix it (team_item_type_fields) and draft again. No Alfred comment, tag or link is added unless the user asked '
      + '(markers). With a card the items are linked to it in Alfred. Epics and Features are the team\'s to create.',
    inputSchema: {
      conn: Conn, ...Where,
      items: z.array(NewItemShape).min(1).max(20).optional().describe('The new items; or give one item\'s keys directly below'),
      type: z.string().min(1).max(200).optional(), title: z.string().min(1).max(255).optional(), description: z.string().max(64_000).optional(),
      parent: z.string().max(100).nullable().optional(), area: z.string().max(300).optional(), iteration: z.string().max(300).optional(),
      assignee: z.string().max(200).optional(), fields: Fields.optional(), links: Links.optional(), tags: Tags.optional(),
      markers: z.object({ comment: z.boolean().default(false), tag: z.boolean().default(false) }).optional()
        .describe('Only when the user asked for them: a "Followed in Alfred" comment and the alfred tag on the new item (one item only)'),
    },
  }, (input) => run(async () => {
    const one = { type: input.type, title: input.title, description: input.description, parent: input.parent, area: input.area,
      iteration: input.iteration, assignee: input.assignee, fields: input.fields, links: input.links, tags: input.tags };
    const items: z.infer<typeof NewItemShape>[] = input.items ?? [one];
    const card = input.number ? await cardByNumber(client, input.project ?? '', input.number) : null;
    const cardDescription = card && items.length === 1 ? (card as { description?: string | null }).description ?? null : null;
    const steps = items.map((i) => ({ kind: 'CREATE', payload: createPayload(i, cardDescription) }));
    if (input.markers?.comment || input.markers?.tag) {
      if (items.length !== 1 || !card) throw invalid('Markers go on one new item made from a card');
      if (input.markers.comment) steps.push({ kind: 'COMMENT', payload: { text: `Followed in Alfred as card #${card.number}: ${card.title}`, marker: 'comment' } });
      if (input.markers.tag) steps.push({ kind: 'TAG', payload: { tag: 'alfred' } });
    }
    const title = items.length === 1 ? `Create ${items[0].type ?? 'an item'} "${items[0].title ?? items[0].copyOf ?? ''}" in Azure`
      : `Create ${items.length} items in Azure`;
    return draft(input, null, title, steps);
  }));

  server.registerTool('team_update_item', {
    description: 'Prepare an edit of one or several existing work items (up to 20, one bundle the user approves - never sent by you): any fields '
      + 'at once, the state, a new parent (null removes it), links and tags to add or remove. ids or a WIQL query pick the items (a bulk edit: '
      + 'the same change on each). The bundle shows each field before -> after, and Azure checks it as you draft it.',
    inputSchema: {
      conn: Conn, ...Where,
      id: Id.optional(), ids: z.array(Id).min(1).max(20).optional(),
      query: z.string().min(10).max(32000).optional().describe('A WIQL SELECT picking the items (at most 20)'),
      fields: Fields.optional(), state: z.string().min(1).max(200).optional(),
      parent: z.string().max(100).nullable().optional().describe('Move under this item; null or "": no parent'),
      addLinks: Links.optional(), removeLinks: Links.optional(), addTags: Tags.optional(), removeTags: Tags.optional(),
    },
  }, (input) => run(async () => {
    const c = await pickConnection(client, input.conn);
    let ids = [...(input.ids ?? []), ...(input.id ? [input.id] : [])].map((x) => itemRef(x).id);
    if (input.query) {
      const r = await live(() => client.post<SearchPage>(`/teamboards/connections/${seg(c.id)}/query`, { body: { wiql: input.query, max: 21 }, ...AS_CLAUDE }));
      ids = [...ids, ...r.items.map((x) => x.id)];
    }
    ids = [...new Set(ids)];
    if (!ids.length) throw invalid('Name the items: id, ids or a query');
    if (ids.length > 20) throw invalid(`${ids.length} items - a bundle holds at most 20; narrow the query or split it`);
    const p: Record<string, string> = {};
    const f = jsonFields(input.fields);
    if (f) p['fields'] = f;
    if (input.state) p['state'] = input.state;
    if (input.parent !== undefined) p['parent'] = input.parent === null ? '' : itemRef(input.parent).id;
    if (input.addLinks?.length) p['addLinks'] = JSON.stringify(input.addLinks.map((l) => ({ kind: l.kind, id: itemRef(l.id).id })));
    if (input.removeLinks?.length) p['removeLinks'] = JSON.stringify(input.removeLinks.map((l) => ({ kind: l.kind, id: itemRef(l.id).id })));
    if (input.addTags?.length) p['addTags'] = input.addTags.join(';');
    if (input.removeTags?.length) p['removeTags'] = input.removeTags.join(';');
    if (!Object.keys(p).length) throw invalid('Say what to change: fields, state, parent, links or tags');
    const steps = ids.map((id) => ({ kind: 'FIELD', payload: ids.length === 1 ? p : { ...p, item: id } }));
    return draft({ ...input, conn: c.id }, ids.length === 1 ? ids[0] : null, ids.length === 1 ? `Edit ${ids[0]} in Azure` : `Edit ${ids.length} items in Azure`, steps);
  }));

  server.registerTool('team_split_item', {
    description: 'Prepare child items under one item in ONE bundle the user approves (e.g. Backend / Frontend / QA tasks of a story): each '
      + 'takes the parent\'s area and iteration unless given, and any fields you give.',
    inputSchema: {
      conn: Conn, ...Where, id: Id.describe('The parent item'),
      children: z.array(NewItemShape.omit({ parent: true, copyOf: true })).min(1).max(20),
    },
  }, (input) => run(async () => {
    const parent = itemRef(input.id).id;
    const steps = input.children.map((ch) => ({ kind: 'CREATE', payload: createPayload({ ...ch, parent, inheritFromParent: ch.inheritFromParent ?? true }) }));
    return draft(input, null, `Split ${parent} into ${steps.length} items in Azure`, steps);
  }));

  server.registerTool('team_log_time', {
    description: 'Prepare logging work on an item: Completed Work + hours and Remaining Work - hours (never below 0; or the remaining you give), '
      + 'from its values now. A bundle the user approves - never sent by you.',
    inputSchema: { conn: Conn, ...Where, id: Id, hours: z.number().positive().max(1000), remaining: z.number().min(0).max(10_000).optional() },
  }, (input) => run(async () => {
    const ref = itemRef(input.id);
    const c = await pickConnection(client, input.conn ?? ref.conn);
    const v = await live(() => client.get<ItemView>(`/teamboards/connections/${seg(c.id)}/items/${seg(ref.id)}`, { query: { include: '' }, ...AS_CLAUDE }));
    const num = (k: string) => Number(v.item.fields[k] ?? 0) || 0;
    const done = num('Microsoft.VSTS.Scheduling.CompletedWork') + input.hours;
    const left = input.remaining ?? Math.max(0, num('Microsoft.VSTS.Scheduling.RemainingWork') - input.hours);
    const fields = { 'Microsoft.VSTS.Scheduling.CompletedWork': Math.round(done * 100) / 100, 'Microsoft.VSTS.Scheduling.RemainingWork': Math.round(left * 100) / 100 };
    return draft({ ...input, conn: c.id }, ref.id, `Log ${input.hours} h on ${ref.id}`, [{ kind: 'FIELD', payload: { fields: JSON.stringify(fields) } }],
      { completed: fields['Microsoft.VSTS.Scheduling.CompletedWork'], remaining: fields['Microsoft.VSTS.Scheduling.RemainingWork'] });
  }));

  server.registerTool('team_close_item', {
    description: 'Prepare closing an item instead of deleting it (Alfred never deletes work items): its type\'s Removed or Completed state, with a '
      + 'comment saying why. A bundle the user approves - never sent by you.',
    inputSchema: { conn: Conn, ...Where, id: Id, as: z.enum(['Removed', 'Completed']).default('Removed'), reason: z.string().min(1).max(8000) },
  }, (input) => run(async () => {
    const ref = itemRef(input.id);
    return draft({ ...input, conn: input.conn ?? ref.conn }, ref.id, `Close ${ref.id} as ${input.as}`, [
      { kind: 'STATE', payload: { category: input.as } }, { kind: 'COMMENT', payload: { text: input.reason } }]);
  }));

  server.registerTool('team_item_type_fields', {
    description: 'The fields of a work item type in an Azure project: reference name, name, type, whether it is required, read-only, the values '
      + 'it allows and its default. Read before drafting a create, so required fields (e.g. Activity on a Task) are filled. Kept 24 h; fresh: ask again.',
    inputSchema: { conn: Conn, azureProject: z.string().min(1).max(200), type: z.string().min(1).max(200), fresh: z.boolean().default(false),
      requiredOnly: z.boolean().default(false) },
  }, (input) => run(async () => {
    const c = await pickConnection(client, input.conn);
    const rows = await live(() => client.get<{ ref: string; name: string; type: string; required: boolean; readOnly: boolean; allowed: string[]; defaultValue: string | null }[]>(
      `/teamboards/connections/${seg(c.id)}/fields`, { query: { project: input.azureProject, type: input.type, fresh: String(input.fresh) }, ...AS_CLAUDE }));
    const shown = rows.filter((r) => !input.requiredOnly || r.required);
    return ok({ type: input.type, required: rows.filter((r) => r.required).map((r) => r.ref),
      fields: shown.map((r) => `${r.ref} (${r.name}${r.type ? ', ' + r.type : ''})${r.required ? ' REQUIRED' : ''}${r.readOnly ? ' read-only' : ''}`
        + `${r.allowed.length ? ' · allowed: ' + r.allowed.slice(0, 40).join(' | ') : ''}${r.defaultValue ? ' · default ' + r.defaultValue : ''}`) });
  }));

  server.registerTool('team_templates', {
    description: 'Templates for new items: list them, or save one (a name, a type and its fields) when the user asked you to - then '
      + 'team_create_item takes template: "<name>". Only the user deletes a template.',
    inputSchema: { conn: Conn, save: z.object({ name: z.string().min(1).max(80), type: z.string().min(1).max(200), fields: Fields }).optional(),
      askedIn: z.string().min(1).max(40).optional().describe('Required to save: the chat message id (or "terminal") where the user asked') },
  }, (input) => run(async () => {
    const c = await pickConnection(client, input.conn);
    if (input.save) {
      if (!input.askedIn) throw invalid('Save a template only when the user asked: pass askedIn');
      const fields = Object.fromEntries(Object.entries(input.save.fields).map(([k, v]) => [k, v === null ? '' : String(v)]));
      await client.put(`/teamboards/connections/${seg(c.id)}/templates/${seg(input.save.name)}`, { body: { type: input.save.type, fields }, ...AS_CLAUDE });
    }
    const list = await client.get<{ name: string; type: string; fieldsJson: string }[]>(`/teamboards/connections/${seg(c.id)}/templates`, AS_CLAUDE);
    return ok({ templates: list.map((t) => `"${t.name}" · ${t.type} · ${t.fieldsJson}`), ...(input.save ? { saved: input.save.name } : {}) });
  }));

  async function step(input: { conn?: string; id: string; board?: string; project?: string; number?: number; askedIn?: string; extend?: number },
                      kind: 'STATE' | 'COMMENT' | 'FIELD', payload: Record<string, string>, extra: Record<string, unknown> = {}) {
    const ref = itemRef(input.id);
    const c = await pickConnection(client, input.conn ?? ref.conn);
    const card = input.number ? await cardByNumber(client, input.project ?? '', input.number) : null;
    if (!card && !input.board && !input.extend) {
      throw new Error('Name the card (project + number) or the board this change is for: the user approves it there');
    }
    if (input.extend) {
      const b = await client.post<BundleRow>('/teamboards/writes', { body: { conn: c.id, item: ref.id, card: card?.id ?? null, board: input.board ? await boardIdOf(client, input.board) : null,
        steps: [{ kind, payload, ticked: true, unmasked: false }], askedIn: input.askedIn, extend: input.extend }, ...AS_CLAUDE });
      return ok({ ...bundleReply(b), ...extra });
    }
    const body = kind === 'STATE' ? { state: payload['state'] } : kind === 'FIELD' ? { field: payload['field'], value: payload['value'] }
      : { comment: payload['text'] };
    const b = await client.patch<BundleRow>(`/teamboards/connections/${seg(c.id)}/items/${seg(ref.id)}`,
      { body: { ...body, card: card?.id ?? null, board: input.board ? await boardIdOf(client, input.board) : null, askedIn: input.askedIn }, ...AS_CLAUDE });
    return ok({ ...bundleReply(b), ...extra });
  }

  server.registerTool('team_comment', {
    description: 'Prepare a comment on a work item (no "via Alfred" footer unless the user asked: footer). @[person:<id>|Name] mentions someone (team_people). Name the card (project + number) or the board: the user approves '
      + 'the bundle there - never sent by you. No secrets, tokens or raw request bodies in the text; evidence files are built (masked) by the user\'s browser on the card.',
    inputSchema: { conn: Conn, id: Id, text: z.string().min(1).max(64_000), board: z.string().min(1).max(200).optional(), project: Card.project.optional(), number: Card.number.optional(), askedIn: AskedIn,
      extend: Extend, footer: z.boolean().default(false).describe('Only when the user asked: "via Alfred: board …" under the comment') },
  }, (input) => run(() => input.footer
    ? draft({ ...input, conn: input.conn ?? itemRef(input.id).conn }, itemRef(input.id).id, `Comment on ${itemRef(input.id).id}`,
      [{ kind: 'COMMENT', payload: { text: input.text, footer: '1' } }])
    : step(input, 'COMMENT', { text: input.text })));

  server.registerTool('team_move_state', {
    description: 'Prepare a state change of a work item (e.g. Resolved). Name the card (project + number) or the board: the user approves the bundle there - never sent by you.',
    inputSchema: { conn: Conn, id: Id, state: z.string().min(1).max(200), board: z.string().min(1).max(200).optional(), project: Card.project.optional(), number: Card.number.optional(), askedIn: AskedIn,
      extend: Extend },
  }, (input) => run(async () => {
    const ref = itemRef(input.id);
    const c = await pickConnection(client, input.conn ?? ref.conn);
    // specs/030: a state this item's type does not have becomes the closest one in the same category, said so
    const [lists, view] = await Promise.all([
      client.get<{ states?: StateRow[] }>(`/teamboards/connections/${seg(c.id)}/lists`, AS_CLAUDE).catch(() => null),
      client.get<ItemView>(`/teamboards/connections/${seg(c.id)}/items/${seg(ref.id)}`, { query: { include: '' }, ...AS_CLAUDE }).catch(() => null),
    ]);
    const picked = pickState(input.state, view?.item.type ?? null, lists?.states ?? []);
    return step({ ...input, conn: c.id }, 'STATE', { state: picked.state }, picked.note ? { stateNote: picked.note } : {});
  }));

  server.registerTool('team_set_field', {
    description: 'Prepare setting one field of a work item by its reference name (e.g. Microsoft.VSTS.Common.Priority; an empty value clears '
      + 'it) - specs/030. Not the state (team_move_state) nor a field the tracker keeps (id, rev, dates). Name the card (project + number) or '
      + 'the board: the user approves the bundle there - never sent by you.',
    inputSchema: { conn: Conn, id: Id, field: z.string().min(3).max(200).regex(/^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z0-9_]+)+$/, 'a reference name such as Microsoft.VSTS.Common.Priority'),
      value: z.string().max(64_000), board: z.string().min(1).max(200).optional(), project: Card.project.optional(), number: Card.number.optional(),
      askedIn: AskedIn, extend: Extend },
  }, (input) => run(() => step(input, 'FIELD', { field: input.field, value: input.value })));

  // specs/034: Claude reads a bundle (with the user's reject reason) and rewrites its comment when the user asks
  server.registerTool('team_bundle', {
    description: 'Read one consent bundle: its steps (each comment\'s text, Claude\'s first draft, the value a state or field had when it was made), '
      + 'its state, and - when the user rejected it - their reason (note). Read it before a redraft, and after a rejection before you draft again.',
    inputSchema: { bundle: z.number().int().min(1) },
  }, (input) => run(async () => {
    const b = await client.get<BundleRow & { note?: string | null; boardId?: string | null; cardId?: string | null; item?: string | null }>(
      `/teamboards/writes/${input.bundle}`, AS_CLAUDE);
    return ok({ bundle: b.id, title: b.title, state: b.state, item: b.item ?? null, note: b.note ?? null,
      steps: b.steps.map((st, i) => ({ step: i + 1, kind: st.kind, ticked: st.ticked, ...st.payload, ...(st.result ? { result: st.result } : {}) })) });
  }));

  server.registerTool('team_redraft', {
    description: 'Change a step of your own waiting bundle when the user asked ("/alfred-team redraft bundle N step S: ...") or Azure refused it: '
      + 'text (the new text of a comment), or changes (any step keys: title, parent, type, fields as a JSON string, tags, state, links...; null '
      + 'removes a key), or drop the step. Azure checks it again at once. The user still reviews and approves - never say it was sent. Steps count from 1.',
    inputSchema: { bundle: z.number().int().min(1), step: z.number().int().min(1).max(20), text: z.string().min(1).max(64_000).optional(),
      changes: z.record(z.string().min(1).max(60), z.string().max(64_000).nullable()).optional(), drop: z.boolean().default(false) },
  }, (input) => run(async () => {
    if (!input.text && !input.changes && !input.drop) throw invalid('Give text, changes or drop');
    const body = input.text && !input.changes && !input.drop ? { step: input.step - 1, text: input.text }
      : { step: input.step - 1, changes: input.changes ?? (input.text ? { text: input.text } : undefined), drop: input.drop };
    const b = await live(() => client.post<BundleRow>(`/teamboards/writes/${input.bundle}/redraft`, { body, ...AS_CLAUDE }));
    return ok({ ...bundleReply(b), ...(input.drop ? { dropped: input.step } : { redrafted: input.step }) });
  }));

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
    await client.post(`/teamboards/boards/${seg(await boardIdOf(client, input.board))}/incoming/${seg(c.id)}/${seg(ref.id)}/proposal`,
      { body: { action: input.action, cardId: input.cardId, reason: input.reason }, ...AS_CLAUDE });
    return ok({ proposed: `${input.action}${input.cardId ? ' ' + input.cardId : ''} for ${c.id}/${ref.id}`, note: 'It waits in Incoming for the user.' });
  }));

  server.registerTool('team_refresh_item', {
    description: 'Refresh from Azure: sync a board now (board = AB#<id>, its name or id) and say what changed - new items in the tree (they wait in Incoming), items Azure moved past with new comments, the main item\'s state or iteration move, possible card matches. Or read one item live '
      + 'with what changed since Alfred\'s copy.',
    inputSchema: { board: z.string().min(1).max(200).optional(), conn: Conn, id: Id.optional() },
  }, (input) => run(async () => {
    if (input.board) {
      const board = await boardIdOf(client, input.board);
      const r = await live(() => client.post<SyncResultRow>(`/teamboards/boards/${seg(board)}/sync`, { body: { force: true, wait: true }, ...AS_CLAUDE }));
      if (!r || r.newItems === undefined) return ok({ syncing: board, note: 'Runs in the background (an older Alfred); read team_board_items in a moment.' });
      return ok(syncText(board, r));
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
    const r = await live(async () => client.post<{ new: number }>(`/teamboards/boards/${seg(await boardIdOf(client, input.board))}/watch-rules/run`, AS_CLAUDE));
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
    const r = await live(async () => client.put<{ attached: string[]; notAttached: string[] }>(`/teamboards/links/${seg(await boardIdOf(client, input.board))}`,
      { body: { conn: c.id, extId: ref.id, askedIn: input.askedIn }, ...AS_CLAUDE }));
    return ok({ main: `${input.board} ★ ${c.id}/${ref.id}`, attached: r.attached, notAttached: r.notAttached,
      ...(r.notAttached.length ? { note: 'List the files not attached in the brief by name; the user fetches them with "Fetch attachments".' } : {}) });
  }));

  server.registerTool('team_new_board', {
    description: 'Make an Alfred board from a work item now - the same as Add to board > New board from this item - ONLY when the user asked '
      + 'for it (askedIn: the id of that chat message, or "terminal"). Unlike team_start nothing is posted: the board is made at once, named '
      + '"#<id>_<title>" unless you pass name, the item its main (with its parent and children as related items) and a first cycle that does '
      + 'not record (cycle NEW; RECORD starts recording into it, NONE makes none). Ask the user for the project when you do not know it. '
      + 'Nothing is written to the tracker.',
    inputSchema: {
      id: Id,
      conn: Conn,
      askedIn: z.string().min(1).max(40),
      project: z.string().min(1).max(200),
      name: z.string().max(120).optional().describe('Default "#<id>_<title>"'),
      main: z.boolean().default(true).describe('The item as the main of the board (a related item when it is the main of another board already)'),
      cycle: z.enum(['NEW', 'RECORD', 'NONE']).default('NEW'),
      attachments: z.boolean().default(false).describe('Fetch the attachments of the item to the board'),
      remember: z.boolean().default(false).describe('Save project as the mapping for the squad (or area) of the item'),
    },
  }, (input) => run(async () => {
    const ref = itemRef(input.id);
    const c = await pickConnection(client, input.conn ?? ref.conn);
    const r = await client.post<{ boardId: string; project: string; name: string; main: boolean; cycle: string;
      files: { attached: string[]; notAttached: string[] } | null; note: string | null }>(
      `/teamboards/items/${seg(c.id)}/${seg(ref.id)}/board`, { body: { project: input.project, name: input.name ?? null, main: input.main,
        cycle: input.cycle, attachments: input.attachments, remember: input.remember, askedIn: input.askedIn }, ...AS_CLAUDE });
    return ok({ board: r.boardId, project: r.project, name: r.name, main: r.main, cycle: r.cycle,
      attached: r.files?.attached ?? [], notAttached: r.files?.notAttached ?? [], ...(r.note ? { note: r.note } : {}) });
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
