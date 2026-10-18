import { TestBed, fakeAsync, flush } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideRouter } from '@angular/router';
import { Subject, of } from 'rxjs';
import { BoardStage } from '../../../core/models/board.models';
import { BoardSessionRow, HelperCommand, HelperRow, Me } from '../../../core/models/sessions.models';
import { BoardApiService } from '../../../core/services/board-api.service';
import { BoardMentionsService } from '../../../core/services/board-mentions.service';
import { ChatApiService } from '../../../core/services/chat-api.service';
import { SessionCyclesStateService } from '../../../core/state/session-cycles-state.service';
import { SessionsStateService } from '../../../core/state/sessions-state.service';
import { SkillRunsStateService } from '../../../core/state/skill-runs-state.service';
import { ClaudeAsk, NextStepCardComponent } from './next-step-card.component';

const COUNTS = { brief: true, items: 4, inbox: 4, waitingOnUser: 0, toDo: 2, inProgress: 0, fixed: 2, untested: 4, failing: 0, unmarked: 0 };
const step = (stage: BoardStage['stage'], kind: string, skill: string | null, count = 0): BoardStage =>
  ({ stage, ref: 'AB#59851', next: 'x', counts: COUNTS, step: { kind, skill, command: skill ? `/${skill} AB#59851` : null, count } });
const ME: Me = { user: 'me@x.ae', machine: 'PC', kind: 'BROWSER', keyId: 'b1', helperKeyId: 'h1', admin: false };
const HELPER: HelperRow = { keyId: 'h1', user: 'me@x.ae', machine: 'PC', online: true, lastSeen: null, createdAt: '' };
const SESSION = { id: 's1', boardId: 'b1', project: 'odeysys', cliSessionId: '2723f394-0000-0000-0000-000000000000', user: 'me@x.ae', machine: 'PC',
  helperKeyId: 'h1', state: 'ANSWERING', current: true, createdAt: '', lastActive: '' } as unknown as BoardSessionRow;

