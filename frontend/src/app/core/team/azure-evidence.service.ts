import { Injectable, inject } from '@angular/core';
import { catchError, forkJoin, lastValueFrom, map, of } from 'rxjs';
import { CallRecord } from '../models/call.model';
import { BoardApiService } from '../services/board-api.service';
import { CallsApiService } from '../services/calls-api.service';
import { RedactionsApiService } from '../services/redactions-api.service';
import { SessionCyclesApiService } from '../services/session-cycles-api.service';
import { callOf } from '../../shared/utils/mention-syntax';
import { azureEvidenceHtml } from './azure-export';

/**
 * Builds the evidence file a consent bundle attaches to a work item (specs/028 FR-079): the card's mentioned calls, read in
 * full, as Alfred's HTML export with the user's redactions and the always-masked headers - unless sent unmasked.
 */
@Injectable({ providedIn: 'root' })
export class AzureEvidenceService {
  private readonly board = inject(BoardApiService);
  private readonly calls = inject(CallsApiService);
  private readonly cycles = inject(SessionCyclesApiService);
  private readonly redactions = inject(RedactionsApiService);

  async build(cardId: string, unmasked: boolean): Promise<{ blob: Blob; calls: number; missing: number }> {
    const card = await lastValueFrom(this.board.card(cardId));
    const refs = card.links.map((l) => callOf(l)).filter((r): r is NonNullable<ReturnType<typeof callOf>> => !!r);
    const read = await Promise.all(refs.map((r) => {
      const source = r.direction === 'in' ? 'internal' : 'external';
      const detail = r.cycleId ? this.cycles.getDetail(r.cycleId, r.id, source) : this.calls.getDetail(r.id, source);
      return lastValueFrom(forkJoin({ summary: this.calls.getSummary(r.id, source), detail }).pipe(
        map(({ summary, detail }) => ({ ...summary, source, ...detail }) as CallRecord),
        catchError(() => of(null)),
      ));
    }));
    const found = read.filter((c): c is CallRecord => !!c);
    const user = await lastValueFrom(this.redactions.listAll().pipe(catchError(() => of([]))));
    const html = azureEvidenceHtml(found, user, unmasked, `#${card.number} ${card.title}`);
    return { blob: new Blob([html], { type: 'text/html' }), calls: found.length, missing: read.length - found.length };
  }
}
