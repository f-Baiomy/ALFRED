import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { of, throwError } from 'rxjs';
import { BoardApiService } from '../../../core/services/board-api.service';
import { DbCaptureApiService } from '../../../core/services/db-capture-api.service';
import { TeamApiService } from '../../../core/team/team-api.service';
import { TeamStateService } from '../../../core/team/team-state.service';
import { TeamItem } from '../../../core/team/team.models';
import { TeamStartButtonComponent } from './start-button.component';

const ITEM: TeamItem = { extId: '7', type: 'Bug', customType: false, title: 'Refund fails', state: 'Active', assignee: null,
  squad: 'Payments', sprint: null, area: null, url: 'https://x/7', rev: 1, changedAt: null, changedBy: null, fields: {}, links: [],
  identities: {}, project: 'Shop' };

describe('TeamStartButtonComponent (specs/027 US8)', () => {
  function setUp(linkedBoard: string | null = null, startState: string | null = null, waiting: unknown = null) {
    const api = {
      start: jasmine.createSpy('start'),
      waitingStart: jasmine.createSpy('waitingStart').and.returnValue(of(waiting)),
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
        { provide: TeamStateService, useValue: { ui: () => ({ word: (w: string) => w }), tokens: { has: () => false }, startVersion: signal(0) } },
      ],
    });
    const f = TestBed.createComponent(TeamStartButtonComponent);
    f.componentRef.setInput('item', ITEM);
    f.componentRef.setInput('conn', 'c1');
    f.componentRef.setInput('linkedBoard', linkedBoard);
    f.componentRef.setInput('startState', startState);
    f.detectChanges();
    return { f, api, el: f.nativeElement as HTMLElement };
  }

  it('an unmapped item asks where its board goes, then starts there and remembers it', () => {
    const { f, api, el } = setUp();
    api.start.and.returnValues(throwError(() => ({ error: { error: 'NEEDS_TARGET' } })),
      of({ state: 'WAITING', project: 'odeysys', boardId: null, messageId: 9, attachmentsFetched: 0, answeredBy: null,
        message: 'Nobody is live for odeysys: start /alfred-live there' }));
    f.componentInstance.start(null);
    f.detectChanges();
    expect(el.querySelector('.tsb-form')).toBeTruthy();

    f.componentInstance.pick();
    f.detectChanges();
    expect(api.start.calls.mostRecent().args).toEqual(['c1', '7', { project: 'odeysys', boardId: null, remember: true }]);
    expect(el.querySelector('.tsb-form')).toBeNull();
    expect(el.textContent).toContain('Waiting for /alfred-setup');
    expect(el.textContent).toContain('Nobody is live for odeysys');
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

  it('a start posted earlier shows as waiting when the item is opened again, with its chat', () => {
    const { f, el } = setUp(null, null, { project: 'odeysys', boardId: null, messageId: 9, at: new Date(Date.now() - 5 * 60000).toISOString() });
    f.detectChanges();
    expect(f.componentInstance.waiting()).toBeTrue();
    expect(el.textContent).toContain('Waiting for /alfred-setup in the odeysys chat - posted 5 min ago');
    expect(Array.from(el.querySelectorAll('button')).some((b) => b.textContent?.includes('Open chat'))).toBeTrue();
  });
});
