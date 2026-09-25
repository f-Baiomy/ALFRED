import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed, fakeAsync, tick } from '@angular/core/testing';
import { CallRecord } from '../models/call.model';
import { draftFrom } from '../../shared/utils/resend-draft';
import { groupDrafts, pruneGroups, swapRuns } from '../../shared/utils/resend-group';
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
    // Put c3 at the top by swapping it with c1, then with c2: each loose call is its own run.
    service.start(swapRuns(swapRuns(drafts, 2, 0), 1, 0));
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

  describe('groups', () => {
    const group = (id: string, mode: 'sequential' | 'parallel' = 'sequential') => ({ id, name: id, mode });

    /**
     * Three calls where c1 and c3 are one group and c2 is loose, so there are two runs. Grouping
     * works on draft keys, not call ids, so the keys are looked up off the drafts themselves.
     */
    const threeCalls = () => [draftFrom(call('c1'), null), draftFrom(call('c2'), null), draftFrom(call('c3'), null)];
    const keyOf = (drafts: readonly ReturnType<typeof draftFrom>[], callId: string) =>
      drafts.find((d) => d.ref.callId === callId)!;

    const grouped = (mode: 'sequential' | 'parallel' = 'sequential') => {
      const all = threeCalls();
      const drafts = groupDrafts(all, [keyOf(all, 'c1'), keyOf(all, 'c3')], 'g1');
      service.start(drafts);
      service.groups.set({ g1: group('g1', mode) });
    };


    it('reads the list as runs - the group, then the loose call after it', () => {
      grouped();
      expect(service.runs().map((run) => [run.kind, run.drafts.length])).toEqual([
        ['group', 2],
        ['loose', 1],
      ]);
    });

    it('batches per GROUP, and gives a lone loose call no batch at all', fakeAsync(() => {
      grouped();
      service.send({ stopOnFailure: false, delayMs: 0 });

      const first = http.expectOne(`${BACKEND}/resend`);
      expect(first.request.body.callId).toBe('c1');
      expect(first.request.body.batch).toEqual({ id: first.request.body.batch.id, index: 1, total: 2 });
      first.flush(ok);
      const second = http.expectOne(`${BACKEND}/resend`);
      expect(second.request.body.batch.index).toBe(2);
      // A different id from the group's - it is not a position in that group.
      second.flush(ok);
      const third = http.expectOne(`${BACKEND}/resend`);
      expect(third.request.body.callId).toBe('c2');
      expect(third.request.body.batch).toBeNull();
      third.flush(ok);
      tick();
      expect(service.progress()).toBe(3);
    }));

    it('numbers several loose calls as one batch across the whole resend, not one batch each', fakeAsync(() => {
      const all = [...threeCalls(), draftFrom(call('c4'), null)];
      const drafts = groupDrafts(all, [keyOf(all, 'c1'), keyOf(all, 'c2')], 'g1');
      service.start(drafts);
      service.groups.set({ g1: group('g1') });
      service.send({ stopOnFailure: false, delayMs: 0 });

      const bodies: { callId: string; batch: { id: string; index: number; total: number } | null }[] = [];
      for (let i = 0; i < 4; i++) {
        const req = http.expectOne(`${BACKEND}/resend`);
        bodies.push({ callId: req.request.body.callId, batch: req.request.body.batch });
        req.flush(ok);
      }
      tick();
      // The two loose calls share one id and run 1 then 2 of 2; the group has its own.
      const loose = bodies.filter((b) => b.batch && b.callId !== 'c1' && b.callId !== 'c2');
      expect(loose.map((b) => b.batch!.index)).toEqual([1, 2]);
      expect(loose[0].batch!.id).toBe(loose[1].batch!.id);
      expect(loose[0].batch!.total).toBe(2);
      const inGroup = bodies.filter((b) => b.callId === 'c1' || b.callId === 'c2');
      expect(inGroup[0].batch!.id).not.toBe(loose[0].batch!.id);
    }));

    it('sends a sequential group one at a time, and a loose call only after the group is done', fakeAsync(() => {
      grouped('sequential');
      service.send({ stopOnFailure: false, delayMs: 0 });

      const first = http.expectOne(`${BACKEND}/resend`);
      expect(first.request.body.callId).toBe('c1');
      first.flush(ok);
      const second = http.expectOne(`${BACKEND}/resend`);
      expect(second.request.body.callId).toBe('c3');
      // The run after the group must not start while the group is still going.
      expect(() => http.expectOne((r) => r.body?.callId === 'c2')).toThrow();
      second.flush(ok);
      http.expectOne((r) => r.body?.callId === 'c2').flush(ok);
      tick();
    }));

    it('sends a PARALLEL group with every call on the wire at once, and the next run only after', fakeAsync(() => {
      grouped('parallel');
      service.send({ stopOnFailure: false, delayMs: 0 });

      // Both members in flight before either has answered - the whole point of the mode.
      const inFlight = http.match(`${BACKEND}/resend`);
      expect(inFlight.length).toBe(2);
      expect(inFlight.map((r) => r.request.body.callId).sort()).toEqual(['c1', 'c3']);
      expect(service.inFlight()).toBe(2);
      expect(service.currentRun()?.group?.id).toBe('g1');

      inFlight.forEach((r) => r.flush(ok));
      // Now, and only now, the loose run after it starts.
      http.expectOne((r) => r.body?.callId === 'c2').flush(ok);
      tick();
      expect(service.inFlight()).toBe(0);
      expect(service.progress()).toBe(3);
    }));

    it('stops a parallel group launching anything further, and lets the in-flight calls finish', fakeAsync(() => {
      const all = [...threeCalls(), draftFrom(call('c4'), null)];
      service.start([...groupDrafts(all, [keyOf(all, 'c1'), keyOf(all, 'c2')], 'g1'), all[3]]);
      service.groups.set({ g1: group('g1', 'parallel') });
      service.send({ stopOnFailure: true, delayMs: 0 });

      const inFlight = http.match(`${BACKEND}/resend`);
      expect(inFlight.length).toBe(2);
      inFlight[0].flush({ error: 'send-failed' }, { status: 502, statusText: 'Bad Gateway' });
      inFlight[1].flush(ok);
      tick();

      // The failing group is over either way, so the run after it never starts...
      http.expectNone((r) => r.body?.callId === 'c4');
      expect(service.stoppedEarly()).toBeTrue();
      // ...but the call already at the supplier was not abandoned half-sent.
      expect(service.progress()).toBe(2);
      expect(Object.values(service.results()).filter((r) => r.ok).length).toBe(1);
    }));

    it('staggers a parallel group\'s launches when a delay is set, without making them wait for each other', fakeAsync(() => {
      grouped('parallel');
      service.send({ stopOnFailure: false, delayMs: 500 });
      const first = http.expectOne(`${BACKEND}/resend`);
      tick(499);
      http.expectNone(`${BACKEND}/resend`);
      tick(1);
      // The second launch does not wait for the first to answer.
      const second = http.expectOne(`${BACKEND}/resend`);
      first.flush(ok);
      second.flush(ok);
      // The run after the group waits its own delay, then the one loose call goes.
      tick(500);
      http.expectOne((r) => r.body?.callId === 'c2').flush(ok);
      tick();
      expect(service.progress()).toBe(3);
    }));

    it('waits the delay between two loose calls, which are separate runs', fakeAsync(() => {
      service.start([draftFrom(call('c1'), null), draftFrom(call('c2'), null)]);
      service.send({ stopOnFailure: false, delayMs: 300 });
      http.expectOne(`${BACKEND}/resend`).flush(ok);
      tick(299);
      http.expectNone(`${BACKEND}/resend`);
      tick(1);
      http.expectOne(`${BACKEND}/resend`).flush(ok);
      tick();
    }));

    it('stops a staggered parallel launch that has not gone out yet, unlike one already in flight', fakeAsync(() => {
      const all = [draftFrom(call('c1'), null), draftFrom(call('c2'), null), draftFrom(call('c3'), null)];
      service.start(groupDrafts(all, all, 'g1'));
      service.groups.set({ g1: group('g1', 'parallel') });
      service.send({ stopOnFailure: false, delayMs: 500 });

      const first = http.expectOne(`${BACKEND}/resend`);
      // Stop while the other two are still waiting on their stagger timers. They are not at the
      // supplier yet, so unlike an in-flight call they can still be held back.
      service.stop();
      tick(2000);
      http.expectNone(`${BACKEND}/resend`);
      first.flush(ok);
      tick();
      expect(service.progress()).toBe(1);
      expect(service.running()).toBeFalse();
    }));

    it('leaves an ungrouped list exactly as it was - one batch across the whole resend', fakeAsync(() => {
      service.start([draftFrom(call('c1'), null), draftFrom(call('c2'), null)]);
      service.send({ stopOnFailure: false, delayMs: 0 });
      expect(service.runs().every((run) => run.kind === 'loose')).toBeTrue();
      const first = http.expectOne(`${BACKEND}/resend`);
      expect(first.request.body.batch.total).toBe(2);
      first.flush(ok);
      const second = http.expectOne(`${BACKEND}/resend`);
      expect(second.request.body.batch.id).toBe(first.request.body.batch.id);
      second.flush(ok);
      tick();
    }));

    it('drops a group left with one call, so a group is never a header over nothing', () => {
      const all = [draftFrom(call('c1'), null), draftFrom(call('c2'), null)];
      const grouped = groupDrafts(all, all, 'g1');
      const pruned = pruneGroups(grouped.filter((d) => d.ref.callId !== 'c2'), { g1: group('g1') });
      expect(pruned.groups).toEqual({});
      expect(pruned.drafts[0].groupId).toBeNull();
    });
  });
});
