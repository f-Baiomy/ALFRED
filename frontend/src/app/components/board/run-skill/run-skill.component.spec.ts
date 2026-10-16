import { TestBed, fakeAsync, flush, tick } from '@angular/core/testing';
import { HttpErrorResponse } from '@angular/common/http';
import { Subject, of, throwError } from 'rxjs';
import { BoardSocketEvent, CardSummary, CycleChat, CycleChatInfo, SkillRun, SkillRunsPage } from '../../../core/models/board.models';
import { AppConfigService } from '../../../core/services/app-config.service';
import { BoardApiService } from '../../../core/services/board-api.service';
import { BoardSocketService } from '../../../core/services/board-socket.service';
import { SkillRunsStateService } from '../../../core/state/skill-runs-state.service';
import { RunSkillComponent } from './run-skill.component';
import { RunHistoryComponent } from './run-history.component';

const CHAT: CycleChat = { project: 'p', cycleId: 'cy', chatId: 'chat-a', host: 'laptop', cwd: 'C:/work/odeysys', kinds: ['live', 'listen'], chatAlive: true,
  since: '2026-10-14T09:00:00Z', lastSeen: '2026-10-14T10:00:00Z' };
const CARD = { number: 35, kind: 'BUG', status: 'TO_DO', title: 'pax-details fans out to 30 statements', waiting: null } as unknown as CardSummary;

function run(over: Partial<SkillRun> = {}): SkillRun {
  const now = new Date().toISOString();
  return {
    id: 'r1', project: 'p', cycleId: 'cy', cardNumber: 35, command: '/alfred-fix 35', prompt: '/alfred-fix 35', note: null, model: null, host: null,
    state: 'RUNNING', outcome: null, failure: null, retryAt: null, autoRetry: false, result: null, steps: [], stop: false,
    takenBy: 'laptop', createdAt: now, takenAt: now, endedAt: null, updatedAt: now, chatId: 'chat-a', ...over,
  };
}

