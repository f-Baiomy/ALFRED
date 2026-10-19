import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideRouter } from '@angular/router';
import { computed, signal } from '@angular/core';
import { of } from 'rxjs';
import { LinksStateService } from '../../core/links/links-state.service';
import { LinksApiService } from '../../core/links/links-api.service';
import { LinkInfo, LinkRequest, Stream } from '../../core/links/links.models';
import { CommentsApiService } from '../../core/services/comments-api.service';
import { AppConfigService } from '../../core/services/app-config.service';
import { OriginPillComponent } from './origin-pill/origin-pill.component';
import { StreamDialogComponent } from './stream-dialog/stream-dialog.component';
import { StreamDialogService } from './stream-dialog/stream-dialog.service';
import { AskOwnerComponent } from './ask-owner/ask-owner.component';

const LINK: LinkInfo = {
  id: 'L1', slug: 'stg-83', name: 'STG 83', peerAlfredId: 'p', peerName: 'Alfred b', address: 'http://10.0.0.83:3000', dialer: true,
  createdAt: '2026-10-19T08:00:00Z', lastSeen: null, peerVersion: '1.53.0', online: true, rttMs: 4, clockOffsetMs: 0, skewed: false,
  lastError: null, stateSince: null, inFlight: 0, streamsOut: 0, streamsIn: 1,
};

function stream(over: Partial<Stream> = {}): Stream {
  return { id: 'S1', mine: false, linkId: 'L1', kind: 'BOARD', target: 'b1', targetName: 'dashboard', project: 'odeysys', mode: 'COMMENT',
    autoAccept: false, passOn: false, passMode: 'VIEW', unmasked: false, env: null, forBoard: null, createdAt: '2026-10-19T08:00:00Z',
    endedAt: null, ...over };
}

/** A LinksStateService standing in for the real one: its lists are plain signals the test sets. */
function fakeLinks(streams: Stream[], online = true) {
  const links = signal<LinkInfo[]>([{ ...LINK, online }]);
  const all = signal<Stream[]>(streams);
  const requests = signal<LinkRequest[]>([]);
  const sent: unknown[] = [];
  const fake = {
    links, requests, drafts: signal([]), presence: signal([]), autoAccepted: signal([]), offers: signal([]), pairings: signal([]),
    self: signal(null), loaded: signal(true), unavailable: signal(false),
    slugs: computed(() => new Set(links().map((l) => l.slug))),
    linkBySlug: computed(() => new Map(links().map((l) => [l.slug, l]))),
    linkById: computed(() => new Map(links().map((l) => [l.id, l]))),
    given: computed(() => all().filter((s) => !s.mine)),
    offered: computed(() => all().filter((s) => s.mine)),
    waiting: computed(() => requests().filter((r) => r.incoming && r.state === 'WAITING')),
    start: () => undefined, reload: () => undefined,
    linkOf: (slug: string | null | undefined) => (slug ? links().find((l) => l.slug === slug) : undefined),
    nameOf: (slug: string | null | undefined) => links().find((l) => l.slug === slug)?.name ?? slug ?? '',
    givenStream: (linkId: string, kind: string, target: string) => all().find((s) => !s.mine && s.linkId === linkId && s.kind === kind && s.target === target),
    streamsOf: (kind: string, target: string) => all().filter((s) => s.mine && s.kind === kind && s.target === target && !s.endedAt),
    send: (r: unknown) => {
      sent.push(r);
      return of({ id: 'R1', state: 'WAITING' } as LinkRequest);
    },
    withdraw: () => of(null), discardDraft: () => undefined,
  };
  return { fake, sent, all };
}

describe('origin pill (D24)', () => {
  it('names the Alfred a ref comes from, with its state and what the stream allows', () => {
    const { fake } = fakeLinks([stream({ kind: 'CYCLE', target: 'c1', mode: 'VIEW' })], false);
    TestBed.configureTestingModule({ imports: [OriginPillComponent], providers: [provideRouter([]), { provide: LinksStateService, useValue: fake }] });
    const f = TestBed.createComponent(OriginPillComponent);
    f.componentRef.setInput('ref', 'c1@stg-83');
    f.detectChanges();
    const el = f.nativeElement as HTMLElement;
    expect(el.textContent).toContain('⇇ STG 83');
    expect(el.textContent).toContain('offline');
    (el.querySelector('button') as HTMLButtonElement).click();
    f.detectChanges();
    expect(el.textContent).toContain('view only');
    expect(el.textContent).toContain('nothing of it is kept here');
  });

  it('shows nothing for this Alfred\'s own things, and a copy chip for a kept copy', () => {
    const { fake } = fakeLinks([]);
    TestBed.configureTestingModule({ imports: [OriginPillComponent], providers: [provideRouter([]), { provide: LinksStateService, useValue: fake }] });
    const f = TestBed.createComponent(OriginPillComponent);
    f.componentRef.setInput('ref', 'a-local-uuid');
    f.detectChanges();
    expect((f.nativeElement as HTMLElement).textContent?.trim()).toBe('');
    f.componentRef.setInput('copyOf', 'STG 83');
    f.detectChanges();
    expect((f.nativeElement as HTMLElement).textContent).toContain('copy · from STG 83');
  });
});

