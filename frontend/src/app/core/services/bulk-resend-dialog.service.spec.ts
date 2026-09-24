import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed, fakeAsync, tick } from '@angular/core/testing';
import { CallRecord } from '../models/call.model';
import { draftFrom, moveDraft } from '../../shared/utils/resend-draft';
import { AppConfigService } from './app-config.service';
import { BulkResendDialogService } from './bulk-resend-dialog.service';

const BACKEND = 'http://backend.test:5000';

describe('BulkResendDialogService', () => {
  let service: BulkResendDialogService;
  let http: HttpTestingController;

  const call = (id: string, source: 'external' | 'internal' = 'external'): CallRecord => ({
    id,
    original_url: `https://a.com/${id}`,
    url: `https://a.com/${id}`,
    method: 'GET',
    timestamp: 't',
    duration_ms: 1,
    source,
    request: { headers: { A: '1' }, body: '' },
  });

  const ok = { newCallId: 'n', status: 200, durationMs: 5, sessionValuesUsed: [] };

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting(), { provide: AppConfigService, useValue: { backendUrl: BACKEND } }],
    });
    service = TestBed.inject(BulkResendDialogService);
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => http.verify());

  it('sends included drafts one at a time, in list order, with edits, cycle and batch position', fakeAsync(() => {
    const drafts = [draftFrom(call('c1'), 'cy1'), { ...draftFrom(call('c2'), null), include: false }, { ...draftFrom(call('c3', 'internal'), null), method: 'POST' }];
    service.start(moveDraft(drafts, 2, 0));
    service.send({ stopOnFailure: true, delayMs: 0 });

    const first = http.expectOne(`${BACKEND}/resend`);
    expect(first.request.body.callId).toBe('c3');
    expect(first.request.body.direction).toBe('inbound');
    expect(first.request.body.edits).toEqual({ method: 'POST' });
    expect(first.request.body.batch.index).toBe(1);
    expect(first.request.body.batch.total).toBe(2);
    http.expectNone((r) => r.body?.callId === 'c1');
    first.flush(ok);

    const second = http.expectOne(`${BACKEND}/resend`);
    expect(second.request.body.callId).toBe('c1');
    expect(second.request.body.cycleId).toBe('cy1');
    expect(second.request.body.batch.id).toBe(first.request.body.batch.id);
    second.flush(ok);
    tick();

    expect(service.progress()).toBe(2);
    expect(service.running()).toBeFalse();
    expect(Object.values(service.results()).every((r) => r.ok)).toBeTrue();
  }));

  it('stops at the first failure when asked to, and keeps going when not', fakeAsync(() => {
    service.start([draftFrom(call('c1'), null), draftFrom(call('c2'), null)]);
    service.send({ stopOnFailure: true, delayMs: 0 });
    http.expectOne(`${BACKEND}/resend`).flush({ error: 'send-failed', message: 'refused' }, { status: 502, statusText: 'Bad Gateway' });
    tick();
    http.expectNone(`${BACKEND}/resend`);
    expect(service.stoppedEarly()).toBeTrue();
    expect(Object.values(service.results())[0].error).toContain('refused');

    service.send({ stopOnFailure: false, delayMs: 0 });
    http.expectOne(`${BACKEND}/resend`).flush({ error: 'send-failed' }, { status: 502, statusText: 'Bad Gateway' });
    http.expectOne(`${BACKEND}/resend`).flush(ok);
    tick();
    expect(service.progress()).toBe(2);
    expect(service.stoppedEarly()).toBeFalse();
  }));

  it('waits the delay between sends, not before the first, and sends a single call without a batch', fakeAsync(() => {
    service.start([draftFrom(call('c1'), null), draftFrom(call('c2'), null)]);
    service.send({ stopOnFailure: true, delayMs: 500 });
    http.expectOne(`${BACKEND}/resend`).flush(ok);
    tick(499);
    http.expectNone(`${BACKEND}/resend`);
    tick(1);
    http.expectOne(`${BACKEND}/resend`).flush(ok);

    service.start([draftFrom(call('c9'), null)]);
    service.send({ stopOnFailure: true, delayMs: 0 });
    expect(http.expectOne(`${BACKEND}/resend`).request.body.batch).toBeNull();
  }));

  it('stops after the call in flight', fakeAsync(() => {
    service.start([draftFrom(call('c1'), null), draftFrom(call('c2'), null)]);
    service.send({ stopOnFailure: false, delayMs: 0 });
    const inFlight = http.expectOne(`${BACKEND}/resend`);
    service.stop();
    inFlight.flush(ok);
    tick();
    http.expectNone(`${BACKEND}/resend`);
    expect(service.progress()).toBe(1);
    expect(service.running()).toBeFalse();
  }));
});
