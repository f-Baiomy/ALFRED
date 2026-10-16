import { Injectable, inject } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { RetestCheck, onlyEmptyAnswers, verifyGaps } from '../models/board.models';
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
    // specs/026: a Fixed card is ready when it is implemented AND it worked; anything less asks first (empty answers below)
    const gaps = check && check.status === 'FIXED' && !onlyEmptyAnswers(check) ? verifyGaps(check) : [];
    if (gaps.length) {
      const pick = await this.dialog.choose(
        `Move #${card.number} to Verified? ${gaps.map((g) => g.charAt(0).toUpperCase() + g.slice(1)).join('. ')}.`,
        [
          { value: 'ask', label: 'Ask Claude to verify it', hint: `It stays in Fixed; Claude runs /alfred-verify ${card.number} - the code and the calls` },
          { value: 'anyway', label: 'Verify anyway', hint: 'Your call - the card keeps what was not checked in its re-test' },
        ],
        'ask', 'Go', 'Keep in Fixed');
      if (pick === 'anyway') {
        move();
        return 'moved';
      }
      if (pick === 'ask') {
        this.api.comment(card.id, `Verify #${card.number} please: ${gaps.join('; ')}. Check that it is implemented (the commit on the task branch, `
          + 'in the running build, every layer) and that it worked on the calls since the fix - /alfred-verify.').subscribe({ error: () => undefined });
        return 'asked';
      }
      return 'kept';
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
