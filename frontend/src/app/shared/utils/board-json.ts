import { ActivityEntry, BoardSummary, BriefComment, CardDetail, ChecklistMark, CycleBrief, MentionRef } from '../../core/models/board.models';
import { mentionsIn } from './mention-syntax';
import { BoardVisuals, visualRecords } from './board-visuals-export';

/**
 * The board's .json export and re-import format, `alfred-board/1` (specs/014-task-board research R15): a header line,
 * then one JSON record per line - every card (with its direct links), every history entry, the cycle briefs, the spec
 * files in full and the checklist marks. Nothing is shortened. Lines, never one big string: they go to a Blob part by
 * part (export-file-io's exportBlob), and the backend's ImportBoardService reads them one at a time.
 */
export const BOARD_FORMAT = 'alfred-board/1';

export interface BoardSpecFile {
  readonly cycleId: string;
  readonly name: string;
  readonly content: string;
  readonly uploadedAt: string;
}

export interface BoardExport {
  readonly project: string;
  readonly cards: readonly CardDetail[];
  /** History per card id, oldest first. */
  readonly activity: Readonly<Record<string, readonly ActivityEntry[]>>;
  readonly briefs: readonly CycleBrief[];
  /** Comments on the briefs (specs/024), threads first comment before its replies. Older exports have none. */
  readonly briefComments?: readonly BriefComment[];
  readonly specs: readonly BoardSpecFile[];
  readonly marks: readonly ChecklistMark[];
  /** The pictures the texts show (base64), so an import elsewhere shows them too - .json only. */
  readonly images?: readonly BoardImageData[];
  /** Pages, saved values, pictures, files and widgets (specs/017 R43). */
  readonly visuals?: BoardVisuals;
  /** The board chats' records as the backend writes them (specs/022: chat, chatRecord, chatTerminal, chatSettings) - .json only. */
  readonly chats?: readonly unknown[];
  /** The boards (specs/027): each with its cycles and related boards - .json only. Older exports have none (all cards on the default board). */
  readonly boards?: readonly BoardSummary[];
  /** The cycles related to a card beyond its home, by card id. */
  readonly cardCycles?: Readonly<Record<string, readonly string[]>>;
  /** The work item each board was opened from, as Alfred's snapshot of it (read back for reference; the tracker stays the source). */
  readonly workItems?: readonly { readonly board: string; readonly conn: string; readonly extId: string; readonly provider: string;
    readonly snapshot: Readonly<Record<string, string>> }[];
}

export interface BoardImageData {
  readonly id: string;
  readonly mime: string;
  readonly data: string;
}

/** Every picture id the export's texts show (`/board/images/<id>`), each once. */
export function boardImageIds(data: BoardExport): string[] {
  const ids = new Set<string>();
  const add = (t: string | null | undefined) => {
    for (const m of (t ?? '').matchAll(/\/board\/images\/([A-Za-z0-9-]{8,64})/g)) ids.add(m[1]);
  };
  for (const c of data.cards) add(c.description);
  for (const list of Object.values(data.activity)) for (const e of list) add(e.text);
  for (const b of data.briefs) add(b.text);
  for (const c of data.briefComments ?? []) add(c.text);
  for (const s of data.specs) add(s.content);
  for (const m of data.marks) add(m.evidence);
  return [...ids];
}

const CARD_FIELDS = ['project', 'number', 'kind', 'title', 'description', 'status', 'resolution', 'reason', 'flags', 'teams', 'scope', 'author',
  'cycleId', 'cycleDeleted', 'signature', 'createdAt', 'updatedAt', 'updatedBy', 'boardId'] as const;

