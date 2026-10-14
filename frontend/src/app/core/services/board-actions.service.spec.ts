import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed, fakeAsync, flushMicrotasks } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { Subject, of } from 'rxjs';
import { AskClaudeService } from './ask-claude.service';
import { BoardActionsService, chipAction } from './board-actions.service';
import { BoardApiService } from './board-api.service';
import { BoardSocketService } from './board-socket.service';
import { ConsentService } from './consent.service';

describe('ConsentService', () => {
  it('resolves with the user\'s click; a new request answers the older one "no"', async () => {
    const c = new ConsentService();
    const first = c.ask({ title: 'A', from: 'x', lines: [], confirmLabel: 'OK' });
    const second = c.ask({ title: 'B', from: 'x', lines: [], confirmLabel: 'OK' });
    expect(await first).toBeFalse();
    expect(c.state()?.title).toBe('B');
    c.respond(true);
    expect(await second).toBeTrue();
    expect(c.state()).toBeNull();
  });

  it('remembers "don\'t ask again" only for the key it was given', async () => {
    const c = new ConsentService();
    const p = c.ask({ title: 'Ask', from: 's', lines: [], confirmLabel: 'Ask', remember: 'ask:s1' });
    c.respond(true, true);
    await p;
    expect(await c.ask({ title: 'Ask', from: 's', lines: [], confirmLabel: 'Ask', remember: 'ask:s1' })).toBeTrue();
    expect(c.state()).toBeNull();
    void c.ask({ title: 'Ask', from: 's', lines: [], confirmLabel: 'Ask', remember: 'ask:s2' });
    expect(c.state()?.title).toBe('Ask');
    c.respond(false);
  });
});

describe('BoardActionsService', () => {
  let api: jasmine.SpyObj<BoardApiService>;
  let consent: ConsentService;
  let actions: BoardActionsService;
  const ctx = { project: 'p', cardId: 'c1', cardNumber: 7, cycleId: 'cy', comment: 3 };

  beforeEach(() => {
    api = jasmine.createSpyObj<BoardApiService>('BoardApiService', ['comment', 'move', 'requestSkillRun', 'retestRun', 'card', 'update', 'create']);
    api.comment.and.returnValue(of({}));
    api.move.and.returnValue(of({}) as never);
    api.requestSkillRun.and.returnValue(of({}) as never);
    api.card.and.returnValue(of({ flags: ["RISK"] }) as never);
    api.update.and.returnValue(of({}) as never);
    TestBed.configureTestingModule({ providers: [provideRouter([]), provideHttpClient(), { provide: BoardApiService, useValue: api }] });
    consent = TestBed.inject(ConsentService);
    actions = TestBed.inject(BoardActionsService);
  });

  it('reads chips into actions', () => {
    expect(chipAction('run', '/alfred-fix 33')).toEqual({ kind: 'run-skill', args: { command: '/alfred-fix 33' } });
    expect(chipAction('move', 'FIXED')).toEqual({ kind: 'move', args: { status: 'FIXED' } });
    expect(chipAction('open', '@[call:in:a1|POST /x]')).toEqual({ kind: 'open-call', args: { call: 'in:a1' } });
  });

  it('nothing runs until the user clicks, and nothing at all on "no"', async () => {
    const p = actions.perform('move', { status: 'in progress' }, ctx, 'The snippet');
    await Promise.resolve();
    expect(consent.state()?.lines).toEqual(['Move #7 to In progress']);
    expect(consent.state()?.from).toBe('The snippet');
    expect(api.move).not.toHaveBeenCalled();
    consent.respond(false);
    await expectAsync(p).toBeRejectedWithError('The user said no');
    expect(api.move).not.toHaveBeenCalled();
  });

  it('runs exactly the change shown, as the user', async () => {
    const p = actions.perform('answer', { choice: 'Per rule' }, ctx, 'This choice');
    await Promise.resolve();
    expect(consent.state()?.exact).toBe('**Answer** choice: Per rule');
    consent.respond(true);
    await p;
    expect(api.comment).toHaveBeenCalledOnceWith('c1', '**Answer** choice: Per rule', 3, true);
  });

  it('refuses what is not an action, or not well formed, before any dialog', async () => {
    await expectAsync(actions.perform('delete', {}, ctx, 'x')).toBeRejectedWithError(/not an action/);
    await expectAsync(actions.perform('move', { status: 'GONE' }, ctx, 'x')).toBeRejectedWithError(/move needs/);
    await expectAsync(actions.perform('run-skill', { command: 'rm -rf /' }, ctx, 'x')).toBeRejectedWithError(/run-skill needs/);
    await expectAsync(actions.perform('reply', { text: 'hi' }, { project: 'p' }, 'x')).toBeRejectedWithError(/not on one/);
    expect(consent.state()).toBeNull();
  });

  it('a flag keeps the card\'s other flags', async () => {
    const p = actions.perform('flag', { flag: 'urgent' }, ctx, 'x');
    await Promise.resolve();
    consent.respond(true);
    await p;
    expect(api.update).toHaveBeenCalledOnceWith('c1', { flags: ['RISK', 'URGENT'] });
  });

  it('a skill goes to the cycle\'s chat with the card', async () => {
    const p = actions.perform('run-skill', { command: '/alfred-verify 7' }, ctx, 'x');
    await Promise.resolve();
    consent.respond(true);
    await p;
    expect(api.requestSkillRun).toHaveBeenCalledOnceWith(jasmine.objectContaining({ cycleId: 'cy', cardNumber: 7, command: '/alfred-verify 7' }));
  });
});

