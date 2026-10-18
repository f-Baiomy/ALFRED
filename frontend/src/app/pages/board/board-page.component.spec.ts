import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ActivatedRoute, convertToParamMap, provideRouter } from '@angular/router';
import { Subject, of } from 'rxjs';
import { BoardSummary } from '../../core/models/board.models';
import { SessionsStateService } from '../../core/state/sessions-state.service';
import { BoardPageComponent } from './board-page.component';

const NAME = '#59851_Q4-INTE-CORE-015 Baggage Bundle Choice Display & Ancillary Clarification "Air Arabia"';
const summary = (id: string, isDefault: boolean): BoardSummary => ({
  board: { id, project: 'odeysys', name: isDefault ? 'odeysys' : NAME, isDefault, state: 'OPEN', migratedFrom: null, createdAt: '', updatedAt: '' },
  cards: 0, cycleIds: [], boardIds: [], linkedItem: isDefault ? null : 'c1/59851' });

describe('BoardPageComponent header (specs/032 T040)', () => {
  function render(board: string, isDefault: boolean) {
    TestBed.configureTestingModule({
      imports: [BoardPageComponent],
      providers: [provideHttpClient(), provideHttpClientTesting(), provideRouter([]),
        { provide: ActivatedRoute, useValue: { queryParamMap: of(convertToParamMap({ project: 'odeysys', board })),
          snapshot: { queryParamMap: convertToParamMap({ project: 'odeysys', board }) } } }],
    });
    const sessions = TestBed.inject(SessionsStateService);
    spyOn(sessions, 'start');
    (sessions as unknown as { events$: Subject<unknown> }).events$ = new Subject();
    const f = TestBed.createComponent(BoardPageComponent);
    f.detectChanges();
    const http = TestBed.inject(HttpTestingController);
    http.match((r) => r.url.endsWith(`/board/boards/${encodeURIComponent(board)}`)).forEach((r) => r.flush(summary(board, isDefault)));
    http.match((r) => r.url.endsWith('/stage')).forEach((r) => r.flush({ stage: 'DEFINE', ref: 'AB#59851', next: '/alfred-setup AB#59851 - x',
      counts: { brief: false, items: 0, inbox: 0, waitingOnUser: 0, toDo: 0, inProgress: 0, fixed: 0, untested: 0, failing: 0, unmarked: 0 },
      step: { kind: 'CLAUDE', skill: 'alfred-setup', command: '/alfred-setup AB#59851', count: 0 } }));
    f.detectChanges();
    return { f, el: f.nativeElement as HTMLElement, http };
  }

  afterEach(() => TestBed.inject(HttpTestingController).match(() => true));

  it('a task board: one header row - no <h1> - with the ref chip and the plain title, its full name in the tooltip', () => {
    const { el } = render('b1', false);
    expect(el.querySelector('h1')).toBeNull();
    expect(el.querySelectorAll('.bp-head').length).toBe(1);
    expect(el.querySelector('.bp-id')!.textContent).toBe('AB#59851');
    const title = el.querySelector('.bp-title') as HTMLElement;
    expect(title.textContent).toBe('Baggage Bundle Choice Display & Ancillary Clarification "Air Arabia"');
    expect(title.title).toBe(NAME);
    expect(el.querySelector('app-board-state-menu')).not.toBeNull();
    expect(el.querySelector('app-board-facts')).not.toBeNull();
    expect(el.querySelector('app-stage-strip .stages')).not.toBeNull();
    expect(el.querySelector('app-next-step-card .next')!.textContent).toContain('Define the task');
    expect(el.querySelector('app-record-line')).not.toBeNull();
    // the cycles and related boards moved to the Cycles tab
    expect(el.querySelector('app-related-strip')).toBeNull();
  });

  it('the project\'s default board: its name as title, no ref chip, no facts, stage line or Next card', () => {
    const { el } = render('default:odeysys', true);
    expect(el.querySelector('.bp-title')!.textContent).toBe('odeysys');
    expect(el.querySelector('.bp-id')).toBeNull();
    expect(el.querySelector('app-board-facts')).toBeNull();
    expect(el.querySelector('app-stage-strip')).toBeNull();
    expect(el.querySelector('app-next-step-card')).toBeNull();
    expect(el.querySelector('app-board-state-menu')).toBeNull();
    expect(el.querySelector('app-board-session-button')).not.toBeNull();
  });

  it('tabs show plain counts', () => {
    const { f } = render('b1', false);
    const tabs = f.componentInstance.tabs();
    expect(tabs.find((t) => t.key === 'calls')!.n).toBe('');
  });
});
