import { provideLinksTesting } from '../../../core/links/links-testing';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { of, Subject } from 'rxjs';
import { signal } from '@angular/core';
import { BoardApiService } from '../../../core/services/board-api.service';
import { BoardSocketService } from '../../../core/services/board-socket.service';
import { ConfirmDialogService } from '../../../core/services/confirm-dialog.service';
import { CycleDeleteService } from '../../../core/services/cycle-delete.service';
import { CycleExportService } from '../../../core/services/cycle-export.service';
import { DbCaptureApiService } from '../../../core/services/db-capture-api.service';
import { EditCycleDialogService } from '../../../core/services/edit-cycle-dialog.service';
import { SessionCyclesApiService } from '../../../core/services/session-cycles-api.service';
import { ChatStateService } from '../../../core/state/chat-state.service';
import { SessionCyclesStateService } from '../../../core/state/session-cycles-state.service';
import { SessionCycle } from '../../../core/models/call.model';
import { BoardCycleRow, CycleSummary } from '../../../core/models/cycles-tab.models';
import { BoardCyclesComponent } from './board-cycles.component';

const CYCLES: SessionCycle[] = [
  { id: 'c1', name: 'Re-test #76 #81 · 2 cards', createdAt: '2026-10-18T13:16:00Z', assignedTo: null, status: 'RECORDING',
    description: 'Re-test on env 80\n- [ ] Search POST /api/search' },
  { id: 'c2', name: 'AB#59851 · rec 2026-10-18 12:01', createdAt: '2026-10-18T12:01:00Z', assignedTo: null, status: 'PAUSED' },
  { id: 'c3', name: 'old smoke', createdAt: '2026-10-16T10:00:00Z', assignedTo: null, status: 'PAUSED' },
];
const ROWS: BoardCycleRow[] = [
  { cycleId: 'c1', kind: 'RETEST', baseline: false, archived: false, relatedAt: null, otherBoards: [],
    tests: [{ cardId: 'k76', number: 76, title: 'Baggage differs', status: 'FIXED', verdict: 'PASSES', summary: null },
      { cardId: 'k81', number: 81, title: 'Ancillaries 500', status: 'FIXED', verdict: 'FAILS', summary: null }] },
  { cycleId: 'c2', kind: 'REC', baseline: true, archived: false, relatedAt: null, otherBoards: ['b2'], tests: [] },
  { cycleId: 'c3', kind: null, baseline: false, archived: true, relatedAt: null, otherBoards: [], tests: [] },
];
const summary = (cycleId: string, calls: number, failed: number): CycleSummary => ({ cycleId, calls, failed, firstAt: '2026-10-18T13:16:00Z',
  lastAt: '2026-10-18T13:20:00Z', medianMs: 200, hosts: ['env80:8080'], endpoints: [], strip: [], inboundCallIds: [] });

