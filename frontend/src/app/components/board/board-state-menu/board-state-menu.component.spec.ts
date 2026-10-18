import { TestBed } from '@angular/core/testing';
import { of } from 'rxjs';
import { BoardSummary } from '../../../core/models/board.models';
import { BoardApiService } from '../../../core/services/board-api.service';
import { ConfirmDialogService } from '../../../core/services/confirm-dialog.service';
import { BoardStateMenuComponent } from './board-state-menu.component';

const summary = (state: 'OPEN' | 'DONE' | 'ARCHIVED'): BoardSummary => ({
  board: { id: 'b1', project: 'odeysys', name: 'AB#1 x', isDefault: false, state, migratedFrom: null, createdAt: '', updatedAt: '' },
  cards: 0, cycleIds: [], boardIds: [], linkedItem: null });

describe('BoardStateMenuComponent (specs/032 T042)', () => {
  let api: { updateBoard: jasmine.Spy; deleteBoard: jasmine.Spy };
  let confirm: jasmine.Spy;

  function render(state: 'OPEN' | 'DONE' | 'ARCHIVED') {
    api = { updateBoard: jasmine.createSpy('update').and.returnValue(of({})), deleteBoard: jasmine.createSpy('delete').and.returnValue(of(undefined)) };
    confirm = jasmine.createSpy('confirm').and.resolveTo(false);
    TestBed.configureTestingModule({ imports: [BoardStateMenuComponent], providers: [
      { provide: BoardApiService, useValue: api }, { provide: ConfirmDialogService, useValue: { confirm } }] });
    const f = TestBed.createComponent(BoardStateMenuComponent);
    f.componentRef.setInput('summary', summary(state));
    f.detectChanges();
    (f.nativeElement.querySelector('.sel') as HTMLButtonElement).click();
    f.detectChanges();
    return { f, el: f.nativeElement as HTMLElement, items: () => Array.from(f.nativeElement.querySelectorAll('.mi')).map((m) => (m as Element).firstChild?.textContent?.trim()) };
  }

  it('an open board: Mark done, Archive, Delete board… - each with what it does', () => {
    const { el, items } = render('OPEN');
    expect(el.querySelector('.sel')!.textContent).toContain('Open');
    expect(items()).toEqual(['✓ Mark done', '⌂ Archive', '✕ Delete board…']);
    expect(el.textContent).toContain('it stays in the board list');
  });

  it('a done board offers Reopen', () => {
    const { items, f } = render('DONE');
    expect(items()).toEqual(['⌂ Archive', '↺ Reopen', '✕ Delete board…']);
    (f.nativeElement.querySelectorAll('.mi')[1] as HTMLButtonElement).click();
    expect(api.updateBoard).toHaveBeenCalledWith('b1', { state: 'OPEN' });
  });

  it('delete still asks first', async () => {
    const { f } = render('OPEN');
    await f.componentInstance.remove();
    expect(confirm).toHaveBeenCalled();
    expect(api.deleteBoard).not.toHaveBeenCalled();
  });
});