describe('Stream dialog (D5-D8)', () => {
  it('starts a cycle stream with what the user picked, never auto-accepting a view-only one', () => {
    const { fake } = fakeLinks([]);
    const api = jasmine.createSpyObj<LinksApiService>('LinksApiService', ['startStream', 'updateStream', 'stopStream']);
    api.startStream.and.returnValue(of(stream({ mine: true })));
    TestBed.configureTestingModule({ imports: [StreamDialogComponent], providers: [provideRouter([]),
      { provide: LinksStateService, useValue: fake }, { provide: LinksApiService, useValue: api }] });
    const f = TestBed.createComponent(StreamDialogComponent);
    TestBed.inject(StreamDialogService).open({ kind: 'CYCLE', target: 'c1', name: 'error flow', project: 'odeysys' });
    f.detectChanges();
    TestBed.flushEffects();
    f.detectChanges();
    const c = f.componentInstance;
    expect(c.draft().linkId).toBe('L1'); // the only link is picked
    c.patch({ autoAccept: true, passOn: true, passMode: 'COMMENT' });
    c.save();
    expect(api.startStream).toHaveBeenCalledWith(jasmine.objectContaining({ linkId: 'L1', kind: 'CYCLE', target: 'c1', mode: 'VIEW',
      autoAccept: false, passOn: true, passMode: 'COMMENT', unmasked: false }));
  });
});

describe('Ask the owner (D10-D14)', () => {
  it('sends a comment on another Alfred\'s card as a request over the board stream', () => {
    const { fake, sent } = fakeLinks([stream()]);
    TestBed.configureTestingModule({ imports: [AskOwnerComponent], providers: [{ provide: LinksStateService, useValue: fake }] });
    const f = TestBed.createComponent(AskOwnerComponent);
    f.componentRef.setInput('ref', 'card-7@stg-83');
    f.componentRef.setInput('kind', 'card');
    f.componentRef.setInput('label', '#7 Refund total');
    f.componentRef.setInput('streamRef', 'b1@stg-83');
    f.detectChanges();
    f.componentInstance.text.set('the total is off by the fee');
    f.componentInstance.send('CARD_COMMENT');
    expect(sent).toEqual([{ via: 'stg-83', streamId: 'S1', kind: 'CARD_COMMENT', target: 'card-7', targetLabel: '#7 Refund total',
      text: 'the total is off by the fee', extra: undefined }]);
  });

  it('says a view-only stream allows no request', () => {
    const { fake } = fakeLinks([stream({ mode: 'VIEW' })]);
    TestBed.configureTestingModule({ imports: [AskOwnerComponent], providers: [{ provide: LinksStateService, useValue: fake }] });
    const f = TestBed.createComponent(AskOwnerComponent);
    f.componentRef.setInput('ref', 'b1@stg-83');
    f.componentRef.setInput('kind', 'brief');
    f.detectChanges();
    expect((f.nativeElement as HTMLElement).textContent).toContain('View only');
    expect((f.nativeElement as HTMLElement).querySelector('textarea')).toBeNull();
  });
});

describe('CommentsApiService and another Alfred\'s calls (D25)', () => {
  it('turns a comment on a remote call into a note request, and never stores it here', () => {
    const { fake, sent } = fakeLinks([stream({ kind: 'CYCLE', target: 'c1' })]);
    TestBed.configureTestingModule({ providers: [provideHttpClient(), provideHttpClientTesting(),
      { provide: AppConfigService, useValue: { backendUrl: 'http://x' } }, { provide: LinksStateService, useValue: fake }] });
    const http = TestBed.inject(HttpTestingController);
    let made: { comment: string } | undefined;
    TestBed.inject(CommentsApiService).create({ callId: 'k1@stg-83', block: 'response-body', lineIndex: 3, lineText: '"total": 90', comment: 'why 90?' })
      .subscribe((c) => (made = c));
    http.expectNone('http://x/comments');
    expect(sent.length).toBe(1);
    expect(sent[0]).toEqual(jasmine.objectContaining({ via: 'stg-83', kind: 'CALL_NOTE', target: 'k1', text: 'why 90?' }));
    expect(made?.comment).toContain('waiting for STG 83');
  });
});
