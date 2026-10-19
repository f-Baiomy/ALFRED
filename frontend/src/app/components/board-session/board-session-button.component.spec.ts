import { TestBed, fakeAsync, tick } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideRouter } from '@angular/router';
import { Subject, of } from 'rxjs';
import { BoardSessionButtonComponent, PAUSE_SLOW_MS } from './board-session-button.component';
import { SessionsStateService } from '../../core/state/sessions-state.service';
import { BoardBannerService } from '../../core/state/board-banner.service';
import { BoardSessionRow, HelperCommand, HelperRow, Holder, Me } from '../../core/models/sessions.models';

const ME: Me = { user: 'me@x.ae', machine: 'WORK-PC', kind: 'BROWSER', keyId: 'b1', helperKeyId: 'h1', admin: false };
const HELPER: HelperRow = { keyId: 'h1', user: 'me@x.ae', machine: 'WORK-PC', online: true, lastSeen: null, createdAt: '' };
const SESSION: BoardSessionRow = { id: 's1', boardId: 'b1', project: 'odeysys', cliSessionId: '4e7c1a02-91b3-4d6e-a0f2-7c55e1d0b9a3', desktopId: null,
  user: 'me@x.ae', machine: 'WORK-PC', helperKeyId: 'h1', cwd: 'C:/w', title: 'AB#1', state: 'ANSWERING', openIn: 'NONE', lastChatSeq: 0,
  tokensToday: 1000, tokensDay: null, current: true, createdAt: '2026-10-18T10:00:00Z', lastActive: '2026-10-18T10:00:00Z' };
const cmd = (kind: HelperCommand['kind'], state: HelperCommand['state'], result: string | null = null, id = 'c1'): HelperCommand => ({
  id, helperKeyId: 'h1', user: 'me@x.ae', kind, boardId: 'b1', project: 'odeysys', sessionId: 's1', args: '{"cliSessionId":"x"}', state, result,
  createdAt: '2026-10-18T11:00:00Z', updatedAt: '2026-10-18T11:00:00Z' });

