import { Injectable, inject } from '@angular/core';
import { Observable, expand, forkJoin, from, lastValueFrom, map, mergeMap, of, reduce, toArray, EMPTY, catchError } from 'rxjs';
import { ActivityEntry, CardSummary, ChecklistMark, CycleBrief, NO_FILTERS } from '../models/board.models';
import { BoardExport, BoardSpecFile, boardJsonFilename, buildBoardJsonLines } from '../../shared/utils/board-json';
import { buildBoardHtmlParts } from '../../shared/utils/board-html-builder';
import { buildBoardMarkdownLines } from '../../shared/utils/board-md-builder';
import { downloadBlob } from '../../shared/utils/download';
import { exportBlob } from '../../shared/utils/export-file-io';
import { BoardApiService } from './board-api.service';

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
    const data = await this.gather(project, cycleId, ids);
    const name = boardJsonFilename(project, cycleId ? title : null).replace(/\.json$/, `.${format}`);
    if (format === 'json') {
      downloadBlob(await exportBlob(buildBoardJsonLines(data), false), name);
    } else if (format === 'md') {
      downloadBlob(new Blob(buildBoardMarkdownLines(data, title).map((l) => `${l}\n`), { type: 'text/markdown' }), name);
    } else {
      downloadBlob(new Blob(buildBoardHtmlParts(data, title), { type: 'text/html' }), name);
    }
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