describe('BoardCyclesComponent (specs/033)', () => {
  let api: jasmine.SpyObj<BoardApiService>;
  let chat: { send: jasmine.Spy };

  beforeEach(() => {
    try { localStorage.removeItem('alfred.cycles.readyHidden.b1'); } catch { /* none */ }
    api = jasmine.createSpyObj<BoardApiService>('BoardApiService', ['board', 'cards', 'cyclePrefs', 'cycleRows', 'cycleVerdicts', 'recordForBoard',
      'setCycleFlags', 'setCyclePrefs', 'relateCycle', 'cardCycleVerdicts', 'liveRunner', 'requestSkillRun']);
    api.board.and.returnValue(of({ board: { id: 'b1', project: 'odeysys', name: 'AB#59851' }, cycleIds: ['c1', 'c2', 'c3'], boardIds: [] } as never) as never);
    api.cards.and.returnValue(of({ cards: [
      { id: 'k76', number: 76, title: 'Baggage differs', status: 'FIXED', updatedAt: '2026-10-18T12:00:00Z' },
      { id: 'k84', number: 84, title: 'Seat map blank', status: 'FIXED', updatedAt: '2026-10-18T14:00:00Z' },
    ] } as never) as never);
    api.cyclePrefs.and.returnValue(of({ claudeSummaries: true }));
    api.cycleRows.and.returnValue(of(ROWS));
    api.cycleVerdicts.and.returnValue(of({ cycleId: 'x', boards: [{ boardId: 'b1', name: 'AB', items: [{ fileName: 'r', key: 'AC1', result: 'MEETS' }] }], calls: [] } as never) as never);
    api.recordForBoard.and.returnValue(of({ cycleId: 'new', message: 'started' }));
    api.setCycleFlags.and.returnValue(of({}));
    chat = { send: jasmine.createSpy('send') };
    const cyclesApi = { summary: (id: string) => of(summary(id, id === 'c1' ? 23 : 17, id === 'c1' ? 2 : 4)), listSpacers: () => of([]), putNotes: () => of(CYCLES[0]),
      delete: jasmine.createSpy('delete').and.returnValue(of(null)) };
    TestBed.configureTestingModule({
      imports: [BoardCyclesComponent],
      providers: [
        ...provideLinksTesting(),
        provideRouter([]),
        { provide: BoardApiService, useValue: api },
        { provide: SessionCyclesApiService, useValue: cyclesApi },
        { provide: SessionCyclesStateService, useValue: { cycles: signal(CYCLES), contentChanged$: new Subject<string>(), refreshNow: () => undefined } },
        { provide: BoardSocketService, useValue: { events$: new Subject() } },
        { provide: ChatStateService, useValue: chat },
        { provide: ConfirmDialogService, useValue: { confirm: async () => true } },
        { provide: CycleDeleteService, useValue: { confirmAndClean: async () => false } },
        { provide: CycleExportService, useValue: { exportCycle: jasmine.createSpy('exportCycle') } },
        { provide: EditCycleDialogService, useValue: { open: async () => null } },
        { provide: DbCaptureApiService, useValue: { summaries: () => of({}) } },
      ],
    });
  });

  function make() {
    const f = TestBed.createComponent(BoardCyclesComponent);
    f.componentRef.setInput('boardId', 'b1');
    f.detectChanges(); // the effect loads the board
    f.detectChanges(); // and the rows it loaded are shown
    return f;
  }

  it('lists the cycles as compact rows - archived out of the way, cards as verdict chips', () => {
    const f = make();
    const el: HTMLElement = f.nativeElement;
    const rows = el.querySelectorAll('.cyx');
    expect(rows.length).toBe(2);
    expect(rows[0].textContent).toContain('Re-test #76 #81');
    expect(rows[0].querySelector('.cyx-cdot.ok')?.textContent).toContain('#76');
    expect(rows[0].querySelector('.cyx-cdot.bad')?.textContent).toContain('#81');
    expect(rows[1].querySelector('.cyx-tag.base')).not.toBeNull();
    expect(el.querySelector('.cyx-foot')?.textContent).toContain('1 archived');
    expect(el.querySelector('.cyx-stats')?.textContent).toContain('40');
    expect(rows[0].querySelector('.cyx-desc')?.textContent).toContain('Re-test on env 80');
  });

  it('says once that a fixed card waits for a re-test, and hides it for good', () => {
    const f = make();
    const el: HTMLElement = f.nativeElement;
    const nudge = el.querySelector('.cyx-nudge');
    expect(nudge?.textContent).toContain('#84');
    expect(nudge?.textContent).not.toContain('#76'); // re-tested by c1 after it was fixed
    (el.querySelector('.cyx-nudge .cyx-x') as HTMLButtonElement).click();
    f.detectChanges();
    expect(el.querySelector('.cyx-nudge')).toBeNull();
  });

  it('starts a re-test named after the cards picked, with its description', async () => {
    const f = make();
    const c = f.componentInstance;
    c.openRetest([{ number: 84 }]);
    f.detectChanges();
    expect(c.rtName()).toBe('Re-test #84 · Seat map blank');
    c.toggleRetestCard(76);
    expect(c.rtName()).toBe('Re-test #76 #84 · 2 cards');
    await c.startRetest();
    const [, kind, , spec] = api.recordForBoard.calls.mostRecent().args;
    expect(kind).toBe('RETEST');
    expect(spec?.cards).toEqual([76, 84]);
    expect(spec?.name).toBe('Re-test #76 #84 · 2 cards');
    expect(c.retest()).toBeNull();
  });

  it('archives and sets the baseline through the board, filters and searches', () => {
    const f = make();
    const c = f.componentInstance;
    c.flag('c1', { archived: true });
    expect(api.setCycleFlags).toHaveBeenCalledWith('b1', 'c1', { archived: true });
    c.chip.set('failures');
    expect(c.shown().length).toBe(2);
    c.chip.set('retests');
    expect(c.shown().map((v) => v.row.cycleId)).toEqual(['c1']);
    c.chip.set('all');
    c.q.set('#81');
    expect(c.shown().map((v) => v.row.cycleId)).toEqual(['c1']);
  });

  it('deletes the selected cycles after one confirm, never the one recording', async () => {
    const f = make();
    const c = f.componentInstance;
    const del = TestBed.inject(CycleDeleteService) as unknown as { confirmAndClean: (ids: string[], q: string) => Promise<boolean> };
    const asked: string[][] = [];
    del.confirmAndClean = async (ids) => { asked.push(ids); return true; };
    c.select('c1', true); // recording
    c.select('c2', true);
    await c.deleteSelected();
    expect(asked).toEqual([['c2']]);
    const api = TestBed.inject(SessionCyclesApiService) as unknown as { delete: jasmine.Spy };
    expect(api.delete).toHaveBeenCalledOnceWith('c2');
    expect(c.selected().size).toBe(0);
  });

  it('compares a row with the baseline', () => {
    const f = make();
    const c = f.componentInstance;
    expect(c.versusOf('c1')).toBe('vs baseline: 2 fewer failures');
    void c.onAction(CYCLES[0], ROWS[0], 'compare');
    expect(c.comparison()?.aId).toBe('c2');
    expect(c.comparison()?.bId).toBe('c1');
  });
});
