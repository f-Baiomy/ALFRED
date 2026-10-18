import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { of } from 'rxjs';
import { DbCaptureApiService } from '../../../core/services/db-capture-api.service';
import { SessionCyclesApiService } from '../../../core/services/session-cycles-api.service';
import { ChatStateService } from '../../../core/state/chat-state.service';
import { SessionCycle } from '../../../core/models/call.model';
import { BoardCycleRow, CycleSummary } from '../../../core/models/cycles-tab.models';
import { CycleRowComponent } from './cycle-row.component';

const CYCLE: SessionCycle = { id: 'c1', name: 'Re-test #81 · Ancillaries 500', createdAt: '2026-10-18T13:16:00Z', assignedTo: null, status: 'PAUSED',
  description: 'Re-test after the mapper fix\n- [ ] Search POST /api/search\n- [ ] Ancillaries GET /api/ancillaries', summary: '1 of 1 card fails.' };
const ROW: BoardCycleRow = { cycleId: 'c1', kind: 'RETEST', baseline: false, archived: false, relatedAt: null, otherBoards: [],
  tests: [{ cardId: 'k81', number: 81, title: 'Ancillaries 500', status: 'FIXED', verdict: 'FAILS', summary: null }] };
const SUMMARY: CycleSummary = { cycleId: 'c1', calls: 2, failed: 1, firstAt: '2026-10-18T13:16:00Z', lastAt: '2026-10-18T13:17:00Z', medianMs: 300,
  hosts: ['env80:8080'], inboundCallIds: ['a', 'b'],
  endpoints: [{ direction: 'INBOUND', method: 'GET', path: '/api/ancillaries', calls: 1, failed: 1, lastStatus: 500, medianMs: 1900, maxMs: 1900, lastAt: null }],
  strip: [{ direction: 'INBOUND', callId: 'a', at: '2026-10-18T13:16:00Z', method: 'POST', path: '/api/search', status: 200, ms: 300, failed: false },
    { direction: 'INBOUND', callId: 'b', at: '2026-10-18T13:17:00Z', method: 'GET', path: '/api/ancillaries', status: 500, ms: 1900, failed: true }] };

describe('CycleRowComponent (specs/033)', () => {
  let putNotes: jasmine.Spy;
  let send: jasmine.Spy;

  beforeEach(() => {
    putNotes = jasmine.createSpy('putNotes').and.callFake((_: string, n: { description?: string }) => of({ ...CYCLE, ...n }));
    send = jasmine.createSpy('send');
    TestBed.configureTestingModule({
      imports: [CycleRowComponent],
      providers: [
        provideRouter([]),
        { provide: SessionCyclesApiService, useValue: { putNotes, listSpacers: () => of([]) } },
        { provide: DbCaptureApiService, useValue: { summaries: () => of({ a: { statementCount: 12 }, b: { statementCount: 3 } }) } },
        { provide: ChatStateService, useValue: { send } },
      ],
    });
  });

  function make() {
    const f = TestBed.createComponent(CycleRowComponent);
    f.componentRef.setInput('cycle', CYCLE);
    f.componentRef.setInput('row', ROW);
    f.componentRef.setInput('summary', SUMMARY);
    f.componentRef.setInput('boardId', 'b1');
    f.detectChanges();
    return f;
  }

  it('is three short lines closed: name, facts with the card chip, the description\'s first line', () => {
    const el: HTMLElement = make().nativeElement;
    expect(el.querySelector('.cyx-name')?.textContent).toContain('Re-test #81');
    expect(el.querySelector('.cyx-cdot.bad')?.textContent).toContain('#81');
    expect(el.querySelector('.cyx-sub')?.textContent).toContain('1 failed');
    expect(el.querySelector('.cyx-desc')?.textContent).toContain('Re-test after the mapper fix');
    expect(el.querySelector('.cyx-body')).toBeNull();
  });

  it('opens on a click: steps ticked by the calls, Claude\'s summary apart, hot spots and SQL', () => {
    const f = make();
    const c = f.componentInstance;
    c.setOpen(true);
    f.detectChanges();
    const el: HTMLElement = f.nativeElement;
    const steps = el.querySelectorAll('.cyx-steps li');
    expect(steps.length).toBe(2);
    expect(steps[0].classList).toContain('done');   // a 200 to POST /api/search
    expect(steps[1].classList).not.toContain('done'); // only a 500 so far
    expect(el.querySelector('.cyx-summary')?.textContent).toContain('1 of 1 card fails.');
    expect(el.querySelector('.cyx-hot')?.textContent).toContain('/api/ancillaries');
    expect(c.sql()).toBe(15);
  });

  it('a step clicked by hand is written into the description', () => {
    const f = make();
    f.componentInstance.toggleStep(2, true);
    expect(putNotes).toHaveBeenCalledWith('c1', { description: 'Re-test after the mapper fix\n- [ ] Search POST /api/search\n- [x] Ancillaries GET /api/ancillaries' });
  });

  it('asks Claude in the board chat with the cycle mentioned', () => {
    const f = make();
    const c = f.componentInstance;
    c.question.set('why does #81 still fail?');
    c.ask();
    expect(send).toHaveBeenCalledWith('b1', { text: '@[cycle:c1|Re-test #81 · Ancillaries 500] why does #81 still fail?' });
  });

  it('tells its list what was asked from the menu', () => {
    const f = make();
    const got: string[] = [];
    f.componentInstance.action.subscribe((a) => got.push(a));
    f.componentInstance.act('baseline');
    f.componentInstance.act('pack');
    expect(got).toEqual(['baseline', 'pack']);
  });
});
