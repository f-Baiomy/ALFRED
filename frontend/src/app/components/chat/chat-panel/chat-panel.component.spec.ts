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
    expect(dock.getBoundingClientRect().width).toBeCloseTo(466, 0);
    const send = Array.from(dock.querySelectorAll('.chat-composer button')).find((b) => b.textContent?.includes('Send'));
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
      hover!.style.display = 'flex'; // what :hover does
      for (const b of Array.from(hover!.querySelectorAll('button'))) expect(inside(b, m)).withContext(`${b.textContent} inside the message`).toBeTrue();
    }
    f.nativeElement.remove();
  });
});
