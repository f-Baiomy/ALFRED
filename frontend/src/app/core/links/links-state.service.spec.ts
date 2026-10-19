import { ApplicationRef } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { HttpErrorResponse } from '@angular/common/http';
import { Subject, of, throwError } from 'rxjs';
import { LinksApiService } from './links-api.service';
import { LinksSocketService } from './links-socket.service';
import { LinksStateService, problemOf } from './links-state.service';
import { LinkInfo, LinkRequest, LinksSocketEvent, SendRequest } from './links.models';

const LINK: LinkInfo = {
  id: 'L1', slug: 'stg-83', name: 'STG 83', peerAlfredId: 'p', peerName: 'Alfred b', address: 'http://b:3000', dialer: true, createdAt: '',
  lastSeen: null, peerVersion: '1.53.0', online: false, rttMs: null, clockOffsetMs: null, skewed: false, lastError: 'not connected',
  stateSince: null, inFlight: 0, streamsOut: 0, streamsIn: 1,
};
const REQ: SendRequest = { via: 'stg-83', streamId: 'S1', kind: 'CARD_COMMENT', target: 'card-1', text: 'looks wrong' };

function waiting(id: string): LinkRequest {
  return { id, streamId: 'S1', linkId: 'L1', incoming: true, kind: 'CALL_NOTE', target: 'k', targetLabel: null, text: 't', extra: null,
    author: 'PC-1', state: 'WAITING', resultRef: null, note: null, createdAt: '', answeredAt: null, auto: false };
}

describe('LinksStateService', () => {
  let api: jasmine.SpyObj<LinksApiService>;
  let events: Subject<LinksSocketEvent>;

  beforeEach(() => {
    try { localStorage.removeItem('alfred.links.drafts'); } catch { /* none */ }
    api = jasmine.createSpyObj<LinksApiService>('LinksApiService', ['self', 'links', 'streams', 'requests', 'offers', 'pairings', 'presence', 'send']);
    api.self.and.returnValue(of({ alfredId: 'me', name: 'PC-1', announce: true, version: '1' }));
    api.links.and.returnValue(of([LINK]));
    api.streams.and.returnValue(of([]));
    api.requests.and.returnValue(of([]));
    api.offers.and.returnValue(of([]));
    api.pairings.and.returnValue(of([]));
    api.presence.and.returnValue(of([]));
    events = new Subject();
    TestBed.configureTestingModule({
      providers: [
        { provide: LinksApiService, useValue: api },
        { provide: LinksSocketService, useValue: { events$: events, reconnected$: new Subject<void>(), stop: () => undefined } },
      ],
    });
  });

  it('keeps a request in this browser while its owner is offline, and sends it when it is back (D14)', () => {
    const state = TestBed.inject(LinksStateService);
    state.start();
    api.send.and.returnValue(throwError(() => new HttpErrorResponse({ status: 503, error: { error: 'OFFLINE', message: 'STG 83 is offline' } })));
    let answer: LinkRequest | null | undefined;
    state.send(REQ).subscribe((r) => (answer = r));
    expect(answer).toBeNull();
    expect(state.drafts().length).toBe(1);
    expect(state.drafts()[0].request).toEqual(REQ);

    const sent = { ...waiting('R1'), incoming: false };
    api.send.and.returnValue(of(sent));
    events.next({ type: 'signal', slug: 'stg-83', channel: 'resync', data: {} });
    expect(state.drafts().length).toBe(0);
    expect(state.requests().some((r) => r.id === 'R1')).toBeTrue();
  });

  it('a refusal for good is not kept as a draft', () => {
    const state = TestBed.inject(LinksStateService);
    api.send.and.returnValue(throwError(() => new HttpErrorResponse({ status: 403, error: { error: 'VIEW_ONLY', message: 'view only' } })));
    let failed: unknown;
    state.send(REQ).subscribe({ error: (e) => (failed = e) });
    expect(failed).toEqual({ error: 'VIEW_ONLY', message: 'view only', slug: undefined });
    expect(state.drafts().length).toBe(0);
  });

  it('says how many requests wait for an answer here in the tab title (D11)', () => {
    const state = TestBed.inject(LinksStateService);
    api.requests.and.returnValue(of([waiting('R1'), waiting('R2')]));
    state.start();
    expect(state.waiting().length).toBe(2);
    TestBed.flushEffects();
    TestBed.inject(ApplicationRef).tick();
    expect(document.title).toMatch(/^⇄2(\s|$)/);
    api.requests.and.returnValue(of([]));
    state.reload();
    TestBed.flushEffects();
    TestBed.inject(ApplicationRef).tick();
    expect(document.title.startsWith('⇄')).toBeFalse();
  });

  it('reads a problem from a backend answer, a dead connection and a problem passed on', () => {
    expect(problemOf(new HttpErrorResponse({ status: 0 })).error).toBe('OFFLINE');
    expect(problemOf(new HttpErrorResponse({ status: 409, error: { error: 'ANSWERED', message: 'x' } })).error).toBe('ANSWERED');
    expect(problemOf({ error: 'NOT_STREAMED', message: 'no' })).toEqual({ error: 'NOT_STREAMED', message: 'no' });
    expect(problemOf(new Error('boom')).message).toBe('boom');
  });
});