describe('NextStepCardComponent (specs/032 T045)', () => {
  let sessions: SessionsStateService;
  let runs: jasmine.SpyObj<SkillRunsStateService> & { cycles: () => unknown };
  let api: { recordForBoard: jasmine.Spy; nextSteps: jasmine.Spy };
  let chat: { post: jasmine.Spy };
  let mentions: BoardMentionsService;

  beforeEach(() => {
    runs = { watch: jasmine.createSpy(), watchCycle: jasmine.createSpy(), cycles: () => null, chat: jasmine.createSpy('chat').and.returnValue(null),
      run: jasmine.createSpy('run').and.returnValue(of({})) } as never;
    api = { recordForBoard: jasmine.createSpy('rec').and.returnValue(of({ cycleId: 'c9', message: '' })),
      nextSteps: jasmine.createSpy('next').and.returnValue(of({ waitingOnUser: [{ number: 74 }], waitingOnClaude: 0, toDo: 0, inProgress: 0, fixed: 0, inbox: 0 })) };
    chat = { post: jasmine.createSpy('post').and.returnValue(of({ id: 1 })) };
    TestBed.configureTestingModule({
      imports: [NextStepCardComponent],
      providers: [provideHttpClient(), provideHttpClientTesting(), provideRouter([]),
        { provide: SkillRunsStateService, useValue: runs },
        { provide: BoardApiService, useValue: api },
        { provide: ChatApiService, useValue: chat },
        { provide: SessionCyclesStateService, useValue: { refreshNow: jasmine.createSpy() } }],
    });
    sessions = TestBed.inject(SessionsStateService);
    spyOn(sessions, 'start');
    (sessions as unknown as { events$: Subject<unknown> }).events$ = new Subject();
    sessions.me.set(ME);
    sessions.helpers.set([HELPER]);
    mentions = TestBed.inject(BoardMentionsService);
  });

  afterEach(() => TestBed.inject(HttpTestingController).match(() => true));

  function render(stage: BoardStage, inputs: Record<string, unknown> = {}) {
    const f = TestBed.createComponent(NextStepCardComponent);
    f.componentRef.setInput('project', 'odeysys');
    f.componentRef.setInput('boardId', 'b1');
    f.componentRef.setInput('stage', stage);
    for (const [k, v] of Object.entries(inputs)) f.componentRef.setInput(k, v);
    f.detectChanges();
    const el = f.nativeElement as HTMLElement;
    const asks: ClaudeAsk[] = [];
    f.componentInstance.askClaude.subscribe((a) => asks.push(a));
    return { f, el, asks, primary: () => el.querySelector('.go') as HTMLButtonElement };
  }

  it('says the step in plain words, with the command only behind Copy for terminal', () => {
    const { el } = render(step('DEFINE', 'CLAUDE', 'alfred-setup'));
    expect(el.querySelector('.t')!.textContent).toBe('Define the task');
    expect(el.querySelector('.k')!.textContent).toBe('Next step');
    expect(el.querySelector('.d')!.textContent).not.toContain('/alfred');
    expect(el.textContent).toContain('⧉ Copy for terminal');
  });

  it('no Claude yet: ▶ Start Claude and <verb> asks the Claude button to start it with the step', () => {
    const { primary, asks } = render(step('DEFINE', 'CLAUDE', 'alfred-setup'));
    expect(primary().textContent).toBe('▶ Start Claude and define it');
    primary().click();
    expect(asks.map((a) => a.command)).toEqual(['/alfred-setup AB#59851']);
    expect(runs.run).not.toHaveBeenCalled();
  });

  it('Claude on: ▶ Ask Claude to <verb> queues the run in the board session', () => {
    sessions.sessions.set([SESSION]);
    runs.chat.and.returnValue({ host: 'PC', chatAlive: true } as never);
    const { primary, asks } = render(step('TRIAGE', 'CLAUDE', 'alfred-triage', 4));
    expect(primary().textContent).toBe('▶ Ask Claude to triage with me');
    primary().click();
    expect(runs.run).toHaveBeenCalledWith(jasmine.objectContaining({ cycleId: 'b1', command: '/alfred-triage AB#59851' }));
    expect(asks).toEqual([]);
  });

  it('paused: ▶ Resume Claude and <verb>', () => {
    sessions.sessions.set([{ ...SESSION, state: 'STOPPED' }]);
    const { primary, asks } = render(step('CODE', 'CLAUDE', 'alfred-fix', 2));
    expect(primary().textContent).toBe('▶ Resume Claude and fix them');
    primary().click();
    expect(asks.length).toBe(1);
  });

  it('busy: disabled while Claude is getting ready', () => {
    sessions.commands.set([{ id: 'c1', kind: 'START', state: 'TAKEN', boardId: 'b1', helperKeyId: 'h1', createdAt: '', updatedAt: '' } as HelperCommand]);
    const { primary } = render(step('VERIFY', 'CLAUDE', 'alfred-verify', 2));
    expect(primary().textContent).toBe('Claude is getting ready…');
    expect(primary().disabled).toBeTrue();
  });

  it('a terminal /alfred-live answers: the step goes to the board chat', () => {
    const { primary } = render(step('VERIFY', 'CLAUDE', 'alfred-verify', 2), { terminalOn: true });
    expect(primary().textContent).toBe('▶ Ask Claude to verify');
    primary().click();
    expect(chat.post).toHaveBeenCalledWith('odeysys', 'b1', { text: '/alfred-verify AB#59851' });
  });

  it('test: ● Record and watch while I test records, then asks for listen', fakeAsync(() => {
    const { primary, asks } = render(step('TEST', 'RECORD', 'alfred-listen', 4));
    expect(primary().textContent).toBe('● Record and watch while I test');
    primary().click();
    flush();
    expect(api.recordForBoard).toHaveBeenCalledWith('b1', 'REC', 'ASK');
    expect(asks.map((a) => a.command)).toEqual(['/alfred-listen AB#59851']);
  }));

  it('the user\'s step: Open them opens the first card waiting on them', () => {
    const { primary } = render(step('TRIAGE', 'USER', null, 2));
    expect(primary().textContent).toBe('Open them');
    primary().click();
    expect(mentions.cardToOpen()).toEqual({ project: 'odeysys', number: 74 });
  });

  it('Other steps ▾ lists every step with its command and Continue on another machine', () => {
    const { f, el } = render(step('DEFINE', 'CLAUDE', 'alfred-setup'));
    (Array.from(el.querySelectorAll('button')).find((b) => b.textContent?.includes('Other steps')) as HTMLButtonElement).click();
    f.detectChanges();
    const items = Array.from(el.querySelectorAll('.mi')).map((m) => m.firstChild?.textContent?.trim());
    expect(items).toEqual(['Define or re-define', 'Write or change the spec', 'Triage the Inbox', 'Fix the To do cards', 'Verify the fixes',
      'Listen while you test', 'Report', 'Continue on another machine']);
    expect(el.textContent).toContain('/alfred-resume AB#59851');
  });
});
