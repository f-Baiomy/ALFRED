import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideRouter } from '@angular/router';
import { Subject, of } from 'rxjs';
import { BoardSessionButtonComponent } from './board-session-button.component';
import { SessionsStateService } from '../../core/state/sessions-state.service';
import { BoardSessionRow, HelperCommand, HelperRow, Holder, Me } from '../../core/models/sessions.models';

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

  it('asks where the project is - and why - before starting on a PC that has no folder for it', () => {
    const send = spyOn(state, 'send').and.returnValue(of({ id: 'c1' } as HelperCommand));
    state.settings.set({});
    const f = render();
    (f.nativeElement.querySelector('.main') as HTMLButtonElement).click();
    f.detectChanges();
    expect(send).not.toHaveBeenCalled();
    expect(f.nativeElement.textContent).toContain("Where is odeysys's code on WORK-PC?");
    expect(f.nativeElement.textContent).toContain('so Claude can read the code');

    const browse = [...f.nativeElement.querySelectorAll('button')].find((b: HTMLButtonElement) => b.textContent?.includes('Browse')) as HTMLButtonElement;
    browse.click();
    f.detectChanges();
    expect(send).toHaveBeenCalledWith('PICK_FOLDER', jasmine.objectContaining({ project: 'odeysys' }));
    expect(f.nativeElement.textContent).toContain('Look for it on the taskbar');
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

  it('says a session of another Windows user on this same PC is not here', () => {
    state.helpers.set([{ ...HELPER, osUser: 'work' }, { ...HELPER, keyId: 'h2', osUser: 'OMEN' }]);
    state.sessions.set([{ ...SESSION, helperKeyId: 'h2' }]);
    const f = render();
    expect(f.nativeElement.querySelector('.main').textContent).toContain('Session on WORK-PC');
  });

  it("asks for a folder when only another Windows user on this PC has one", () => {
    const send = spyOn(state, 'send').and.returnValue(of(null));
    state.helpers.set([{ ...HELPER, osUser: 'work' }]);
    state.settings.set({ projects: [{ project: 'odeysys', machine: 'WORK-PC', osUser: 'OMEN', folder: 'C:/Users/OMEN/o', openIn: 'DESKTOP', worktrees: true }] });
    const f = render();
    (f.nativeElement.querySelector('.main') as HTMLButtonElement).click();
    f.detectChanges();
    expect(send).not.toHaveBeenCalled();
    expect(f.nativeElement.textContent).toContain("Where is odeysys's code on WORK-PC?");
  });

  it('asks a browser on a PC that is not connected to connect it, then goes on by itself', () => {
    const send = spyOn(state, 'send').and.returnValue(of(null));
    state.me.set({ ...ME, user: null });
    state.helpers.set([]);
    const f = render();
    (f.nativeElement.querySelector('.main') as HTMLButtonElement).click();
    f.detectChanges();
    expect(f.nativeElement.textContent).toContain('Connect this PC to use your Claude');
    expect(f.nativeElement.textContent).toContain('Connect this PC');
    expect(send).not.toHaveBeenCalled();

    // the connect file ran on this PC: the browser has its key and the helper is online
    state.me.set(ME);
    state.helpers.set([HELPER]);
    f.detectChanges();
    expect(send).toHaveBeenCalledWith('START', jasmine.objectContaining({ boardId: 'b1' }));
    expect(f.nativeElement.textContent).not.toContain('Connect this PC to use your Claude');
  });

  it('waits for the connect file it downloaded and collects its key on the signal', () => {
    state.me.set({ ...ME, user: null });
    state.connecting.set({ connectId: 'c1', collectSecret: 's', expiresAt: new Date(Date.now() + 60_000).toISOString(), fileName: 'alfred-connect.cmd',
      script: '', run: 'Double-click alfred-connect.cmd in your Downloads', versions: { helper: '', skills: '', node: true } });
    const f = render();
    (f.nativeElement.querySelector('.main') as HTMLButtonElement).click();
    f.detectChanges();
    expect(f.nativeElement.textContent).toContain('Double-click alfred-connect.cmd in your Downloads');

    state.collect();
    const http = TestBed.inject(HttpTestingController);
    const req = http.expectOne((r) => r.url.endsWith('/board/connect/collect'));
    expect(req.request.body).toEqual({ connectId: 'c1', collectSecret: 's' });
    req.flush({ keyId: 'b9', key: 'ak_0123456789abcdef.x', user: 'me@x.ae', machine: 'WORK-PC' });
    expect(state.connecting()).toBeNull();
    state.cancelConnect();
  });
});