describe('RunSkillComponent', () => {
  // navigator.clipboard is a global: put it back for the next spec file (see clipboard.spec.ts)
  const original = Object.getOwnPropertyDescriptor(Navigator.prototype, 'clipboard');
  afterEach(() => {
    if (original) Object.defineProperty(navigator, 'clipboard', { ...original, configurable: true });
    else delete (navigator as { clipboard?: unknown }).clipboard;
  });

  let events: Subject<BoardSocketEvent>;
  let api: jasmine.SpyObj<BoardApiService>;
  let page: SkillRunsPage;
  let info: CycleChatInfo;
  let copied: string[];

  beforeEach(() => {
    events = new Subject();
    page = { runs: [], usualMs: {} };
    info = { chat: CHAT, lastCwd: 'C:/work/odeysys' };
    copied = [];
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: (t: string) => { copied.push(t); return Promise.resolve(); } }, configurable: true });
    api = jasmine.createSpyObj<BoardApiService>('BoardApiService', ['cycleChat', 'skillRuns', 'requestSkillRun', 'stopSkillRun', 'stopAllSkillRuns', 'cardByNumber']);
    api.cycleChat.and.callFake(() => of(info));
    api.skillRuns.and.callFake(() => of(page));
    api.requestSkillRun.and.callFake((r) => of(run({ state: 'QUEUED', command: r.command, prompt: r.prompt, note: r.note ?? null, takenAt: null })));
    api.stopSkillRun.and.callFake((id: string) => of(run({ id, state: 'CANCELLED', endedAt: new Date().toISOString() })));
    TestBed.configureTestingModule({
      imports: [RunSkillComponent, RunHistoryComponent],
      providers: [
        { provide: BoardApiService, useValue: api },
        { provide: BoardSocketService, useValue: { events$: events, reconnected$: new Subject<void>() } },
        { provide: AppConfigService, useValue: { backendUrl: 'http://localhost:3000' } },
      ],
    });
  });

  function render(over: { command?: string; editable?: boolean; copyOnly?: boolean; cycleId?: string | null } = {}) {
    const f = TestBed.createComponent(RunSkillComponent);
    f.componentRef.setInput('command', over.command ?? '/alfred-fix 35');
    f.componentRef.setInput('project', 'p');
    f.componentRef.setInput('cycleId', over.cycleId === undefined ? 'cy' : over.cycleId);
    f.componentRef.setInput('cycleName', 'Performance');
    f.componentRef.setInput('card', CARD);
    if (over.editable !== undefined) f.componentRef.setInput('editable', over.editable);
    if (over.copyOnly !== undefined) f.componentRef.setInput('copyOnly', over.copyOnly);
    f.detectChanges();
    f.detectChanges(); // the project and cycle are watched by an effect: the chat and runs arrive after the first pass
    return f;
  }

  const go = (el: HTMLElement) => el.querySelector('.run-go') as HTMLButtonElement;
  const cls = (el: HTMLElement) => el.querySelector('.run-skill')?.className ?? '';
  const signal = (state: SkillRun['state']) => events.next({ type: 'skill-run', project: 'p', id: 'r1', cardNumber: 35, state });

  it('with a chat on the cycle, ▶ sends the full prompt into it; the button follows sent, busy, running in the chat and done', fakeAsync(() => {
    const f = render();
    const el: HTMLElement = f.nativeElement;
    expect(go(el).textContent).toContain('▶');
    expect(go(el).title).toContain('Run in the cycle\'s chat (laptop, since');

    go(el).click();
    f.detectChanges();
    const sent = api.requestSkillRun.calls.mostRecent().args[0];
    expect(sent.command).toBe('/alfred-fix 35');
    expect(sent.cycleId).toBe('cy');
    expect(sent.prompt).toBe('/alfred-fix 35\nAlfred: http://localhost:3000 · project p · cycle "Performance" (cy)\nCard #35 BUG To do "pax-details fans out to 30 statements"');
    expect(cls(el)).toContain('run-sent');
    expect(go(el).textContent).toContain('sent to the chat');
    expect(el.querySelector('.run-stop')).not.toBeNull();

    page = { runs: [run({ state: 'SENT', createdAt: new Date(Date.now() - 20_000).toISOString(), takenAt: null })], usualMs: {} };
    signal('SENT');
    tick(200);
    f.detectChanges();
    expect(cls(el)).toContain('run-busy');
    expect(go(el).textContent).toContain('waiting - the chat is busy');

    page = { runs: [run()], usualMs: { '/alfred-fix': 40_000 } };
    signal('RUNNING');
    tick(200);
    f.detectChanges();
    expect(cls(el)).toContain('run-running');
    expect(go(el).textContent).toContain('running in the chat');
    expect(el.querySelector('.run-stop')).toBeNull();

    page = { runs: [run({ state: 'DONE', outcome: '→ plan posted on #35 - waiting on your Go', result: '#35', endedAt: new Date().toISOString() })], usualMs: {} };
    signal('DONE');
    tick(200);
    f.detectChanges();
    expect(cls(el)).toContain('run-done');
    expect(el.querySelector('.run-msg')?.textContent).toContain('✓ → plan posted on #35');
    expect(el.querySelector('.run-msg')?.textContent).toContain('open #35');
    f.destroy();
    flush();
  }));

  it('with no chat on the cycle, ▶ shows how to start one - the repo, /alfred-live and /alfred-listen for the cycle, each to copy', fakeAsync(() => {
    info = { chat: null, lastCwd: 'C:/work/odeysys' };
    const f = render();
    const el: HTMLElement = f.nativeElement;
    expect(go(el).textContent).toContain('▶');
    expect(el.querySelector('.run-caret')).toBeNull();
    go(el).click();
    f.detectChanges();
    expect(api.requestSkillRun).not.toHaveBeenCalled();
    const lines = Array.from(el.querySelectorAll('.run-cmdline')).map((b) => b.textContent?.trim());
    expect(lines[0]).toContain('cd "C:/work/odeysys"');
    expect(lines[1]).toContain('/alfred-live cy');
    expect(lines[2]).toContain('/alfred-listen cy');
    (el.querySelectorAll('.run-cmdline')[1] as HTMLButtonElement).click();
    tick();
    expect(copied).toEqual(['/alfred-live cy']);
    f.destroy();
    flush();
  }));

  it('a closed chat: the waiting run says so and points to the start steps', () => {
    info = { chat: { ...CHAT, chatAlive: false }, lastCwd: null };
    page = { runs: [run({ state: 'SENT', takenAt: null })], usualMs: {} };
    const f = render();
    const el: HTMLElement = f.nativeElement;
    expect(cls(el)).toContain('run-closed');
    expect(go(el).textContent).toContain('the chat seems closed');
    expect(el.querySelector('.run-msg')?.textContent).toContain('open it again');
  });

  it('no cycle, a read-only board and a copy-only command copy only', fakeAsync(() => {
    const noCycle = render({ cycleId: null, command: '/alfred-triage' });
    expect(go(noCycle.nativeElement).textContent).toContain('⧉');
    go(noCycle.nativeElement).click();
    tick();
    expect(copied[0]).toContain('/alfred-triage\nAlfred: http://localhost:3000');
    expect(api.requestSkillRun).not.toHaveBeenCalled();
    expect(go(render({ editable: false }).nativeElement).textContent).toContain('⧉');
    const f = render({ command: '/alfred-resume Performance', copyOnly: true });
    expect(f.nativeElement.querySelector('.run-cp')).toBeNull();
    expect(go(f.nativeElement).title).toContain('another Claude Code session');
    // a command for another session copies as typed there, and says it did
    go(f.nativeElement).click();
    tick();
    f.detectChanges();
    expect(copied[copied.length - 1]).toBe('/alfred-resume Performance');
    expect(go(f.nativeElement).textContent).toContain('copied');
    flush();
  }));

  it('a failure says what came of it, with copy the prompt and retry', () => {
    page = { runs: [run({ state: 'FAILED', failure: 'error', outcome: 'the repo has uncommitted changes', endedAt: new Date().toISOString() })], usualMs: {} };
    const f = render();
    const msg = f.nativeElement.querySelector('.run-msg') as HTMLElement;
    expect(msg.className).toContain('run-msg-err');
    expect(msg.textContent).toContain('the chat could not run it: the repo has uncommitted changes');
    expect(msg.textContent).toContain('copy the prompt');
    (Array.from(msg.querySelectorAll('.board-link')).find((b) => b.textContent?.trim() === 'retry') as HTMLButtonElement).click();
    expect(api.requestSkillRun).toHaveBeenCalled();
  });

  it('a refused request shows the reason; a chat gone meanwhile shows the start steps', () => {
    api.requestSkillRun.and.returnValue(throwError(() => new HttpErrorResponse({ status: 409, error: { message: 'Already waiting for the chat: /alfred-sync 35' } })));
    const f = render();
    go(f.nativeElement).click();
    f.detectChanges();
    expect(f.nativeElement.querySelector('.run-msg')?.textContent).toContain('Already waiting for the chat: /alfred-sync 35');
    api.requestSkillRun.and.returnValue(throwError(() => new HttpErrorResponse({ status: 404, error: { message: 'No chat handles this cycle' } })));
    go(f.nativeElement).click();
    f.detectChanges();
    expect(f.nativeElement.querySelector('.run-start-steps')).not.toBeNull();
  });

  it('▾ edits the prompt and adds a note; no model or machine to pick - the chat runs it', () => {
    const f = render();
    const el: HTMLElement = f.nativeElement;
    (el.querySelector('.run-caret') as HTMLButtonElement).click();
    f.detectChanges();
    const items = Array.from(el.querySelectorAll('.run-mi')) as HTMLElement[];
    expect(items.map((i) => i.textContent?.trim().split('\n')[0])).toContain('⧉ Copy as a shell line claude -p "…"');
    expect(el.textContent).not.toContain('Model');
    expect(el.textContent).not.toContain('Run on');
    (items.find((i) => i.textContent?.includes('Add a note')) as HTMLButtonElement).click();
    f.detectChanges();
    const text = el.querySelector('.run-text') as HTMLTextAreaElement;
    text.value = '/alfred-fix 35\nonly the mapping';
    text.dispatchEvent(new Event('input'));
    const note = el.querySelector('.run-input') as HTMLInputElement;
    note.value = 'do not touch the DAO';
    note.dispatchEvent(new Event('input'));
    (el.querySelector('.run-primary') as HTMLButtonElement).click();
    f.detectChanges();
    const sent = api.requestSkillRun.calls.mostRecent().args[0];
    expect(sent.prompt).toBe('/alfred-fix 35\nonly the mapping');
    expect(sent.note).toBe('do not touch the DAO');
    expect(el.querySelector('.run-dialog')).toBeNull();
  });

  it('✕ cancels a request the chat has not taken yet', () => {
    page = { runs: [run({ state: 'SENT', takenAt: null })], usualMs: {} };
    const f = render();
    (f.nativeElement.querySelector('.run-stop') as HTMLButtonElement).click();
    expect(api.stopSkillRun).toHaveBeenCalledWith('r1');
  });

  it('the card\'s run history lists each run with the chat it ran in', () => {
    page = { runs: [run({ state: 'DONE', outcome: '→ done', endedAt: new Date().toISOString(), note: 'only the SQL', steps: ['reading the SQL'] }),
      run({ id: 'r0', state: 'FAILED', failure: 'lost', command: '/alfred-sync 35' })], usualMs: {} };
    TestBed.inject(SkillRunsStateService).watch('p');
    const f = TestBed.createComponent(RunHistoryComponent);
    f.componentRef.setInput('project', 'p');
    f.componentRef.setInput('number', 35);
    f.detectChanges();
    const el: HTMLElement = f.nativeElement;
    expect(el.querySelectorAll('.run-hist-row').length).toBe(2);
    expect(el.textContent).toContain('/alfred-sync 35');
    expect(el.textContent).toContain('chat on laptop');
    (el.querySelector('.run-hist-toggle') as HTMLButtonElement).click();
    f.detectChanges();
    expect(el.querySelector('.run-hist-steps')?.textContent).toContain('your note: only the SQL');
    expect(el.querySelector('.run-hist-steps')?.textContent).toContain('reading the SQL');
  });
});
