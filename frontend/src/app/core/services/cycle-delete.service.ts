import { Injectable, inject } from '@angular/core';
import { Observable, catchError, firstValueFrom, forkJoin, map, of } from 'rxjs';
import { CycleDeletePlan } from '../models/board.models';
import { BoardApiService } from './board-api.service';
import { ConfirmDialogService } from './confirm-dialog.service';

/**
 * Deleting cycles (specs/027 US6): a cycle only holds calls - its cards, brief and chat live on boards and stay. What a
 * board mentions is kept: such a cycle stays as "kept from <name>" with only the mentioned calls, and the dialog says
 * so, board by board, before the user confirms.
 */
@Injectable({ providedIn: 'root' })
export class CycleDeleteService {
  private readonly board = inject(BoardApiService);
  private readonly confirm = inject(ConfirmDialogService);

  /** The plans of these cycles; a board that cannot be read keeps nothing. */
  plans(cycleIds: readonly string[]): Observable<readonly CycleDeletePlan[]> {
    if (!cycleIds.length) return of([]);
    return forkJoin(cycleIds.map((id) => this.board.cycleDeletePlan(id).pipe(
      catchError(() => of<CycleDeletePlan>({ cycleId: id, keep: [], callIds: [] })),
    )));
  }

  /** Asks to delete the cycles, saying what boards keep. Resolves to false when the user cancelled. */
  async confirmAndClean(cycleIds: readonly string[], question: string): Promise<boolean> {
    const plans = await firstValueFrom(this.plans(cycleIds).pipe(map((p) => p.filter((x) => x.callIds.length))));
    return this.confirm.confirm(plans.length ? `${question} ${keptText(plans)}` : question);
  }
}

/** "Boards mention 3 of its calls - Refund (2 calls, #12 #14), Sprint (1 call): it stays as "kept from …" with only those." */
export function keptText(plans: readonly CycleDeletePlan[]): string {
  const calls = new Set(plans.flatMap((p) => p.callIds)).size;
  const boards = new Map<string, { calls: Set<string>; cards: Set<number> }>();
  for (const p of plans) {
    for (const k of p.keep) {
      const b = boards.get(k.name) ?? { calls: new Set<string>(), cards: new Set<number>() };
      k.callIds.forEach((c) => b.calls.add(c));
      k.cards.forEach((c) => b.cards.add(c));
      boards.set(k.name, b);
    }
  }
  const per = [...boards].map(([name, b]) => `${name} (${b.calls.size} call${b.calls.size === 1 ? '' : 's'}`
    + `${b.cards.size ? ', ' + [...b.cards].map((n) => '#' + n).join(' ') : ''})`);
  const which = plans.length === 1 ? 'it stays' : `${plans.length} of them stay`;
  return `Boards mention ${calls} of the calls - ${per.join(', ')}: ${which} as "kept from …" with only those calls; the rest are deleted.`
    + ' Cards, briefs and chats live on their boards and stay.';
}
