import { Injectable, inject } from '@angular/core';
import { Observable, expand, forkJoin, from, lastValueFrom, map, mergeMap, of, reduce, toArray, EMPTY, catchError } from 'rxjs';
import { ActivityEntry, CardSummary, ChecklistMark, CycleBrief, NO_FILTERS } from '../models/board.models';
import { BoardExport, BoardImageData, BoardSpecFile, boardImageIds, boardJsonFilename, buildBoardJsonLines } from '../../shared/utils/board-json';
import { buildBoardHtmlParts } from '../../shared/utils/board-html-builder';
import { buildBoardMarkdownLines } from '../../shared/utils/board-md-builder';
import { downloadBlob } from '../../shared/utils/download';
import { exportBlob } from '../../shared/utils/export-file-io';
import { BoardApiService } from './board-api.service';
import { ChatApiService } from './chat-api.service';
import { SnippetsApiService } from './snippets-api.service';
import { BoardVisuals, ExportedFile, ExportedPage, ExportedShot, ExportedState, exportedSnippetId } from '../../shared/utils/board-visuals-export';
import { WidgetInfo } from '../models/snippet.models';
import { FrameKit, textSnippets } from '../../shared/utils/board-visuals-render';
import { infoAttrs } from '../../shared/utils/board-visuals';
import { declaredData, libsForDoc, staticAnswerKey } from '../../shared/utils/snippet-frame';
import { SnippetLib } from '../../shared/utils/snippet-libs';
import { SnippetShelfService } from './snippet-shelf.service';
import { SnippetDataService } from './snippet-data.service';
import { briefParts } from '../../shared/utils/task-view';

export type BoardExportFormat = 'md' | 'html' | 'json';

/** How many cards are read at once while gathering an export - enough to be quick, few enough to stay polite. */
const CONCURRENCY = 6;

/**
 * Gathers everything a board export holds - every card in full with its whole history, and the briefs, spec files and
 * checklist marks of the cycles involved - and writes it as .md, .html or .json (FR-045..048). Nothing is shortened.
 */
@Injectable({ providedIn: 'root' })
export class BoardExportService {
  private readonly api = inject(BoardApiService);
  private readonly snippets = inject(SnippetsApiService);
  private readonly shelf = inject(SnippetShelfService);
  private readonly dataSource = inject(SnippetDataService);
  private readonly chatApi = inject(ChatApiService);

  /** The whole board (or a cycle's cards), or only `ids` when given. */
  gather(project: string, cycleId: string | null, ids: readonly string[] | null = null): Promise<BoardExport> {
    const summaries$ = this.allCards(project, cycleId).pipe(map((cards) => (ids ? cards.filter((c) => ids.includes(c.id)) : cards)));
    return lastValueFrom(summaries$.pipe(
      mergeMap((cards) => from(cards).pipe(
        mergeMap((c) => forkJoin({ card: this.api.card(c.id), activity: this.api.activity(c.id).pipe(map((p) => p.entries)) }), CONCURRENCY),
        toArray(),
      )),
      mergeMap((loaded) => {
        const order = new Map(loaded.map((l, i) => [l.card.id, i]));
        const cards = [...loaded].sort((a, b) => a.card.number - b.card.number || (order.get(a.card.id)! - order.get(b.card.id)!));
        const cycles = [...new Set([cycleId, ...cards.map((c) => c.card.cycleId)].filter((c): c is string => !!c))];
        return this.cycleParts(cycles).pipe(map((parts) => ({
          project,
          cards: cards.map((c) => c.card),
          activity: Object.fromEntries(cards.map((c) => [c.card.id, c.activity])) as Record<string, readonly ActivityEntry[]>,
          ...parts,
        })));
      }),
    ));
  }

  async download(format: BoardExportFormat, project: string, cycleId: string | null, title: string, ids: readonly string[] | null = null):
    Promise<void> {
    const gathered = await this.gather(project, cycleId, ids);
    const data = { ...gathered, visuals: await this.visuals(gathered, cycleId === null && ids === null, format === 'json') };
    const name = boardJsonFilename(project, cycleId ? title : null).replace(/\.json$/, `.${format}`);
    if (format === 'json') {
      const chats = ids === null ? await this.chats(project, cycleId) : [];
      downloadBlob(await exportBlob(buildBoardJsonLines({ ...data, images: await this.images(data), chats }), false), name);
    } else if (format === 'md') {
      downloadBlob(new Blob(buildBoardMarkdownLines(data, title).map((l) => `${l}\n`), { type: 'text/markdown' }), name);
    } else {
      downloadBlob(new Blob(buildBoardHtmlParts(data, title, await this.frameKit(data)), { type: 'text/html' }), name);
    }
  }

