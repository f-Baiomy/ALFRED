import { TestBed } from '@angular/core/testing';
import { of } from 'rxjs';
import { LineCall } from '../../core/models/call-logs.model';
import { CallFocusService } from '../../core/services/call-focus.service';
import { CallLogsApiService } from '../../core/services/call-logs-api.service';
import { DbWindowService } from '../db-capture/db-window.service';
import { LogLineCallComponent } from './log-line-call.component';

describe('LogLineCallComponent', () => {
  const found: LineCall = {
    call: { id: 'c1', method: 'POST', url: 'http://h/odeysysadmin/search', status: 200, durationMs: 20000, service: 'odeysys', at: '2026-10-06T10:00:00Z' },
    matchedBy: 'THREAD_TIME',
  };
  let go: jasmine.Spy;
  let openCall: jasmine.Spy;

  function render(answer: LineCall | null) {
    go = jasmine.createSpy('go');
    openCall = jasmine.createSpy('openCall');
    TestBed.configureTestingModule({
      imports: [LogLineCallComponent],
      providers: [
        { provide: CallLogsApiService, useValue: { forLine: () => of(answer) } },
        { provide: CallFocusService, useValue: { go } },
        { provide: DbWindowService, useValue: { openCall } },
      ],
    });
    const fixture = TestBed.createComponent(LogLineCallComponent);
    fixture.componentRef.setInput('sourceId', 's1');
    fixture.componentRef.setInput('lineId', 'in:1');
    fixture.detectChanges();
    return fixture;
  }

  it('shows the call the line was written during and links to it and its window', () => {
    const fixture = render(found);
    const text = fixture.nativeElement.textContent;
    expect(text).toContain('During call');
    expect(text).toContain('/odeysysadmin/search');
    expect(text).toContain('20.0 s');
    expect(text).toContain('same thread + time');

    const [call, win] = fixture.nativeElement.querySelectorAll('a');
    call.click();
    expect(go).toHaveBeenCalledWith({ callId: 'c1', cycleId: null, direction: 'inbound', serviceName: 'odeysys' });
    win.click();
    expect(openCall).toHaveBeenCalledWith(jasmine.objectContaining({ id: 'c1', timestamp: '2026-10-06T10:00:00Z' }), 'together');
  });

  it('shows nothing when no call fits', () => {
    const fixture = render(null);
    expect(fixture.nativeElement.querySelector('.lg-during')).toBeNull();
  });
});
