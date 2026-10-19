import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { provideRouter } from '@angular/router';
import { NEVER } from 'rxjs';
import { ChatMessage } from '../../../core/models/chat.models';
import { BoardSocketService } from '../../../core/services/board-socket.service';
import { ChatStateService } from '../../../core/state/chat-state.service';
import { ChatPanelComponent } from './chat-panel.component';

function msg(id: number, over: Partial<ChatMessage> = {}): ChatMessage {
  return { id, project: 'p', scope: 'c1', parentId: null, author: 'USER', kind: 'TEXT', state: 'ANSWERED', urgent: false,
    text: 'Why does the search with two branches return the rows of only one of them? The request sends branchId: 948 only.',
    decision: false, origin: 'typed', context: [], quote: null, extra: null, reactions: {}, coversTo: null, replyTo: null, bridgeFrom: null,
    superseded: false, createdAt: '2026-10-15T10:00:00Z', editedAt: null, ...over };
}

/** The narrow layout found in the mock review (specs/022 T054): at 466 px nothing spills out of the panel. */
describe('ChatPanelComponent - narrow dock', () => {
  beforeEach(() => {
    TestBed.configureTestingModule({
      imports: [ChatPanelComponent],
      providers: [provideHttpClient(), provideHttpClientTesting(), provideRouter([]),
        { provide: BoardSocketService, useValue: { events$: NEVER, reconnected$: NEVER } }],
    });
  });

  function render() {
    const state = TestBed.inject(ChatStateService);
    state.project.set('p');
    state.prefs.update((p) => ({ ...p, view: 'docked', width: 466 }));
    state.summaries.set([{ scope: 'c1', name: 'c1', kind: 'cycle', lastId: 2, lastAt: null, lastPreview: '', lastAuthor: 'CLAUDE', waiting: 0,
      typing: false, needsYou: { questions: 0, proposals: 0, confirms: 0 }, claudeOn: true, terminal: null }]);
    state.threads.set(new Map([['c1', { scope: 'c1', more: false, messages: [msg(1),
      msg(2, { author: 'CLAUDE', state: 'DONE', replyTo: 1, text: 'The **branch filter** keeps the first id only - `BranchFilter.java:42`.' })] }]]));
    state.openScope.set('c1');
    const f = TestBed.createComponent(ChatPanelComponent);
    document.body.appendChild(f.nativeElement);
    f.detectChanges();
    return f;
  }

  function inside(inner: Element, outer: Element): boolean {
    const a = inner.getBoundingClientRect();
    const b = outer.getBoundingClientRect();
    return a.left >= b.left - 0.5 && a.right <= b.right + 0.5;
  }

  it('keeps the Send button inside the panel', () => {
    const f = render();
    const dock: HTMLElement = f.nativeElement.querySelector('.chat-dock');
    // the chosen width, or under 900 px the window's width less its margins - never wider than the window
    expect(dock.getBoundingClientRect().width).toBeLessThanOrEqual(innerWidth);
    const send = dock.querySelector('.chat-composer .board-editor-send');
    expect(send).withContext('Send button').toBeTruthy();
    expect(inside(send!, dock)).withContext('Send inside the panel').toBeTrue();
    f.nativeElement.remove();
  });

  it('keeps the hover bar inside its message', () => {
    const f = render();
    const dock: HTMLElement = f.nativeElement.querySelector('.chat-dock');
    const messages = Array.from(dock.querySelectorAll('.chat-msg'));
    expect(messages.length).toBe(2);
    for (const m of messages) {
      const hover = m.querySelector('.chat-hover') as HTMLElement | null;
      expect(hover).toBeTruthy();
      hover!.style.opacity = '1'; // what :hover does
      hover!.style.visibility = 'visible';
      expect(hover!.querySelectorAll(':scope > button').length).withContext('a small bar: reply, two reactions, more').toBeLessThanOrEqual(4);
      for (const b of Array.from(hover!.querySelectorAll('button'))) expect(inside(b, m)).withContext(`${b.textContent} inside the message`).toBeTrue();
    }
    f.nativeElement.remove();
  });

  it('puts a message\'s actions on its name row, and its ⋯ menu stays until a click elsewhere', () => {
    const f = render();
    const m: HTMLElement = f.nativeElement.querySelector('.chat-msg');
    const hover = m.querySelector('.chat-hover') as HTMLElement;
    expect(hover.parentElement?.classList).withContext('on the name/time row, not over the text').toContain('board-ev-who');
    (hover.querySelector('.more') as HTMLElement).click();
    f.detectChanges();
    hover.dispatchEvent(new MouseEvent('mouseleave'));
    f.detectChanges();
    expect(m.querySelector('.chat-hover-menu')).withContext('leaving the bar on the way to the menu').not.toBeNull();
    document.body.click();
    f.detectChanges();
    expect(m.querySelector('.chat-hover-menu')).toBeNull();
    f.nativeElement.remove();
  });
});

