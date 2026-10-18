import { TestBed } from '@angular/core/testing';
import { NEVER, Subject, of } from 'rxjs';
import { BoardApiService } from '../../../core/services/board-api.service';
import { BoardSocketService } from '../../../core/services/board-socket.service';
import { ConfirmDialogService } from '../../../core/services/confirm-dialog.service';
import { SessionCyclesApiService } from '../../../core/services/session-cycles-api.service';
import { SessionCyclesStateService } from '../../../core/state/session-cycles-state.service';
import { RecordLineComponent } from './record-line.component';

describe('RecordLineComponent (specs/032 T046)', () => {
  let api: { recordForBoard: jasmine.Spy };
  let cycles: { pauseRecording: jasmine.Spy; refreshNow: jasmine.Spy; contentChanged$: typeof NEVER };

  function render(status: 'RECORDING' | 'PAUSED') {
    api = { recordForBoard: jasmine.createSpy('rec').and.returnValue(of({ cycleId: 'c1', message: '' })) };
    cycles = { pauseRecording: jasmine.createSpy('pause').and.returnValue(of({})), refreshNow: jasmine.createSpy('refresh'), contentChanged$: NEVER };
    TestBed.configureTestingModule({ imports: [RecordLineComponent], providers: [
      { provide: BoardApiService, useValue: api },
      { provide: SessionCyclesApiService, useValue: { listCalls: () => of({ calls: [], total: 12 }) } },
      { provide: SessionCyclesStateService, useValue: cycles },
      { provide: ConfirmDialogService, useValue: { confirm: () => Promise.resolve(false) } },
      { provide: BoardSocketService, useValue: { events$: new Subject() } }] });
    const f = TestBed.createComponent(RecordLineComponent);
    f.componentRef.setInput('boardId', 'b1');
    f.componentRef.setInput('cycles', [{ id: 'c1', name: 'AB#1 test', status }]);
    f.detectChanges();
    f.detectChanges();
    return { f, el: f.nativeElement as HTMLElement };
  }

  it('not recording: ● Record, what it is for, and where the recordings are', () => {
    const { el } = render('PAUSED');
    expect(el.querySelector('.rec')!.textContent!.trim()).toBe('● Record');
    expect(el.textContent).toContain('Record the calls while you test this task.');
    expect(el.textContent).toContain('Recordings and related boards are on the Cycles tab.');
    (el.querySelector('.rec') as HTMLButtonElement).click();
    expect(api.recordForBoard).toHaveBeenCalledWith('b1', 'REC', 'ASK');
  });

  it('recording: ● Recording · N calls, and Stop when you finish', () => {
    const { el } = render('RECORDING');
    expect(el.querySelector('.rec.on')!.textContent!.trim()).toBe('● Recording · 12 calls');
    expect(el.textContent).toContain('Stop when you finish testing.');
    (el.querySelector('.rec') as HTMLButtonElement).click();
    expect(cycles.pauseRecording).toHaveBeenCalledWith('c1');
  });
});