describe('BoardSessionButtonComponent (specs/031, specs/032)', () => {
  let state: SessionsStateService;
  let banner: BoardBannerService;

  function render(inputs: Record<string, unknown> = {}) {
    const f = TestBed.createComponent(BoardSessionButtonComponent);
    f.componentRef.setInput('project', 'odeysys');
    f.componentRef.setInput('boardId', 'b1');
    f.componentRef.setInput('ref', 'AB#1');
    // an answering session's runner listens to the board chat - the page passes that as terminalOn
    const listening = state.sessions().some((x) => x.state === 'ANSWERING');
    for (const [k, v] of Object.entries({ ...(listening ? { terminalOn: true } : {}), ...inputs })) f.componentRef.setInput(k, v);
    f.detectChanges();
    return f;
  }
  const main = (f: { nativeElement: HTMLElement }) => f.nativeElement.querySelector('.cb') as HTMLButtonElement;
  const button = (f: { nativeElement: HTMLElement }, text: string) =>
    Array.from(f.nativeElement.querySelectorAll<HTMLButtonElement>('button')).find((b) => b.textContent?.includes(text)) as HTMLButtonElement;

  beforeEach(() => {
    TestBed.configureTestingModule({ imports: [BoardSessionButtonComponent], providers: [provideHttpClient(), provideHttpClientTesting(), provideRouter([])] });
    state = TestBed.inject(SessionsStateService);
    banner = TestBed.inject(BoardBannerService);
    spyOn(state, 'start');
    (state as unknown as { events$: Subject<unknown> }).events$ = new Subject();
    state.me.set(ME);
    state.helpers.set([HELPER]);
    state.settings.set({ projects: [{ project: 'odeysys', machine: 'WORK-PC', folder: 'C:/w', openIn: 'DESKTOP', worktrees: true }] });
  });

  afterEach(() => TestBed.inject(HttpTestingController).match(() => true));

  describe('modes (T051)', () => {
    it('▶ Start Claude on a free board sends START to this browser\'s PC', () => {
      const send = spyOn(state, 'send').and.returnValue(of(null));
      const f = render();
      expect(main(f).textContent).toContain('▶ Start Claude');
      main(f).click();
      expect(send).toHaveBeenCalledWith('START', jasmine.objectContaining({ boardId: 'b1', project: 'odeysys' }));
    });

    it('● Claude on while it answers', () => {
      state.sessions.set([SESSION]);
      // the board page passes whether anything listens to the chat: the session's runner does while it answers
      expect(main(render({ terminalOn: true })).textContent).toContain('● Claude on');
    });

    it('▶ Resume Claude when the session says it answers but nothing listens to the chat (its runner died)', () => {
      state.sessions.set([SESSION]);
      const b = main(render({ terminalOn: false }));
      expect(b.textContent).toContain('▶ Resume Claude');
      expect(b.title).toContain('nothing listens to its chat');
    });

    it('▶ Resume Claude when paused - and Resume catches up on what waits', () => {
      const send = spyOn(state, 'send').and.returnValue(of(null));
      state.sessions.set([{ ...SESSION, state: 'STOPPED' }]);
      const f = render({ unread: 3, chatSeq: 42 });
      expect(main(f).textContent).toContain('▶ Resume Claude');
      main(f).click();
      expect(send).toHaveBeenCalledWith('RESUME', jasmine.objectContaining({ args: jasmine.objectContaining({ unread: 3, chatSeq: 42, boardRef: 'AB#1' }) }));
    });

    it('◌ Starting Claude… with what it does now as the tooltip', () => {
      state.commands.set([cmd('START', 'TAKEN')]);
      state.sessions.set([{ ...SESSION, state: 'STARTING', progress: 'Making the worktree' }]);
      const f = render();
      expect(main(f).textContent).toContain('Starting Claude…');
      expect(main(f).disabled).toBeTrue();
      expect(main(f).title).toBe('Making the worktree');
    });

    it("⚠ Claude didn't start, with the reason and Try again in the panel", () => {
      const send = spyOn(state, 'send').and.returnValue(of(null));
      state.commands.set([cmd('START', 'FAILED', "claude exited 1: You've hit your weekly limit · resets Oct 20, 5pm (Africa/Cairo)")]);
      const f = render();
      expect(main(f).textContent).toContain("Claude didn't start");
      main(f).click();
      f.detectChanges();
      expect(f.nativeElement.textContent).toContain('hit its weekly limit - it resets Oct 20, 5pm');
      button(f, 'Try again').click();
      expect(send).toHaveBeenCalledWith('START', jasmine.objectContaining({ args: { cliSessionId: 'x' } }));
    });

    it("🔒 <name>'s Claude on a board someone else holds", () => {
      state.holders.set([{ boardId: 'b1', project: 'odeysys', user: 'ahmed@x.ae', machine: 'DEV', sessionId: 'x', since: '', commenters: [], request: null } as Holder]);
      const f = render();
      expect(main(f).textContent).toContain("🔒 ahmed's Claude");
      main(f).click();
      f.detectChanges();
      expect(f.nativeElement.textContent).toContain('Ask them to hand it over');
    });

    it('Claude on <PC> when the session lives on another PC', () => {
      state.sessions.set([{ ...SESSION, machine: 'LAPTOP-2', helperKeyId: 'h2' }]);
      const f = render();
      expect(main(f).textContent).toContain('Claude on LAPTOP-2');
      main(f).click();
      f.detectChanges();
      expect(f.nativeElement.textContent).toContain('Claude for this board runs on LAPTOP-2');
    });

    it('● Claude on · terminal when a terminal /alfred-live answers, with how to stop it', () => {
      const f = render({ terminalOn: true });
      expect(main(f).textContent).toContain('● Claude on · terminal');
      main(f).click();
      f.detectChanges();
      expect(f.nativeElement.textContent).toContain('/alfred-live stop');
      expect(button(f, 'Start Claude here')).toBeTruthy();
    });

    it('a session of another Windows user on this same PC is elsewhere', () => {
      state.helpers.set([{ ...HELPER, osUser: 'work' }, { ...HELPER, keyId: 'h2', osUser: 'OMEN' }]);
      state.sessions.set([{ ...SESSION, helperKeyId: 'h2' }]);
      expect(main(render()).textContent).toContain('Claude on WORK-PC');
    });

    it('a session that never started (gone) offers a fresh start', () => {
      state.sessions.set([{ ...SESSION, state: 'GONE' }]);
      expect(main(render()).textContent).toContain('▶ Start Claude');
    });
  });

  describe('panel', () => {
    it('start view asks where the code is - and why - when the PC has no folder (T052)', () => {
      const send = spyOn(state, 'send').and.returnValue(of({ id: 'c1' } as HelperCommand));
      state.settings.set({});
      const f = render();
      main(f).click();
      f.detectChanges();
      expect(send).not.toHaveBeenCalled();
      const text = f.nativeElement.textContent;
      expect(text).toContain("Where is odeysys's code on WORK-PC?");
      expect(text).toContain('Asked once and kept in My settings');
      expect([...f.nativeElement.querySelectorAll('.pill')].map((p: Element) => p.textContent?.trim())).toEqual(['Claude Desktop', 'Terminal', 'Both', 'Nowhere - board only']);
      button(f, 'Browse').click();
      f.detectChanges();
      expect(send).toHaveBeenCalledWith('PICK_FOLDER', jasmine.objectContaining({ project: 'odeysys' }));
      expect(f.nativeElement.textContent).toContain('Look for it on the taskbar');
    });

    it('an unpaired browser is asked to connect this PC, not for a folder', () => {
      state.me.set({ ...ME, user: null });
      state.helpers.set([]);
      const f = render();
      (f.nativeElement.querySelector('.cm') as HTMLButtonElement).click();
      f.detectChanges();
      expect(f.nativeElement.textContent).toContain('Connect this PC first');
      expect(f.nativeElement.textContent).not.toContain("Where is odeysys's code");
    });

    it('asks for a folder when only another Windows user on this PC has one', () => {
      const send = spyOn(state, 'send').and.returnValue(of(null));
      state.helpers.set([{ ...HELPER, osUser: 'work' }]);
      state.settings.set({ projects: [{ project: 'odeysys', machine: 'WORK-PC', osUser: 'OMEN', folder: 'C:/Users/OMEN/o', openIn: 'DESKTOP', worktrees: true }] });
      const f = render();
      main(f).click();
      f.detectChanges();
      expect(send).not.toHaveBeenCalled();
      expect(f.nativeElement.textContent).toContain("Where is odeysys's code on WORK-PC?");
    });

    it('on view: Pause and Hand back on top, the groups, no Sync (T053)', () => {
      state.sessions.set([SESSION, { ...SESSION, id: 's2', current: false }]);
      const f = render();
      main(f).click();
      f.detectChanges();
      const text = f.nativeElement.textContent;
      expect(f.nativeElement.querySelector('.quick')!.textContent).toContain('⏸ Pause Claude');
      expect(f.nativeElement.querySelector('.quick')!.textContent).toContain('↩ Hand the board back');
      for (const w of ['Claude is answering this board', 'Open in Claude Desktop', 'Open in a terminal', 'Watch a recording', 'Start fresh',
        'Earlier sessions', '2 on this board', 'Who did what', 'Copy session id', 'My settings']) expect(text).withContext(w).toContain(w);
      expect(text).not.toContain('Sync');
    });

    it('paused view offers Resume and catch up (T054)', () => {
      state.sessions.set([{ ...SESSION, state: 'STOPPED' }]);
      const f = render({ unread: 2 });
      (f.nativeElement.querySelector('.cm') as HTMLButtonElement).click();
      f.detectChanges();
      expect(f.nativeElement.textContent).toContain('Claude is paused');
      expect(f.nativeElement.textContent).toContain('Resume and catch up on 2 messages');
      expect(f.nativeElement.textContent).toContain('Read it in Claude Desktop');
    });

    it('stays open when the pointer leaves it; an outside click or Escape closes it (T058)', () => {
      state.sessions.set([SESSION]);
      const f = render();
      document.body.appendChild(f.nativeElement);
      main(f).click();
      f.detectChanges();
      f.nativeElement.querySelector('.panel')!.dispatchEvent(new MouseEvent('mouseleave'));
      f.detectChanges();
      expect(f.nativeElement.querySelector('.panel')).not.toBeNull();
      document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
      f.detectChanges();
      expect(f.nativeElement.querySelector('.panel')).toBeNull();
      main(f).click();
      f.detectChanges();
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
      f.detectChanges();
      expect(f.nativeElement.querySelector('.panel')).toBeNull();
      f.nativeElement.remove();
    });
  });

  describe('Pause (T056)', () => {
    it('says Pausing… at once, waits for a slow PC, then says paused with Resume now', fakeAsync(() => {
      state.sessions.set([SESSION]);
      spyOn(state, 'send').and.callFake(() => { state.commands.set([cmd('STOP', 'TAKEN')]); return of(cmd('STOP', 'TAKEN')); });
      const f = render();
      main(f).click();
      f.detectChanges();
      button(f, 'Pause Claude').click();
      f.detectChanges();
      expect(main(f).textContent).toContain('Pausing…');
      tick(PAUSE_SLOW_MS);
      expect(banner.current()!.text).toBe('Waiting for your PC to pause Claude');

      state.commands.set([cmd('STOP', 'DONE')]);
      state.sessions.set([{ ...SESSION, state: 'STOPPED' }]);
      state.finished$.next(cmd('STOP', 'DONE'));
      f.detectChanges();
      expect(banner.current()!.text).toBe('Claude is paused');
      expect(banner.current()!.action).toBe('Resume now');
      expect(main(f).textContent).toContain('▶ Resume Claude');
    }));

    it('with the PC offline: says it could not pause, stays Claude on, and offers Hand back instead', () => {
      state.helpers.set([{ ...HELPER, online: false }]);
      state.sessions.set([SESSION]);
      spyOn(state, 'send').and.callFake(() => { state.commands.set([cmd('STOP', 'QUEUED')]); return of(cmd('STOP', 'QUEUED')); });
      const f = render();
      main(f).click();
      f.detectChanges();
      button(f, 'Pause Claude').click();
      f.detectChanges();
      expect(banner.current()!.text).toBe("Couldn't pause Claude");
      expect(banner.current()!.detail).toContain('Your PC (WORK-PC) is not connected');
      expect(banner.current()!.action).toBe('Hand back instead');
      expect(main(f).textContent).toContain('● Claude on');
    });
  });

  describe('Hand back (T057)', () => {
    it('asks, then sends RELEASE with the note and says it was handed back', () => {
      state.sessions.set([SESSION]);
      const send = spyOn(state, 'send').and.returnValue(of(cmd('RELEASE', 'QUEUED')));
      const f = render();
      main(f).click();
      f.detectChanges();
      button(f, 'Hand the board back').click();
      f.detectChanges();
      expect(f.nativeElement.textContent).toContain('Hand AB#1 back?');
      expect(f.nativeElement.textContent).toContain('Leave a note for whoever continues');
      button(f, '↩ Hand back').click();
      expect(send).toHaveBeenCalledWith('RELEASE', jasmine.objectContaining({ args: jasmine.objectContaining({ note: true, boardRef: 'AB#1' }) }));

      state.finished$.next(cmd('RELEASE', 'DONE', 'Handed back - left a Handover note card; Claude stopped; the session is kept.'));
      expect(banner.current()!.text).toBe('You handed the board back');
      expect(banner.current()!.detail).toContain('(and it left a Handover note)');
      expect(banner.current()!.action).toBe('Take it again');
    });

    it('with the PC offline: releases through Alfred directly and says there is no note', () => {
      state.helpers.set([{ ...HELPER, online: false }]);
      state.sessions.set([SESSION]);
      const send = spyOn(state, 'send');
      const f = render();
      f.componentInstance.askHandBack();
      f.detectChanges();
      expect(f.nativeElement.textContent).not.toContain('Leave a note');
      button(f, '↩ Hand back').click();
      const http = TestBed.inject(HttpTestingController);
      http.expectOne((r) => r.url.endsWith('/board/holders/release')).flush({});
      expect(send).not.toHaveBeenCalled();
      expect(banner.current()!.detail).toBe('Handed back without a note - your PC is offline');
    });

    it('says why it failed instead of nothing', () => {
      state.sessions.set([]);
      const f = render();
      f.componentInstance.handBack();
      TestBed.inject(HttpTestingController).expectOne((r) => r.url.endsWith('/board/holders/release'))
        .flush({ message: 'Nobody holds this board any more - it was handed back already' }, { status: 404, statusText: 'Not Found' });
      expect(banner.current()!.tone).toBe('error');
      expect(banner.current()!.detail).toBe('Nobody holds this board any more - it was handed back already');
    });
  });

  describe('connecting', () => {
    it('asks a browser on a PC that is not connected to connect it, then goes on by itself', () => {
      const send = spyOn(state, 'send').and.returnValue(of(null));
      state.me.set({ ...ME, user: null });
      state.helpers.set([]);
      const f = render();
      main(f).click();
      f.detectChanges();
      expect(f.nativeElement.textContent).toContain('Connect this PC to use your Claude');
      expect(send).not.toHaveBeenCalled();

      state.me.set(ME);
      state.helpers.set([HELPER]);
      f.detectChanges();
      expect(send).toHaveBeenCalledWith('START', jasmine.objectContaining({ boardId: 'b1' }));
      expect(f.nativeElement.textContent).not.toContain('Connect this PC to use your Claude');
    });

    it('starts Claude and runs the Next card\'s step after it', () => {
      const send = spyOn(state, 'send').and.returnValue(of(null));
      const f = render();
      f.componentInstance.runAfterStart({ command: '/alfred-setup AB#1', prompt: 'p' });
      expect(send).toHaveBeenCalledWith('START', jasmine.objectContaining({ args: jasmine.objectContaining({ thenRun: { command: '/alfred-setup AB#1', prompt: 'p' } }) }));
    });

    it('waits for the connect file it downloaded and collects its key on the signal', () => {
      state.me.set({ ...ME, user: null });
      state.connecting.set({ connectId: 'c1', collectSecret: 's', expiresAt: new Date(Date.now() + 60_000).toISOString(), fileName: 'alfred-connect.cmd',
        script: '', run: 'Double-click alfred-connect.cmd in your Downloads', versions: { helper: '', skills: '', node: true } });
      const f = render();
      main(f).click();
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

  it('a session Desktop has not loaded yet offers Restart Desktop instead of a page that cannot find it', () => {
    state.sessions.set([SESSION]);
    render();
    state.finished$.next(cmd('OPEN_DESKTOP', 'DONE', 'Claude Desktop reads new sessions only when it starts - restart Desktop to see this one (it opens there).'));
    expect(banner.current()!.text).toBe('Claude Desktop has not loaded this session yet');
    expect(banner.current()!.action).toBe('Restart Desktop');
  });

  it('uses none of the old words (T060)', () => {
    state.sessions.set([SESSION]);
    const f = render();
    main(f).click();
    f.detectChanges();
    const text = f.nativeElement.textContent as string;
    for (const old of ['▶ alfred-live', 'Live · session', 'Answer the board again', 'Stop answering', 'New session for this board', 'Switch session',
      'Sync with the board chat', 'Listen to a cycle', 'Release the board', 'Board audit', 'Restart Claude Desktop to show it']) {
      expect(text).withContext(old).not.toContain(old);
    }
  });
});
