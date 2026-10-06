import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Subject, of } from 'rxjs';
import { CallRecord } from '../../core/models/call.model';
import { LogsSocketEvent } from '../../core/models/logs.model';
import { CallLogsApiService } from '../../core/services/call-logs-api.service';
import { LogsSocketService } from '../../core/services/logs-socket.service';
import { CallLogCountsService } from '../../core/state/call-log-counts.service';
import { DbCaptureStateService } from '../../core/state/db-capture-state.service';
import { DbWindowService } from './db-window.service';
import { LogChipComponent } from './log-chip.component';

const callOf = (id: string): CallRecord => ({
  id, original_url: '/x', url: '/x', method: 'POST', timestamp: '2026-10-06T10:00:00Z', duration_ms: 10, source: 'internal', service_name: 'odeysys',
});

describe('LogChipComponent', () => {
  let counts: jasmine.Spy;
  let events: Subject<LogsSocketEvent>;
  let openCall: jasmine.Spy;

  /** The browser's observer is replaced by one that reports every card as on screen, at once. */
  const RealObserver = window.IntersectionObserver;
  afterEach(() => (window.IntersectionObserver = RealObserver));

  beforeEach(() => {
    window.IntersectionObserver = class {
      constructor(private readonly cb: IntersectionObserverCallback) {}
      observe(el: Element) {
        this.cb([{ isIntersecting: true, target: el } as unknown as IntersectionObserverEntry], this as unknown as IntersectionObserver);
      }
      disconnect() {}
    } as unknown as typeof IntersectionObserver;
    counts = jasmine.createSpy('counts').and.callFake((ids: string[]) =>
      of(Object.fromEntries(ids.filter((id) => id !== 'none').map((id) => [id, { lines: 11, errors: 1, warnings: 2, matchedBy: 'THREAD_TIME' }]))));
    events = new Subject();
    openCall = jasmine.createSpy('openCall');
    TestBed.configureTestingModule({
      imports: [LogChipComponent],
      providers: [
        { provide: CallLogsApiService, useValue: { counts } },
        { provide: LogsSocketService, useValue: { events$: events, reconnected$: new Subject() } },
        { provide: DbCaptureStateService, useValue: { projectStatus: () => ({ logsOn: true }), projects: signal([]) } },
        { provide: DbWindowService, useValue: { openCall } },
      ],
    });
  });

  async function chips(...ids: string[]) {
    const fixtures = ids.map((id) => {
      const f = TestBed.createComponent(LogChipComponent);
      f.componentRef.setInput('call', callOf(id));
      f.detectChanges();
      return f;
    });
    // the IntersectionObserver reports asynchronously, then the batch flushes on a microtask
    await new Promise((r) => setTimeout(r, 120));
    fixtures.forEach((f) => f.detectChanges());
    return fixtures;
  }

  it('fetches the counts of the cards on screen in one batch and shows them', async () => {
    const [a, , none] = await chips('a', 'b', 'none');
    expect(counts).toHaveBeenCalledTimes(1);
    expect(counts.calls.mostRecent().args[0]).toEqual(jasmine.arrayWithExactContents(['a', 'b', 'none']));
    expect(a.nativeElement.textContent).toContain('▤ Logs 11');
    expect(a.nativeElement.textContent).toContain('1 error');
    expect(a.nativeElement.textContent).toContain('2 warn');
    expect(none.nativeElement.querySelector('button')).toBeNull();
  });

  it('opens the window on the Logs view', async () => {
    const [a] = await chips('a');
    a.nativeElement.querySelector('button').click();
    expect(openCall).toHaveBeenCalledWith(jasmine.objectContaining({ id: 'a' }), 'logs', null);
  });

  it('refetches the shown cards once for a burst of new lines', async () => {
    await chips('a');
    jasmine.clock().install();
    try {
      const service = TestBed.inject(CallLogCountsService);
      expect(service.counts().get('a')?.lines).toBe(11);
      events.next({ type: 'lines-added', sourceId: 's1', count: 1, newestTs: 0 });
      events.next({ type: 'lines-added', sourceId: 's1', count: 1, newestTs: 0 });
      jasmine.clock().tick(2100);
      jasmine.clock().tick(30);
      expect(counts).toHaveBeenCalledTimes(2);
    } finally {
      jasmine.clock().uninstall();
    }
  });
});
