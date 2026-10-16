import { TestBed } from '@angular/core/testing';
import { of, throwError } from 'rxjs';
import { ChatMessage } from '../../../core/models/chat.models';
import { ChatApiService } from '../../../core/services/chat-api.service';
import { ChatStateService } from '../../../core/state/chat-state.service';
import { ChatProposalsComponent } from './chat-proposals.component';

function answer(extra: Record<string, unknown>): ChatMessage {
  return { id: 5, project: 'p', scope: 'c1', parentId: null, author: 'CLAUDE', kind: 'TEXT', text: 'I propose', state: 'DONE', urgent: false,
    decision: false, origin: null, context: [], quote: null, extra, reactions: {}, coversTo: null, replyTo: 4, bridgeFrom: null,
    superseded: false, createdAt: '2026-10-15T10:00:00Z', editedAt: null } as ChatMessage;
}

/** specs/022 FR-026/FR-046: a stale proposal cannot be accepted; accepting offers Undo. */
describe('ChatProposalsComponent', () => {
  let api: jasmine.SpyObj<ChatApiService>;

  beforeEach(() => {
    api = jasmine.createSpyObj<ChatApiService>('ChatApiService', ['checkProposals', 'proposals', 'undo', 'undoProposal']);
    api.checkProposals.and.returnValue(of({ checks: { a: null, b: 'outdated: #7 is closed' } }));
    api.proposals.and.returnValue(of({ results: { a: 'applied' }, undoToken: 'tok' }));
    TestBed.configureTestingModule({
      imports: [ChatProposalsComponent],
      providers: [{ provide: ChatApiService, useValue: api }, { provide: ChatStateService, useValue: { changedLocally: () => undefined } }],
    });
  });

  function render(extra: Record<string, unknown>) {
    const f = TestBed.createComponent(ChatProposalsComponent);
    f.componentRef.setInput('message', answer(extra));
    f.detectChanges(); // the check runs in an effect
    f.detectChanges(); // and its answer is drawn
    return f;
  }

  it('checks the board when shown and offers Accept only where it still applies', () => {
    const f = render({ proposals: [{ id: 'a', text: 'verify #3' }, { id: 'b', text: 'move #7 to To do' }, { id: 'c', text: 'done', state: 'applied' }] });
    const el: HTMLElement = f.nativeElement;
    expect(api.checkProposals).toHaveBeenCalledWith(5);
    const rows = Array.from(el.querySelectorAll('.chat-prop'));
    expect(rows[0].textContent).toContain('Accept');
    expect(rows[1].textContent).toContain('outdated: #7 is closed');
    expect(rows[1].textContent).not.toContain('Accept');
    expect(rows[2].textContent).toContain('applied');
    expect(el.textContent).not.toContain('Accept all'); // one open proposal left
  });

  it('accepts one and offers Undo for it', () => {
    const f = render({ proposals: [{ id: 'a', text: 'verify #3' }] });
    const el: HTMLElement = f.nativeElement;
    (Array.from(el.querySelectorAll('button')).find((b) => b.textContent?.trim() === 'Accept') as HTMLButtonElement).click();
    f.detectChanges();
    expect(api.proposals).toHaveBeenCalledWith(5, ['a'], []);
    const undo = Array.from(el.querySelectorAll('.board-toast button')).find((b) => b.textContent?.includes('Undo')) as HTMLButtonElement;
    expect(undo).toBeTruthy();
    api.undo.and.returnValue(of(undefined));
    undo.click();
    expect(api.undo).toHaveBeenCalledWith('tok');
  });

  it('keeps Undo on an applied proposal after the toast is gone, and says why when the board moved on', () => {
    const f = render({ proposals: [{ id: 'c', text: 'Close #51 as Fine', state: 'applied' }] });
    const el: HTMLElement = f.nativeElement;
    const undo = () => Array.from(el.querySelectorAll('.chat-prop button')).find((b) => b.textContent?.trim() === 'Undo') as HTMLButtonElement;
    expect(undo()).toBeTruthy();
    api.undoProposal.and.returnValue(throwError(() => ({ error: { message: '#51 changed since (it is in progress now) - change it on the board' } })));
    undo().click();
    f.detectChanges();
    expect(api.undoProposal).toHaveBeenCalledWith(5, 'c');
    expect(el.querySelector('.board-error')?.textContent).toContain('changed since');
  });
});
