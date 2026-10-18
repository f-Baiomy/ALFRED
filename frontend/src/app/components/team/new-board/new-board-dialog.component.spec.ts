import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { of, throwError } from 'rxjs';
import { BoardApiService } from '../../../core/services/board-api.service';
import { DbCaptureApiService } from '../../../core/services/db-capture-api.service';
import { TeamApiService } from '../../../core/team/team-api.service';
import { TeamStateService } from '../../../core/team/team-state.service';
import { boardNameFor } from '../../../core/team/team.models';
import { TeamNewBoardDialogComponent } from './new-board-dialog.component';

const TITLE = 'Q4-INTE-CORE-015 Baggage Bundle Choice Display & Ancillary Clarification "Air Arabia"';

describe('TeamNewBoardDialogComponent (specs/029)', () => {
  function setUp(target: unknown = null, existing: string[] = [], linkedItem: string | null = null) {
    const api = {
      itemTarget: jasmine.createSpy('itemTarget').and.returnValue(of(target)),
      newBoardFromItem: jasmine.createSpy('newBoardFromItem'),
    };
    const boards = {
      boards: jasmine.createSpy('boards').and.returnValue(of(existing.map((name, i) => ({ board: { id: 'b' + i, name, project: 'odeysys', isDefault: false }, cards: 0,
        cycleIds: [], boardIds: [], linkedItem })))),
    };
    TestBed.configureTestingModule({
      imports: [TeamNewBoardDialogComponent],
      providers: [
        provideRouter([]),
        { provide: TeamApiService, useValue: api },
        { provide: BoardApiService, useValue: boards },
        { provide: DbCaptureApiService, useValue: { projects: () => of([{ project: 'odeysys' }, { project: 'core' }]) } },
        { provide: TeamStateService, useValue: { ui: () => ({ word: (w: string) => w }), startVersion: signal(0) } },
      ],
    });
    const f = TestBed.createComponent(TeamNewBoardDialogComponent);
    f.componentRef.setInput('conn', 'c1');
    f.componentRef.setInput('extId', '59851');
    f.componentRef.setInput('title', TITLE);
    f.componentRef.setInput('squad', 'Commandos');
    f.detectChanges();
    return { f, api, boards, el: f.nativeElement as HTMLElement };
  }

  it('names a board "#id_title" and cuts a long title at a word', () => {
    expect(boardNameFor('59851', 'Refund  a card ')).toBe('#59851_Refund a card');
    const long = boardNameFor('1', 'word '.repeat(60));
    expect(long.length).toBeLessThanOrEqual(120);
    expect(long.endsWith('word…')).toBeTrue();
  });

  it('opens with the default name, the mapped project, main on and a new cycle, and makes the board', async () => {
    const { f, api, el } = setUp({ project: 'core', boardId: null });
    await f.whenStable();
    f.detectChanges();
    const c = f.componentInstance;
    expect(c.name).toBe('#59851_' + TITLE);
    expect(c.project).toBe('core');
    expect(c.main).toBeTrue();
    expect(c.cycle).toBe('NEW');
    expect(c.remember).toBeFalse(); // a mapping named it already
    expect(el.textContent).toContain('From the mapping for this item');

    api.newBoardFromItem.and.returnValue(of({ boardId: 'nb1', project: 'core', name: c.name, main: true, cycle: 'NEW', files: null, note: null }));
    const made = jasmine.createSpy('made');
    c.changed.subscribe(made);
    c.create();
    f.detectChanges();
    expect(api.newBoardFromItem).toHaveBeenCalledWith('c1', '59851', { project: 'core', name: '#59851_' + TITLE, main: true, cycle: 'NEW',
      attachments: false, remember: false });
    expect(made).toHaveBeenCalled();
    expect(el.textContent).toContain('★ Main item of');
    expect(el.textContent).toContain('cycle made, not recording');

    const router = TestBed.inject(Router);
    spyOn(router, 'navigate').and.resolveTo(true);
    c.openBoard('core', 'nb1');
    expect(router.navigate).toHaveBeenCalledWith(['/board'], { queryParams: { project: 'core', board: 'nb1' } });
  });

  it('a name the project uses already is refused before sending, with Open it', async () => {
    const { f, api, el } = setUp(null, ['#59851_' + TITLE.toUpperCase()]);
    await f.whenStable();
    f.detectChanges();
    const c = f.componentInstance;
    expect(c.project).toBe('odeysys');
    expect(c.taken()?.board.id).toBe('b0');
    expect(el.textContent).toContain('already called that');
    c.create();
    expect(api.newBoardFromItem).not.toHaveBeenCalled();

    c.name = 'Another look';
    c.nameEdited();
    f.detectChanges();
    expect(c.taken()).toBeNull();
    api.newBoardFromItem.and.returnValue(throwError(() => ({ error: { error: 'INVALID', message: 'Alfred has no project odeysys' } })));
    c.create();
    f.detectChanges();
    expect(el.textContent).toContain('Alfred has no project odeysys');
  });

  it('says first when the item already has its board, with Open board, and does not make it main twice', async () => {
    const { f, el } = setUp(null, ['#59851_' + TITLE], 'c1/59851');
    await f.whenStable();
    f.detectChanges();
    const c = f.componentInstance;
    expect(c.itsBoard()?.board.id).toBe('b0');
    expect(el.querySelector('.tnb-have')?.textContent).toContain('AB#59851 already has a board');
    expect(c.main).toBeFalse();
    const router = TestBed.inject(Router);
    spyOn(router, 'navigate').and.resolveTo(true);
    (el.querySelector('.tnb-have button') as HTMLButtonElement).click();
    expect(router.navigate).toHaveBeenCalledWith(['/board'], { queryParams: { project: 'odeysys', board: 'b0' } });
  });
});
