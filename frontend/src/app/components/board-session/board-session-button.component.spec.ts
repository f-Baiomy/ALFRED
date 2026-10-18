import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideRouter } from '@angular/router';
import { Subject, of } from 'rxjs';
import { BoardSessionButtonComponent } from './board-session-button.component';
import { SessionsStateService } from '../../core/state/sessions-state.service';
import { BoardSessionRow, HelperRow, Holder, Me } from '../../core/models/sessions.models';

const ME: Me = { user: 'me@x.ae', machine: 'WORK-PC', kind: 'BROWSER', keyId: 'b1', helperKeyId: 'h1', admin: false };
const HELPER: HelperRow = { keyId: 'h1', user: 'me@x.ae', machine: 'WORK-PC', online: true, lastSeen: null, createdAt: '' };
const SESSION: BoardSessionRow = { id: 's1', boardId: 'b1', project: 'odeysys', cliSessionId: '4e7c1a02-91b3-4d6e-a0f2-7c55e1d0b9a3', desktopId: null,
  user: 'me@x.ae', machine: 'WORK-PC', helperKeyId: 'h1', cwd: 'C:/w', title: 'AB#1', state: 'ANSWERING', openIn: 'NONE', lastChatSeq: 0,
  tokensToday: 1000, tokensDay: null, current: true, createdAt: '', lastActive: '' };

describe('BoardSessionButtonComponent (specs/031)', () => {
  let state: SessionsStateService;

  function render() {
    const f = TestBed.createComponent(BoardSessionButtonComponent);
    f.componentRef.setInput('project', 'odeysys');
    f.componentRef.setInput('boardId', 'b1');
    f.detectChanges();
    return f;
  }

  beforeEach(() => {
    TestBed.configureTestingModule({ imports: [BoardSessionButtonComponent], providers: [provideHttpClient(), provideHttpClientTesting(), provideRouter([])] });
    state = TestBed.inject(SessionsStateService);
    spyOn(state, 'start');
    (state as unknown as { events$: Subject<unknown> }).events$ = new Subject();
    state.me.set(ME);
    state.helpers.set([HELPER]);
    state.settings.set({ projects: [{ project: 'odeysys', machine: 'WORK-PC', folder: 'C:/w', openIn: 'DESKTOP', worktrees: true }] });
  });

  afterEach(() => TestBed.inject(HttpTestingController).match(() => true));

  it('offers ▶ alfred-live on a free board and sends START to this browser\'s PC', () => {
    const send = spyOn(state, 'send').and.returnValue(of(null));
    const f = render();
    const main = f.nativeElement.querySelector('.main') as HTMLButtonElement;
    expect(main.textContent).toContain('alfred-live');
    main.click();
    expect(send).toHaveBeenCalledWith('START', jasmine.objectContaining({ boardId: 'b1', project: 'odeysys' }));
  });

  it('asks for the folder first when the project has none on this PC', () => {
    state.settings.set({});
    const f = render();
    (f.nativeElement.querySelector('.main') as HTMLButtonElement).click();
    f.detectChanges();
    expect(f.nativeElement.textContent).toContain('Where is odeysys');
  });

  it('shows the attached session while it answers', () => {
    state.sessions.set([SESSION]);
    const f = render();
    expect(f.nativeElement.querySelector('.main').textContent).toContain('Live · session 4e7c1a02');
  });

  it('shows who holds a board someone else holds, and never offers to start there', () => {
    const h: Holder = { boardId: 'b1', project: 'odeysys', user: 'ahmed@x.ae', machine: 'DEV', sessionId: 'x', since: '', commenters: [], request: null };
    state.holders.set([h]);
    const f = render();
    expect(f.nativeElement.querySelector('.main').textContent).toContain('Held by ahmed@x.ae');
  });

  it('says the session lives on another PC', () => {
    state.sessions.set([{ ...SESSION, machine: 'LAPTOP-2', helperKeyId: 'h2' }]);
    const f = render();
    expect(f.nativeElement.querySelector('.main').textContent).toContain('Session on LAPTOP-2');
  });

  it('asks an unpaired browser to pair first', () => {
    state.me.set({ ...ME, user: null });
    const f = render();
    (f.nativeElement.querySelector('.main') as HTMLButtonElement).click();
    f.detectChanges();
    expect(f.nativeElement.textContent).toContain('Pair this browser first');
  });
});