  /**
   * The board chats (specs/022): every chat of the project for a whole-board export, the cycle's chat for a cycle's.
   * Unreadable (an older Alfred) → none; the cards still export.
   */
  async chats(project: string, cycleId: string | null): Promise<unknown[]> {
    const out: unknown[] = [];
    let after = 0;
    try {
      for (;;) {
        const page = await lastValueFrom(this.chatApi.exportPage(project, cycleId, after));
        out.push(...page.lines);
        if (!page.more || page.next <= after) return out;
        after = page.next;
      }
    } catch {
      return out;
    }
  }

  /**
   * The visuals of what is exported (specs/017 R43): each card's and cycle's pages with every version, saved values and
   * newest pictures, their files (bytes only for the .json), and the widgets - all of the project's for a whole-board
   * export, else the ones the texts use. A place that cannot be read is left out; its texts still hold their snippets.
   */
  async visuals(data: BoardExport, whole: boolean, withData: boolean): Promise<BoardVisuals> {
    const numberOf = new Map(data.cards.map((c) => [c.id, c.number]));
    const cycles = [...new Set([...data.briefs.map((b) => b.cycleId), ...data.cards.map((c) => c.cycleId).filter((c): c is string => !!c)])];
    const places: { place: { card?: string; cycle?: string; project?: string }; owner: ExportedPage['owner']; cardNumber?: number; cycleId?: string }[] = [
      ...data.cards.map((c) => ({ place: { card: c.id }, owner: 'card' as const, cardNumber: c.number })),
      ...cycles.map((id) => ({ place: { cycle: id }, owner: 'cycle' as const, cycleId: id })),
      ...(whole ? [{ place: { project: data.project }, owner: 'project' as const }] : []),
    ];
    const pages: ExportedPage[] = [];
    const states: ExportedState[] = [];
    const shots: ExportedShot[] = [];
    for (const p of places) {
      try {
        const v = await lastValueFrom(this.snippets.visuals(p.place));
        for (const x of v.pages) pages.push({ owner: p.owner, cardNumber: p.cardNumber, cycleId: p.cycleId ?? null, page: x.page, versions: x.versions });
        states.push(...v.states.map((s) => ({ snippetId: s.snippetId, key: s.key, value: s.value, updatedBy: s.updatedBy, at: s.at })));
        shots.push(...v.shots.map((s) => ({ snippetId: s.snippetId, version: s.version, png: s.png, console: s.console ?? '', at: s.at })));
      } catch {
        // not readable (an older Alfred) - the texts keep their snippets
      }
    }
    const pageIds = new Set(pages.map((p) => p.page.id));
    const mapId = (id: string) => exportedSnippetId(id, (c) => numberOf.get(c), pageIds);
    const files: ExportedFile[] = [];
    for (const p of places.filter((x) => x.owner !== 'project')) {
      try {
        const list = await lastValueFrom(this.snippets.files(p.place));
        for (const f of list) {
          let bytes: string | undefined;
          if (withData) {
            try { bytes = await base64(await lastValueFrom(this.snippets.fileBlob(f.id))); } catch { /* removed since */ }
          }
          files.push({ id: f.id, ...(p.cardNumber != null ? { cardNumber: p.cardNumber } : { cycleId: p.cycleId }), name: f.name, mime: f.mime, size: f.size,
            author: f.author, createdAt: f.createdAt, ...(bytes !== undefined ? { data: bytes } : {}) });
        }
      } catch {
        // no files here
      }
    }
    return { pages, states: states.map((s) => ({ ...s, snippetId: mapId(s.snippetId) })), shots: shots.map((s) => ({ ...s, snippetId: mapId(s.snippetId) })),
      files, widgets: await this.widgets(data, whole) };
  }

