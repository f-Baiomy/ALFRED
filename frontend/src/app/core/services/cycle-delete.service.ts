import { Injectable, inject } from '@angular/core';
import { Observable, catchError, concatMap, firstValueFrom, forkJoin, from, map, of, toArray } from 'rxjs';
import { NO_FILTERS } from '../models/board.models';
import { BoardApiService } from './board-api.service';
import { ConfirmDialogService } from './confirm-dialog.service';

/** How many board cards the cycles about to be deleted hold, and how many of them are still open. */
export interface CycleCards {
  readonly total: number;
  readonly open: number;
}

/**
 * Deleting cycles asks what to do with their board cards (the board keeps them otherwise, marked "cycle deleted"):
 * delete them too - the default - or keep them on the project board. Cards go first, then the caller deletes the
 * cycles; the cycle's brief, spec files and checklist are removed by the backend with the cycle either way.
 */
@Injectable({ providedIn: 'root' })
export class CycleDeleteService {
  private readonly board = inject(BoardApiService);
  private readonly confirm = inject(ConfirmDialogService);

  /** The cards of these cycles; a board that cannot be read counts as none. */
  count(cycleIds: readonly string[]): Observable<CycleCards> {
    if (!cycleIds.length) return of({ total: 0, open: 0 });
    return forkJoin(cycleIds.map((id) => this.board.cards('', id, NO_FILTERS, 0, 1).pipe(
      map((p) => ({ total: p.total, open: p.counts.open })),
      catchError(() => of({ total: 0, open: 0 })),
    ))).pipe(map((all) => all.reduce((a, b) => ({ total: a.total + b.total, open: a.open + b.open }), { total: 0, open: 0 })));
  }

  /**
   * Asks to delete the cycles, with the choice for their cards when they have any; deletes the cards when chosen.
   * Resolves to false when the user cancelled - the caller then deletes nothing.
   */
  async confirmAndClean(cycleIds: readonly string[], question: string): Promise<boolean> {
    const cards = await firstValueFrom(this.count(cycleIds));
    if (!cards.total) {
      return this.confirm.confirm(question);
    }
    const n = cards.total === 1 ? '1 card' : `${cards.total} cards`;
    const closed = cards.total - cards.open;
    const choice = await this.confirm.choose(`${question} The board's brief, spec files and checklist go with ${cycleIds.length === 1 ? 'it' : 'them'}.`, [
      { value: 'delete', label: `Delete ${cycleIds.length === 1 ? 'its' : 'their'} ${n} too`, hint: ` · ${cards.open} open, ${closed} closed - cannot be undone` },
      { value: 'keep', label: `Keep ${cycleIds.length === 1 ? 'its' : 'their'} ${n} on the project board`, hint: ' · marked "cycle deleted", history kept' },
    ], 'delete');
    if (choice === null) return false;
    if (choice === 'delete') {
      await firstValueFrom(from(cycleIds).pipe(
        concatMap((id) => this.board.deleteCycleCards(id).pipe(catchError(() => of({ deleted: 0 })))),
        toArray(),
      ));
    }
    return true;
  }
}
