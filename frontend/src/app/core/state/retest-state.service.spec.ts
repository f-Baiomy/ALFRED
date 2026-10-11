import { TestBed } from '@angular/core/testing';
import { Subject, of } from 'rxjs';
import { BoardSocketEvent, RetestCheck } from '../models/board.models';
import { BoardApiService } from '../services/board-api.service';
import { BoardNotifyService } from '../services/board-notify.service';
import { BoardSocketService } from '../services/board-socket.service';
import { SessionCyclesApiService } from '../services/session-cycles-api.service';
import { RetestStateService } from './retest-state.service';

function check(number: number, over: Partial<RetestCheck> = {}): RetestCheck {
  return { number, project: 'p', title: `card ${number}`, status: 'FIXED', since: null, verdict: 'NO_CALLS', statusOnly: false, summary: '', results: [],
    calls: [], steps: [], newBuild: false, ...over };
}

describe('RetestStateService', () => {
  let events: Subject<BoardSocketEvent>;
  let retestChecks: jasmine.Spy;
  let retestRun: jasmine.Spy;
  let create: jasmine.Spy;
  let start: jasmine.Spy;
  let pause: jasmine.Spy;

  beforeEach(() => {
    try { localStorage.removeItem('alfred.board.retest-recording'); localStorage.removeItem('alfred.board.retest-later'); } catch { /* none */ }
    events = new Subject();
    retestChecks = jasmine.createSpy('retestChecks').and.callFake((_p: string, _n: number[], cycleId: string | null) => of({
      checks: cycleId
        ? [check(18, { steps: [{ text: 'Open the flight search page', endpoint: 'POST /x', seen: true, calls: 1 }, { text: 'Open Suppliers', endpoint: 'GET /s', seen: false, calls: 0 }] }),
          check(19, { steps: [{ text: 'Open the flight search page', endpoint: 'POST /x', seen: true, calls: 1 }] })]
        : [check(18, { newBuild: true }), check(19, { verdict: 'PASSES' })],
      lastStart: '2026-10-11T10:00:00Z',
    }));
    retestRun = jasmine.createSpy('retestRun').and.returnValue(of({ at: 't', source: 'cycle:c1', checks: [], markdown: '## Re-test p' }));
    create = jasmine.createSpy('create').and.returnValue(of({ id: 'c1' }));
    start = jasmine.createSpy('startRecording').and.returnValue(of({}));
    pause = jasmine.createSpy('pauseRecording').and.returnValue(of({}));
    TestBed.configureTestingModule({
      providers: [
        RetestStateService,
        { provide: BoardApiService, useValue: { retestChecks, retestRun, retestGuards: () => of([check(5, { status: 'VERIFIED', verdict: 'FAILS' })]) } },
        { provide: SessionCyclesApiService, useValue: { create, startRecording: start, pauseRecording: pause } },
        { provide: BoardSocketService, useValue: { events$: events.asObservable(), reconnected$: new Subject<void>() } },
        { provide: BoardNotifyService, useValue: { notifyText: jasmine.createSpy('notifyText') } },
      ],
    });
  });

  async function settle(): Promise<void> {
    await new Promise((r) => setTimeout(r, 450));
  }

  it('loads the Fixed checks and the guards, and offers a re-test of the new build', async () => {
    const s = TestBed.inject(RetestStateService);
    s.show('p');
    await settle();
    expect(s.byNumber().get(19)?.verdict).toBe('PASSES');
    expect(s.byNumber().get(5)?.verdict).toBe('FAILS');
    expect(s.showNewBuild()).toBeTrue();
    s.later();
    expect(s.showNewBuild()).toBeFalse();
  });

  it('records a cycle named after the cards, merges their steps, and checks it on Stop', async () => {
    const s = TestBed.inject(RetestStateService);
    s.show('p');
    s.start([18, 19]);
    expect(create).toHaveBeenCalledWith({ name: 'Re-test #18 #19' });
    expect(start).toHaveBeenCalledWith('c1');
    await settle();
    expect(s.recordingSteps().map((x) => [x.text, x.numbers, x.seen])).toEqual([
      ['Open the flight search page', [18, 19], true],
      ['Open Suppliers', [18], false],
    ]);
    s.stopAndCheck();
    expect(pause).toHaveBeenCalledWith('c1');
    expect(retestRun).toHaveBeenCalledWith('p', [18, 19], 'c1');
    expect(s.report()?.markdown).toBe('## Re-test p');
    expect(s.recording()).toBeNull();
  });

  it('re-reads on a retest signal for its project only', async () => {
    const s = TestBed.inject(RetestStateService);
    s.show('p');
    await settle();
    const calls = retestChecks.calls.count();
    events.next({ type: 'board-changed', project: 'other', what: 'retest' });
    await settle();
    expect(retestChecks.calls.count()).toBe(calls);
    events.next({ type: 'board-changed', project: 'p', what: 'retest' });
    await settle();
    expect(retestChecks.calls.count()).toBe(calls + 1);
  });
});