  /**
   * What the .html export's frames need to run offline: the shelf's code for every library its snippets ask for, and
   * the answers to their declared `alfred/data` blocks read now (the export holds the data as it was when exported).
   */
  async frameKit(data: BoardExport): Promise<FrameKit> {
    const sources: { source: string; info: string; kind: 'html' | 'mermaid' | 'python' }[] = [];
    const fromText = (t: string | null | undefined) => textSnippets(t).forEach((b) => sources.push({ source: b.text, info: b.info, kind: b.lang as 'html' | 'mermaid' | 'python' }));
    data.cards.forEach((c) => fromText(c.description));
    Object.values(data.activity).forEach((list) => list.forEach((e) => fromText(e.text)));
    data.briefs.forEach((b) => { const p = briefParts(b.text ?? ''); fromText(p.goal); fromText(p.sections['description']); p.other.forEach((o) => fromText(o.text)); });
    for (const p of data.visuals?.pages ?? []) {
      if (p.page.kind === 'HTML' || p.page.kind === 'MERMAID') sources.push({ source: p.page.source ?? '', info: p.page.info, kind: p.page.kind === 'MERMAID' ? 'mermaid' : 'html' });
    }
    for (const w of data.visuals?.widgets ?? []) {
      if (w.kind === 'HTML' || w.kind === 'MERMAID') sources.push({ source: w.source ?? '', info: w.info, kind: w.kind === 'MERMAID' ? 'mermaid' : 'html' });
    }
    const libs = new Map<string, SnippetLib>();
    for (const s of sources.filter((x) => x.kind !== 'python')) {
      for (const l of libsForDoc({ libs: infoAttrs(s.info)['libs'], kind: s.kind === 'mermaid' ? 'mermaid' : 'html' })) libs.set(l.id, l);
    }
    let libCode: Record<string, string> = {};
    try { libCode = await this.shelf.inline([...libs.values()]); } catch { /* the frames say a library is missing */ }
    const answers: Record<string, unknown> = {};
    for (const s of sources) {
      for (const d of declaredData(s.source)) {
        const key = staticAnswerKey('data', { src: d.src, args: d.args });
        if (key in answers) continue;
        try { answers[key] = await this.dataSource.read(d.src, d.args, { project: data.project }); } catch { /* not answerable now */ }
      }
    }
    return { origin: (globalThis as { BACKEND_URL?: string }).BACKEND_URL ?? location.origin, libCode, data: answers };
  }

  private async widgets(data: BoardExport, whole: boolean): Promise<WidgetInfo[]> {
    let names: string[];
    try {
      names = (await lastValueFrom(this.snippets.widgets(data.project))).map((w) => w.name);
    } catch {
      return [];
    }
    if (!whole) {
      const used = new Set<string>();
      const scan = (t: string | null | undefined) => { for (const m of (t ?? '').matchAll(/\{\{\s*widget:([A-Za-z0-9][\w-]{0,59})/g)) used.add(m[1]); };
      data.cards.forEach((c) => scan(c.description));
      Object.values(data.activity).forEach((list) => list.forEach((e) => scan(e.text)));
      data.briefs.forEach((b) => scan(b.text));
      names = names.filter((n) => used.has(n));
    }
    const out: WidgetInfo[] = [];
    for (const n of names) {
      try { out.push(await lastValueFrom(this.snippets.widget(data.project, n))); } catch { /* deleted since */ }
    }
    return out;
  }

  /** The pictures the texts show, read one by one; one that is gone is left out (its text still names it). */
  private async images(data: BoardExport): Promise<BoardImageData[]> {
    const out: BoardImageData[] = [];
    for (const id of boardImageIds(data)) {
      try {
        const blob = await lastValueFrom(this.api.image(id));
        out.push({ id, mime: blob.type || 'image/png', data: await base64(blob) });
      } catch {
        // removed since - the text keeps its reference
      }
    }
    return out;
  }

  private allCards(project: string, cycleId: string | null): Observable<CardSummary[]> {
    const page = (offset: number) => this.api.cards(project, cycleId, NO_FILTERS, offset, 500);
    return page(0).pipe(
      expand((p, i) => ((i + 1) * 500 < p.total ? page((i + 1) * 500) : EMPTY)),
      reduce((all, p) => [...all, ...p.cards], [] as CardSummary[]),
    );
  }

  private cycleParts(cycleIds: readonly string[]): Observable<{ briefs: CycleBrief[]; specs: BoardSpecFile[]; marks: ChecklistMark[] }> {
    if (!cycleIds.length) return of({ briefs: [], specs: [], marks: [] });
    return forkJoin(cycleIds.map((id) => forkJoin({
      brief: this.api.brief(id).pipe(catchError(() => of(null))),
      specs: this.api.specs(id).pipe(
        mergeMap((files) => (files.length ? forkJoin(files.map((f) => this.api.spec(id, f.name).pipe(
          map((content) => ({ cycleId: id, name: f.name, content, uploadedAt: f.uploadedAt }))))) : of([] as BoardSpecFile[]))),
        catchError(() => of([] as BoardSpecFile[]))),
      marks: this.api.checklist(id).pipe(
        map((files) => files.flatMap((f) => f.items.map((i) => i.mark).filter((m): m is ChecklistMark => !!m))),
        catchError(() => of([] as ChecklistMark[]))),
    }))).pipe(map((all) => ({
      briefs: all.map((a) => a.brief).filter((b): b is CycleBrief => !!b && !!b.text),
      specs: all.flatMap((a) => a.specs),
      marks: all.flatMap((a) => a.marks),
    })));
  }
}


function base64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).replace(/^data:[^,]*,/, ''));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}
