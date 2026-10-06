import { TestBed, fakeAsync, tick } from '@angular/core/testing';
import { Subject, of } from 'rxjs';
import { CallLogCountsService } from './call-log-counts.service';
import { CallLogsApiService } from '../services/call-logs-api.service';
import { LogsSocketService } from '../services/logs-socket.service';
import { DbCaptureStateService } from './db-capture-state.service';
import { LogCounts } from '../models/call-logs.model';

describe('CallLogCountsService - counts of every loaded call', () => {
  let asked: string[][];
  let answer: Record<string, LogCounts>;
  let dbEvents: Subject<unknown>;

  function create(): CallLogCountsService {
    asked = [];
    dbEvents = new Subject();
    TestBed.configureTestingModule({
      providers: [
        { provide: CallLogsApiService, useValue: { counts: (ids: string[]) => { asked.push([...ids]); return of(answer); } } },
        { provide: LogsSocketService, useValue: { events$: new Subject(), reconnected$: new Subject() } },
        { provide: DbCaptureStateService, useValue: { events$: dbEvents } },
      ],
    });
    return TestBed.inject(CallLogCountsService);
  }

  const counts = (errors: number): LogCounts => ({ lines: 5, errors, warnings: 0, matchedBy: 'CAUGHT' } as LogCounts);

  it('fetches requested calls once, in one batch, and knows which have errors', fakeAsync(() => {
    answer = { a: counts(2), b: counts(0) };
    const service = create();
    service.request('a');
    service.request('b');
    service.request('a');
    tick(50);

    expect(asked).toEqual([['a', 'b']]);
    expect([...service.errorCallIds()]).toEqual(['a']);
  }));

  it('refetches a requested call when the agent caught new lines for it', fakeAsync(() => {
    answer = { a: counts(0) };
    const service = create();
    service.request('a');
    tick(50);
    expect(service.errorCallIds().size).toBe(0);

    answer = { a: counts(1) };
    dbEvents.next({ type: 'logs-appended', callId: 'a' });
    dbEvents.next({ type: 'logs-appended', callId: 'not-loaded' });
    tick(2100);

    expect(asked).toEqual([['a'], ['a']]);
    expect([...service.errorCallIds()]).toEqual(['a']);
  }));
});
