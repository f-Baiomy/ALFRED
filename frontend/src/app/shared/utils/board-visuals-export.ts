import { SnippetPage, SnippetStateValue, SnippetVersionInfo, WidgetInfo } from '../../core/models/snippet.models';

/**
 * What a board export carries of the visuals (specs/017 R43): the pages with every version, the values snippets saved,
 * each snippet's newest picture, the attached files and the project's widgets. Ids that change on import are written
 * the way the importer maps them back: a page's state as `page:<id>`, an inline block on a card as
 * `inline:card:#<number>:<where>:<n>` (the card's number, not its id).
 */
export interface ExportedPage {
  readonly owner: 'card' | 'cycle' | 'project';
  readonly cardNumber?: number;
  readonly cycleId?: string | null;
  /** With its source. */
  readonly page: SnippetPage;
  /** Every version, newest first, with its source. */
  readonly versions: readonly SnippetVersionInfo[];
}

export interface ExportedState {
  readonly snippetId: string;
  readonly key: string;
  readonly value: string;
  readonly updatedBy: string;
  readonly at: string;
}

export interface ExportedShot {
  readonly snippetId: string;
  readonly version: number;
  /** base64, no data: prefix. */
  readonly png: string;
  readonly console: string;
  readonly at: string;
}

export interface ExportedFile {
  readonly id: string;
  readonly cardNumber?: number;
  readonly cycleId?: string | null;
  readonly name: string;
  readonly mime: string;
  readonly size: number;
  readonly author: string;
  readonly createdAt: string;
  /** base64 - in the .json only. */
  readonly data?: string;
}

export interface BoardVisuals {
  readonly pages: readonly ExportedPage[];
  readonly states: readonly ExportedState[];
  readonly shots: readonly ExportedShot[];
  readonly files: readonly ExportedFile[];
  /** With their source. */
  readonly widgets: readonly WidgetInfo[];
}

export const NO_VISUALS: BoardVisuals = { pages: [], states: [], shots: [], files: [], widgets: [] };

/** A snippet id as the export writes it: card ids become card numbers, page ids are marked as pages. */
export function exportedSnippetId(id: string, numberOfCard: (cardId: string) => number | undefined, pageIds: ReadonlySet<string>): string {
  if (pageIds.has(id)) return `page:${id}`;
  const m = /^inline:card:([A-Za-z0-9-]{1,64}):(.+)$/.exec(id);
  if (m) {
    const n = numberOfCard(m[1]);
    return n === undefined ? id : `inline:card:#${n}:${m[2]}`;
  }
  return id;
}

/** The exported state of one snippet as the answers an offline frame looks up (state.all and state.get per key). */
export function stateAnswers(states: readonly ExportedState[], snippetId: string, key: (op: string, args: Record<string, unknown>) => string): Record<string, unknown> {
  const mine = states.filter((s) => s.snippetId === snippetId);
  const parse = (v: string) => { try { return JSON.parse(v); } catch { return v; } };
  const out: Record<string, unknown> = { [key('state.all', {})]: Object.fromEntries(mine.map((s) => [s.key, parse(s.value)])) };
  for (const s of mine) out[key('state.get', { key: s.key })] = parse(s.value);
  return out;
}

/** The .json records (`alfred-board/1`, read by the backend's ImportBoardService). */
export function visualRecords(v: BoardVisuals): string[] {
  const lines: string[] = [];
  for (const p of v.pages) {
    const pg = p.page;
    lines.push(JSON.stringify({ record: 'page', owner: p.owner, ...(p.cardNumber != null ? { cardNumber: p.cardNumber } : {}),
      ...(p.cycleId ? { cycleId: p.cycleId } : {}), id: pg.id, name: pg.name, kind: pg.kind, info: pg.info, source: pg.source ?? '',
      pinned: pg.pinned, position: pg.position, author: pg.author, version: pg.version, createdAt: pg.createdAt, updatedAt: pg.updatedAt,
      updatedBy: pg.updatedBy,
      versions: p.versions.map((x) => ({ version: x.version, name: x.name, info: x.info, source: x.source ?? '', author: x.author, at: x.at })) }));
  }
  for (const s of v.states) lines.push(JSON.stringify({ record: 'state', ...s }));
  for (const s of v.shots) lines.push(JSON.stringify({ record: 'shot', ...s }));
  for (const f of v.files) lines.push(JSON.stringify({ record: 'file', ...f }));
  for (const w of v.widgets) {
    lines.push(JSON.stringify({ record: 'widget', name: w.name, kind: w.kind, info: w.info, source: w.source ?? '', author: w.author,
      updatedAt: w.updatedAt, updatedBy: w.updatedBy }));
  }
  return lines;
}