/** The chat in the rail: the stream scrolls inside the rail's height, and the search outlines what it found. */
describe('ChatPanelComponent - in the rail', () => {
  beforeEach(() => {
    TestBed.configureTestingModule({
      imports: [ChatPanelComponent],
      providers: [provideHttpClient(), provideHttpClientTesting(), provideRouter([]),
        { provide: BoardSocketService, useValue: { events$: NEVER, reconnected$: NEVER } }],
    });
  });

  function render(count: number) {
    const state = TestBed.inject(ChatStateService);
    state.project.set('p');
    state.prefs.update((p) => ({ ...p, view: 'docked', width: 440 }));
    state.summaries.set([{ scope: 'c1', name: 'c1', kind: 'cycle', lastId: count, lastAt: null, lastPreview: '', lastAuthor: 'CLAUDE', waiting: 0,
      typing: false, needsYou: { questions: 0, proposals: 0, confirms: 0 }, claudeOn: true, terminal: null }]);
    state.threads.set(new Map([['c1', { scope: 'c1', more: false, messages: Array.from({ length: count }, (_, i) => msg(i + 1)) }]]));
    state.openScope.set('c1');
    const rail = document.createElement('div');
    rail.className = 'chat-rail';
    rail.style.cssText = 'position: fixed; top: 0; left: 0; height: 500px; bottom: auto;';
    document.body.appendChild(rail);
    const f = TestBed.createComponent(ChatPanelComponent);
    // TestBed's host is a plain div: give it what the real <app-chat-panel> host gets from styles.scss
    (f.nativeElement as HTMLElement).style.display = 'contents';
    rail.appendChild(f.nativeElement);
    f.detectChanges();
    return { f, rail };
  }

  it('fills the rail and scrolls its messages instead of growing with them', () => {
    const host = document.createElement('app-chat-panel');
    document.body.appendChild(host);
    expect(getComputedStyle(host).display).withContext('the real host adds no box').toBe('contents');
    host.remove();
    const { rail } = render(40);
    const dock = rail.querySelector('.chat-dock') as HTMLElement;
    const stream = rail.querySelector('.chat-stream') as HTMLElement;
    // the rail's height (or, narrower than 900 px, the window under the nav) - never the height of 40 messages
    expect(dock.getBoundingClientRect().height).toBeLessThanOrEqual(Math.max(500, innerHeight));
    expect(dock.getBoundingClientRect().height).toBeLessThan(stream.scrollHeight);
    expect(stream.scrollHeight).toBeGreaterThan(stream.clientHeight);
    expect(getComputedStyle(stream).overflowY).toBe('auto');
    rail.remove();
  });

  it('outlines the messages the search found', () => {
    const { f, rail } = render(3);
    f.componentInstance.hits.set([{ id: 2, folded: false }]);
    f.detectChanges();
    const found = Array.from(rail.querySelectorAll('.chat-msg.hit')).map((e) => e.getAttribute('data-chat-id'));
    expect(found).toEqual(['2']);
    rail.remove();
  });
});

