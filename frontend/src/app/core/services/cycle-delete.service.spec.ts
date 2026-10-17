import { TestBed } from '@angular/core/testing';
import { of } from 'rxjs';
import { CycleDeletePlan } from '../models/board.models';
import { BoardApiService } from './board-api.service';
import { ConfirmDialogService } from './confirm-dialog.service';
import { CycleDeleteService, keptText } from './cycle-delete.service';

describe('CycleDeleteService', () => {
  let plans: Record<string, CycleDeletePlan>;
  let dialog: ConfirmDialogService;

  beforeEach(() => {
    plans = {};
    TestBed.configureTestingModule({ providers: [{ provide: BoardApiService, useValue: {
      cycleDeletePlan: (id: string) => of(plans[id] ?? { cycleId: id, keep: [], callIds: [] }),
    } }] });
    dialog = TestBed.inject(ConfirmDialogService);
  });

  it('asks plainly when no board mentions its calls', async () => {
    const asked = TestBed.inject(CycleDeleteService).confirmAndClean(['c1'], 'Delete "x"?');
    await new Promise((r) => setTimeout(r));
    expect(dialog.state()?.message).toBe('Delete "x"?');
    dialog.respond(true);
    expect(await asked).toBeTrue();
  });

  it('says what each board keeps before the user confirms; Cancel deletes nothing', async () => {
    plans['c1'] = { cycleId: 'c1', callIds: ['a1', 'a2'], keep: [{ boardId: 'b1', name: 'Refund', callIds: ['a1', 'a2'], cards: [12, 14] }] };
    const asked = TestBed.inject(CycleDeleteService).confirmAndClean(['c1'], 'Delete "x"?');
    await new Promise((r) => setTimeout(r));
    expect(dialog.state()?.message).toContain('Refund (2 calls, #12 #14)');
    expect(dialog.state()?.message).toContain('kept from');
    dialog.respond(false);
    expect(await asked).toBeFalse();
  });

  it('counts a call two boards mention once', () => {
    expect(keptText([{ cycleId: 'c1', callIds: ['a1'], keep: [
      { boardId: 'b1', name: 'Refund', callIds: ['a1'], cards: [] }, { boardId: 'b2', name: 'Sprint', callIds: ['a1'], cards: [3] }] }]))
      .toContain('Boards mention 1 of the calls - Refund (1 call), Sprint (1 call, #3)');
  });
});