/** A card's links that no text of it writes - those come back from the text itself on import. */
function directLinks(card: CardDetail, history: readonly ActivityEntry[]): MentionRef[] {
  const written = new Set<string>();
  for (const m of mentionsIn(card.description)) written.add(`${m.type.toLowerCase()}:${m.ref}`);
  for (const e of history) for (const m of mentionsIn(e.text)) written.add(`${m.type.toLowerCase()}:${m.ref}`);
  return card.links.filter((l) => !written.has(`${l.type.toLowerCase()}:${l.ref}`))
    .map((l) => ({ type: l.type.toLowerCase(), ref: l.ref, label: l.label }));
}

export function buildBoardJsonLines(data: BoardExport, exportedAt = new Date().toISOString()): string[] {
  const lines: string[] = [JSON.stringify({ format: BOARD_FORMAT, exportedAt, project: data.project, cards: data.cards.length,
    guide: 'One record per line: card, then board, board-cycle, board-board, card-cycle (by cardNumber), workitem-snapshot, activity (by cardNumber), brief, briefComment, spec, mark, image (base64), page (with every version), state, shot (PNG, base64), '
      + 'file (base64), widget, chatSettings, chat, chatRecord, chatTerminal. Texts are Markdown or HTML. Import with Board → Import .json.' })];
  for (const card of data.cards) {
    const fields: Record<string, unknown> = {};
    for (const f of CARD_FIELDS) fields[f] = card[f];
    lines.push(JSON.stringify({ record: 'card', card: fields, links: directLinks(card, data.activity[card.id] ?? []) }));
  }
  // specs/027: right after the cards, before the briefs and specs that are keyed by a board's id
  const pairs = new Set<string>();
  for (const s of data.boards ?? []) {
    const b = s.board;
    lines.push(JSON.stringify({ record: 'board', board: { id: b.id, name: b.name, isDefault: b.isDefault, state: b.state, migratedFrom: b.migratedFrom,
      createdAt: b.createdAt } }));
    for (const c of s.cycleIds) lines.push(JSON.stringify({ record: 'board-cycle', boardId: b.id, cycleId: c }));
    for (const o of s.boardIds) {
      const key = [b.id, o].sort().join('\n');
      if (pairs.has(key)) continue;
      pairs.add(key);
      lines.push(JSON.stringify({ record: 'board-board', boardId: b.id, otherId: o }));
    }
  }
  for (const card of data.cards) {
    for (const c of data.cardCycles?.[card.id] ?? []) lines.push(JSON.stringify({ record: 'card-cycle', cardNumber: card.number, cycleId: c }));
  }
  for (const w of data.workItems ?? []) {
    lines.push(JSON.stringify({ record: 'workitem-snapshot', boardId: w.board, conn: w.conn, extId: w.extId, provider: w.provider, snapshot: w.snapshot }));
  }
  for (const card of data.cards) {
    for (const e of data.activity[card.id] ?? []) {
      lines.push(JSON.stringify({ record: 'activity', cardNumber: card.number,
        entry: { id: e.id, actor: e.actor, kind: e.kind, text: e.text, oldValue: e.oldValue, newValue: e.newValue, at: e.at,
          ...(e.replyTo != null ? { replyTo: e.replyTo } : {}), ...(e.answers != null ? { answers: e.answers } : {}) } }));
    }
  }
  for (const b of data.briefs) lines.push(JSON.stringify({ record: 'brief', cycleId: b.cycleId, text: b.text, updatedAt: b.updatedAt }));
  // by id: a thread's first comment is always older than its replies, so the import can point each reply at it
  for (const c of [...(data.briefComments ?? [])].sort((a, b) => a.id - b.id)) {
    lines.push(JSON.stringify({ record: 'briefComment', cycleId: c.cycleId, id: c.id, quote: c.quote, actor: c.actor, text: c.text,
      replyTo: c.replyTo, asks: c.asks, suggestFrom: c.suggestFrom, suggestTo: c.suggestTo, createdAt: c.createdAt,
      resolvedAt: c.resolvedAt, resolvedBy: c.resolvedBy }));
  }
  for (const s of data.specs) {
    lines.push(JSON.stringify({ record: 'spec', cycleId: s.cycleId, name: s.name, content: s.content, uploadedAt: s.uploadedAt }));
  }
  for (const m of data.marks) {
    lines.push(JSON.stringify({ record: 'mark', cycleId: m.cycleId, fileName: m.fileName, itemKey: m.itemKey, mark: m.mark, actor: m.actor,
      evidence: m.evidence, updatedAt: m.updatedAt }));
  }
  for (const i of data.images ?? []) lines.push(JSON.stringify({ record: 'image', id: i.id, mime: i.mime, data: i.data }));
  if (data.visuals) lines.push(...visualRecords(data.visuals));
  for (const c of data.chats ?? []) lines.push(JSON.stringify(c));
  return lines;
}