describe('AskClaudeService', () => {
  it('sends the question and waits for its ask:<id> signal - also one that came before the wait', fakeAsync(() => {
    const events = new Subject<{ type: string; what: string }>();
    TestBed.configureTestingModule({ providers: [provideHttpClient(), provideHttpClientTesting(),
      { provide: BoardSocketService, useValue: { events$: events } }] });
    const asks = TestBed.inject(AskClaudeService);
    const http = TestBed.inject(HttpTestingController);
    let answer: string | null = null;
    void asks.ask({ kind: 'SNIPPET', question: 'why?' }).then((a) => (answer = a));
    http.expectOne((r) => r.method === 'POST' && r.url.endsWith('/board/asks')).flush({ id: 'k1', state: 'OPEN', answer: null, question: 'why?' });
    flushMicrotasks();
    // a signal that lands while the first read is on its way is not lost: it brings a second read
    events.next({ type: 'board-changed', what: 'ask:k1' });
    http.expectOne((r) => r.url.endsWith('/board/asks/k1')).flush({ id: 'k1', state: 'OPEN', answer: null, question: 'why?' });
    flushMicrotasks();
    http.expectOne((r) => r.url.endsWith('/board/asks/k1')).flush({ id: 'k1', state: 'OPEN', answer: null, question: 'why?' });
    flushMicrotasks();
    expect(answer).toBeNull();
    events.next({ type: 'board-changed', what: 'ask:other' });
    flushMicrotasks();
    http.expectNone((r) => r.url.endsWith('/board/asks/k1'));
    events.next({ type: 'board-changed', what: 'ask:k1' });
    flushMicrotasks();
    http.expectOne((r) => r.url.endsWith('/board/asks/k1')).flush({ id: 'k1', state: 'ANSWERED', answer: 'Because.', question: 'why?' });
    flushMicrotasks();
    expect(answer as string | null).toBe('Because.');
    http.verify();
  }));

  it('a withdrawn question rejects', fakeAsync(() => {
    TestBed.configureTestingModule({ providers: [provideHttpClient(), provideHttpClientTesting(),
      { provide: BoardSocketService, useValue: { events$: new Subject() } }] });
    const asks = TestBed.inject(AskClaudeService);
    const http = TestBed.inject(HttpTestingController);
    let error: unknown = null;
    asks.answer('k2').catch((e) => (error = e));
    http.expectOne((r) => r.url.endsWith('/board/asks/k2')).flush({ id: 'k2', state: 'CANCELLED', answer: null, question: '' });
    flushMicrotasks();
    expect((error as Error).message).toBe('The question was withdrawn');
  }));
});