/** The redesign: one header row, the composer as one box with its tools inside, the formatting behind "Aa". */
describe('ChatPanelComponent - the window', () => {
  beforeEach(() => {
    TestBed.configureTestingModule({
      imports: [ChatPanelComponent],
      providers: [provideHttpClient(), provideHttpClientTesting(), provideRouter([]),
        { provide: BoardSocketService, useValue: { events$: NEVER, reconnected$: NEVER } }],
    });
  });

  function render(over: Record<string, unknown> = {}) {
    const state = TestBed.inject(ChatStateService);
    state.project.set('p');
    state.summaries.set([{ scope: 'c1', name: 'c1', kind: 'cycle', lastId: 1, lastAt: null, lastPreview: '', lastAuthor: 'USER', waiting: 1,
      typing: false, needsYou: { questions: 0, proposals: 0, confirms: 0 }, claudeOn: true, terminal: null, ...over } as any]);
    state.threads.set(new Map([['c1', { scope: 'c1', more: false, messages: [msg(1, { state: 'WAITING' })] }]]));
    state.openScope.set('c1');
    const f = TestBed.createComponent(ChatPanelComponent);
    document.body.appendChild(f.nativeElement);
    f.detectChanges();
    return f;
  }

  it('says who answers in one header row and keeps the rest in the ⋯ menu', () => {
    const f = render();
    const head: HTMLElement = f.nativeElement.querySelector('.chat-head');
    expect(head.querySelector('.chat-who small')?.textContent).toContain("Answered by the board's session");
    expect(head.querySelector('.chat-who small')?.textContent).toContain('1 waiting');
    expect(f.nativeElement.querySelector('.chat-menu')).toBeNull();
    (head.querySelector('.chat-icon[aria-label="More"]') as HTMLElement).click();
    f.detectChanges();
    const menu = f.nativeElement.querySelector('.chat-menu')?.textContent ?? '';
    expect(menu).toContain('Compact now');
    expect(menu).not.toContain('Full screen');
    f.nativeElement.remove();
  });

  it("a board chat its session answers says so, and offers no copy to catch up or continue (2026-10-19)", () => {
    const terminal = { open: true, forkAt: null, seenUpTo: null, terminalAt: '2026-10-16T10:00:00Z', host: 'pc', chatSessionId: 't1', forkedFrom: 't1',
      answeredByTerminal: true };
    const f = render({ terminal });
    const head: HTMLElement = f.nativeElement.querySelector('.chat-head');
    expect(head.querySelector('.chat-who small')?.textContent).toContain("Answered by the board's session");
    (head.querySelector('.chat-icon[aria-label="More"]') as HTMLElement).click();
    f.detectChanges();
    const menu = f.nativeElement.querySelector('.chat-menu')?.textContent ?? '';
    expect(menu).not.toContain('Catch up with the terminal');
    expect(menu).not.toContain('Continue in a terminal');
    f.nativeElement.remove();
  });

  it('a board chat whose session does not listen says the messages wait and what to send there - never a copy (2026-10-19)', () => {
    const f = render({ claudeOn: false });
    const small = f.nativeElement.querySelector('.chat-who small')?.textContent ?? '';
    expect(small).toContain('Not listening - messages wait');
    expect(small).toContain('/alfred-live p c1');
    expect(small).toContain("the board's session");
    expect(f.nativeElement.querySelector('.chat-copy-cmd')).not.toBeNull();
    (f.nativeElement.querySelector('.chat-menu') as HTMLElement | null)?.remove();
    f.nativeElement.remove();
  });

  it('switches the view from the header: expand, full screen and back with the same button', () => {
    const f = render();
    const state = TestBed.inject(ChatStateService);
    const modes = () => Array.from(f.nativeElement.querySelectorAll('.chat-modes .chat-icon') as NodeListOf<HTMLElement>);
    expect(modes().map((b) => b.getAttribute('aria-label'))).toEqual(['Expanded', 'Full screen', 'Separate window']);
    modes()[0].click();
    f.detectChanges();
    expect(state.view()).toBe('expanded');
    expect(modes()[0].classList).toContain('on');
    modes()[1].click();
    f.detectChanges();
    expect(state.view()).toBe('full');
    modes()[1].click();
    f.detectChanges();
    expect(state.view()).toBe('docked');
    f.nativeElement.remove();
  });

  it('shows the formatting toolbar only after Aa, and folds the chat to a tab with –', () => {
    const f = render();
    const state = TestBed.inject(ChatStateService);
    expect(f.nativeElement.querySelector('.chat-composer .board-editor-tb')).toBeNull();
    (Array.from(f.nativeElement.querySelectorAll('.board-editor-cbtn') as NodeListOf<HTMLElement>).find((b) => b.textContent?.trim() === 'Aa')!).click();
    f.detectChanges();
    expect(f.nativeElement.querySelector('.chat-composer .board-editor-tb')).not.toBeNull();
    (f.nativeElement.querySelector('.chat-head .chat-icon[aria-label="Minimize"]') as HTMLElement).click();
    expect(state.openScope()).toBeNull();
    expect(state.tabs()).toEqual(['c1']);
    f.nativeElement.remove();
  });
});