/** What a file holds, read back record by record - for previews and the round-trip guard. */
export interface ParsedBoard {
  readonly project: string;
  readonly cards: readonly (Record<string, unknown> & { readonly links: readonly MentionRef[] })[];
  readonly activity: readonly { readonly cardNumber: number; readonly entry: Record<string, unknown> }[];
  readonly briefs: readonly Record<string, unknown>[];
  readonly briefComments: readonly Record<string, unknown>[];
  readonly specs: readonly BoardSpecFile[];
  readonly marks: readonly Record<string, unknown>[];
  readonly boards: readonly Record<string, unknown>[];
  readonly boardCycles: readonly { readonly boardId: string; readonly cycleId: string }[];
  readonly cardCycles: readonly { readonly cardNumber: number; readonly cycleId: string }[];
  readonly workItems: readonly Record<string, unknown>[];
}

export function parseBoardJsonLines(lines: readonly string[]): ParsedBoard {
  const [header, ...rest] = lines.filter((l) => l.trim());
  const head = JSON.parse(header ?? '{}') as { format?: string; project?: string };
  if (head.format !== BOARD_FORMAT) throw new SyntaxError(`Not an ${BOARD_FORMAT} file`);
  const out = { project: head.project ?? '', cards: [] as ParsedBoard['cards'][number][], activity: [] as ParsedBoard['activity'][number][],
    briefs: [] as Record<string, unknown>[], briefComments: [] as Record<string, unknown>[], specs: [] as BoardSpecFile[],
    marks: [] as Record<string, unknown>[], boards: [] as Record<string, unknown>[], boardCycles: [] as ParsedBoard['boardCycles'][number][],
    cardCycles: [] as ParsedBoard['cardCycles'][number][], workItems: [] as Record<string, unknown>[] };
  for (const line of rest) {
    const r = JSON.parse(line) as Record<string, unknown> & { record: string };
    switch (r.record) {
      case 'card': out.cards.push({ ...(r['card'] as Record<string, unknown>), links: (r['links'] as MentionRef[]) ?? [] }); break;
      case 'activity': out.activity.push({ cardNumber: r['cardNumber'] as number, entry: r['entry'] as Record<string, unknown> }); break;
      case 'brief': out.briefs.push(r); break;
      case 'briefComment': out.briefComments.push(r); break;
      case 'spec': out.specs.push(r as unknown as BoardSpecFile); break;
      case 'mark': out.marks.push(r); break;
      case 'board': out.boards.push(r['board'] as Record<string, unknown>); break;
      case 'board-cycle': out.boardCycles.push({ boardId: r['boardId'] as string, cycleId: r['cycleId'] as string }); break;
      case 'card-cycle': out.cardCycles.push({ cardNumber: r['cardNumber'] as number, cycleId: r['cycleId'] as string }); break;
      case 'workitem-snapshot': out.workItems.push(r); break;
    }
  }
  return out;
}

export function boardJsonFilename(project: string, cycleName: string | null, at = new Date()): string {
  const day = at.toISOString().slice(0, 10);
  const base = (cycleName ?? project ?? '') || 'board';
  return `alfred-board-${base.replace(/[^A-Za-z0-9._-]+/g, '-')}-${day}.json`;
}
