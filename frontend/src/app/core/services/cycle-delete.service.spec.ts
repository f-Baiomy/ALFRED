import { TestBed } from '@angular/core/testing';
import { of } from 'rxjs';
import { BoardApiService } from './board-api.service';
import { ConfirmDialogService } from './confirm-dialog.service';
import { CycleDeleteService } from './cycle-delete.service';

describe('CycleDeleteService', () => {
  let deleteCycleCards: jasmine.Spy;
  let totals: Record<string, { total: number; open: number }>;
  let dialog: ConfirmDialogService;

  beforeEach(() => {
    totals = {};
    deleteCycleCards = jasmine.createSpy('deleteCycleCards').and.returnValue(of({ deleted: 1 }));
    TestBed.configureTestingModule({ providers: [{ provide: BoardApiService, useValue: {
      cards: (_p: string, cycleId: string) => of({ cards: [], total: totals[cycleId]?.total ?? 0, counts: { open: totals[cycleId]?.open ?? 0, fixed: 0, done: 0 } }),
      deleteCycleCards,
    } }] });
    dialog = TestBed.inject(ConfirmDialogService);
  });

  it('asks plainly when the cycle has no cards', async () => {
    const asked = TestBed.inject(CycleDeleteService).confirmAndClean(['c1'], 'Delete "x"?');
    await Promise.resolve();
    await new Promise((r) => setTimeout(r));
    expect(dialog.state()?.choices).toBeUndefined();
    dialog.respond(true);
    expect(await asked).toBeTrue();
    expect(deleteCycleCards).not.toHaveBeenCalled();
  });

  it('offers to delete the cards, picked by default, and deletes them first', async () => {
    totals['c1'] = { total: 6, open: 2 };
    const asked = TestBed.inject(CycleDeleteService).confirmAndClean(['c1'], 'Delete "x"?');
    await new Promise((r) => setTimeout(r));
    const s = dialog.state()!;
    expect(s.chosen).toBe('delete');
    expect(s.choices!.map((c) => c.label)).toEqual(['Delete its 6 cards too', 'Keep its 6 cards on the project board']);
    expect(s.choices![0].hint).toContain('2 open, 4 closed');
    dialog.respond(true);
    expect(await asked).toBeTrue();
    expect(deleteCycleCards).toHaveBeenCalledWith('c1');
  });

  it('keeps the cards when asked, and deletes nothing on Cancel', async () => {
    totals['c1'] = { total: 2, open: 0 };
    const service = TestBed.inject(CycleDeleteService);
    let asked = service.confirmAndClean(['c1'], 'Delete?');
    await new Promise((r) => setTimeout(r));
    dialog.pick('keep');
    dialog.respond(true);
    expect(await asked).toBeTrue();
    asked = service.confirmAndClean(['c1'], 'Delete?');
    await new Promise((r) => setTimeout(r));
    dialog.respond(false);
    expect(await asked).toBeFalse();
    expect(deleteCycleCards).not.toHaveBeenCalled();
  });
});
