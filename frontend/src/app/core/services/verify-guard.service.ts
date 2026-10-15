import { Injectable, inject } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { RetestCheck, onlyEmptyAnswers } from '../models/board.models';
import { BoardApiService } from './board-api.service';
import { ConfirmDialogService } from './confirm-dialog.service';

/** The card a move to Verified is about. */
export interface VerifyTarget {
  readonly id: string;
  readonly number: number;
  readonly project: string;
}

/**
 * Moving a card to Verified (specs/020, docs/board.md "Re-test"): when every re-test answer since the fix was empty -
 * 0 rows - the behaviour the card is about was never seen, so the move asks first. Keep in Fixed, ask Claude for a
 * re-test with data, or verify anyway - then the re-test is recorded first, and the card's guard says "verified on
 * empty answers only" for as long as it stands. Verified stays the user's: nothing here refuses the move.
 */
@Injectable({ providedIn: 'root' })
export class VerifyGuardService {
  private readonly api = inject(BoardApiService);
  private readonly dialog = inject(ConfirmDialogService);

  /** Runs {@code move} - straight away, or after the user chose to verify a card whose answers were all empty. */
  async verify(card: VerifyTarget, move: () => void): Promise<'moved' | 'kept' | 'asked'> {
    let check: RetestCheck | null = null;
    try {
      check = (await firstValueFrom(this.api.cardRetest(card.id))).check;
    } catch {
      check = null; // an Alfred without the re-test: move as before
    }
    if (!onlyEmptyAnswers(check)) {
      move();
      return 'moved';
    }
    const n = check!.calls.length;
    const pick = await this.dialog.choose(
      `Move #${card.number} to Verified? Every re-test answer was empty: ${n} call${n === 1 ? '' : 's'} since the fix, all with 0 rows. `
        + 'The behaviour this card is about was never seen working on data.',
      [
        { value: 'ask', label: 'Ask Claude for a re-test with data', hint: 'It stays in Fixed; Claude adds re-test steps that need rows' },
        { value: 'anyway', label: 'Verify anyway', hint: 'The card then shows "verified on empty answers only"' },
      ],
      'ask', 'Go', 'Keep in Fixed');
    if (pick === 'anyway') {
      try {
        await firstValueFrom(this.api.retestRun(card.project, [card.number], null)); // the record the guard reads back
      } catch {
        // the move is still the user's
      }
      move();
      return 'moved';
    }
    if (pick === 'ask') {
      this.api.comment(card.id, `Re-test with data please: every re-test answer so far was empty (${n} call${n === 1 ? '' : 's'}, 0 rows). `
        + 'Add re-test steps whose calls return rows, so the fix can be seen working.').subscribe({ error: () => undefined });
      return 'asked';
    }
    return 'kept';
  }
}
