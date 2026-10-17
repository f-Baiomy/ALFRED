import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { of, throwError } from 'rxjs';
import { BoardApiService } from '../../../core/services/board-api.service';
import { DbCaptureApiService } from '../../../core/services/db-capture-api.service';
import { TeamApiService } from '../../../core/team/team-api.service';
import { TeamStateService } from '../../../core/team/team-state.service';
import { TeamItem } from '../../../core/team/team.models';
import { TeamStartButtonComponent } from './start-button.component';

const ITEM: TeamItem = { conn: 'c1', extId: '7', type: 'Bug', customType: false, title: 'Refund fails', state: 'Active', assignee: null,
  squad: 'Payments', sprint: null, area: null, url: 'https://x/7', rev: 1, changedAt: null };

describe('TeamStartButtonComponent (specs/027 US8)', () => {
  function setUp(linkedBoard: string | null = null, startState: string | null = null) {
    const api = {
      start: jasmine.createSpy('start'),
      cancelStart: jasmine.createSpy('cancelStart').and.returnValue(of(undefined)),
    };
    const boards = { boards: jasmine.createSpy('boards').and.returnValue(of([])), board: () => of({ board: { project: 'odeysys' } }),
      recordForBoard: jasmine.createSpy('recordForBoard') };
    TestBed.configureTestingModule({
      imports: [TeamStartButtonComponent],
      providers: [
        provideRouter([]),
        { provide: TeamApiService, useValue: api },
        { provide: BoardApiService, useValue: boards },
        { provide: DbCaptureApiService, useValue: { projects: () => of([{ project: 'odeysys' }]) } },
        { provide: TeamStateService, useValue: { ui: () => ({ word: (w: string) => w }), tokens: { has: () => false } } },
      ],
    });
    const f = TestBed.createComponent(TeamStartButtonComponent);
    f.componentRef.setInput('item', ITEM);
    f.componentRef.setInput('linkedBoard', linkedBoard);
    f.componentRef.setInput('startState', startState);
    f.detectChanges();
    return { f, api, el: f.nativeElement as HTMLElement };
  }

  it('an unmapped item asks where its board goes, then starts there and remembers it', () => {
    const { f, api, el } = setUp();
    api.start.and.returnValues(throwError(() => ({ error: { error: 'NEEDS_TARGET' } })),
      of({ state: 'WAITING', project: 'odeysys', boardId: null, messageId: 9, attachmentsFetched: 0, message: null }));
    f.componentInstance.start(null);
    f.detectChanges();
    expect(el.querySelector('.tsb-dialog')).toBeTruthy();

    f.componentInstance.pick();
    f.detectChanges();
    expect(api.start.calls.mostRecent().args).toEqual(['c1', '7', { project: 'odeysys', boardId: null, remember: true }]);
    expect(el.querySelector('.tsb-dialog')).toBeNull();
    expect(el.textContent).toContain('Waiting for /alfred-setup');
  });

  it('a waiting start can be cancelled; a board shows Open task', () => {
    const waiting = setUp(null, 'WAITING');
    expect(waiting.el.textContent).toContain('Waiting for /alfred-setup');
    waiting.f.componentInstance.cancel();
    waiting.f.detectChanges();
    expect(waiting.api.cancelStart).toHaveBeenCalledWith('c1', '7');
    expect(waiting.el.textContent).toContain('Start');

    TestBed.resetTestingModule();
    const linked = setUp('b-refund');
    expect(linked.el.textContent).toContain('Open task ▾');
  });
});
