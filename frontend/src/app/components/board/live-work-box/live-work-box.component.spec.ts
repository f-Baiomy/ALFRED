import { TestBed } from '@angular/core/testing';
import { Subject, of } from 'rxjs';
import { BoardSocketEvent, LiveWork } from '../../../core/models/board.models';
import { BoardApiService } from '../../../core/services/board-api.service';
import { BoardSocketService } from '../../../core/services/board-socket.service';
import { LiveWorkStateService, currentStep, liveDuration } from '../../../core/state/live-work-state.service';
import { LiveWorkBoxComponent } from './live-work-box.component';

function work(over: Partial<LiveWork> = {}): LiveWork {
  return {
    id: 'r1', project: 'p', cardNumber: 12, head: 'acting on your answer', steps: ['reading your answer', 'checking call #3'], draft: null,
    state: 'WORKING', outcome: null, stop: false, startedAt: new Date(Date.now() - 4000).toISOString(), updatedAt: new Date().toISOString(), ...over,
  };
}

describe('LiveWorkBoxComponent', () => {
  let events: Subject<BoardSocketEvent>;
  let api: jasmine.SpyObj<BoardApiService>;

  beforeEach(() => {
    events = new Subject();
    api = jasmine.createSpyObj<BoardApiService>('BoardApiService', ['liveWork', 'stopLiveWork']);
    api.liveWork.and.returnValue(of([]));
    api.stopLiveWork.and.callFake((id: string) => of(work({ id, stop: true })));
    TestBed.configureTestingModule({
      imports: [LiveWorkBoxComponent],
      providers: [
        { provide: BoardApiService, useValue: api },
        { provide: BoardSocketService, useValue: { events$: events, reconnected$: new Subject<void>() } },
      ],
    });
  });

  function render(number = 12) {
    const f = TestBed.createComponent(LiveWorkBoxComponent);
    f.componentRef.setInput('project', 'p');
    f.componentRef.setInput('number', number);
    f.detectChanges();
    return f;
  }

  it('shows each step as it arrives, the reply typing in, and Stop', () => {
    const f = render();
    const el: HTMLElement = f.nativeElement;
    expect(el.textContent?.trim()).toBe('');
    events.next({ type: 'live-work', work: work() });
    f.detectChanges();
    expect(el.querySelector('.live-head')?.textContent).toContain('✦ Claude is acting on your answer');
    expect(Array.from(el.querySelectorAll('.live-step')).map((s) => s.textContent?.trim())).toEqual(['✓reading your answer', '›checking call #3']);

    events.next({ type: 'live-work', work: work({ steps: ['reading your answer', 'checking call #3', 'writing the reply'], draft: 'Got it - ' }) });
    f.detectChanges();
    expect(el.querySelector('.live-draft')?.textContent).toContain('Got it -');

    (el.querySelector('.live-head .board-link') as HTMLButtonElement).click();
    f.detectChanges();
    expect(api.stopLiveWork).toHaveBeenCalledWith('r1');
    expect(el.querySelector('.live-head .board-link')?.textContent?.trim()).toBe('stopping…');
  });

  it('in the chat shows one line - where Claude is - never the reply typing in', () => {
    const f = TestBed.createComponent(LiveWorkBoxComponent);
    f.componentRef.setInput('project', 'p');
    f.componentRef.setInput('chatMessageId', 77);
    f.componentRef.setInput('compact', true);
    f.detectChanges();
    const el: HTMLElement = f.nativeElement;
    events.next({ type: 'live-work', work: work({ cardNumber: 0, chatMessageId: 77, head: 'answering in the chat',
      steps: ['reading the card', 'reading the SQL', 'writing the reply'], draft: '**How the new filters work** ```html live <div class="card">' }) });
    f.detectChanges();
    expect(el.querySelector('.live-line .live-now')?.textContent?.trim()).toBe('Writing the reply…');
    expect(el.querySelector('.live-line .live-count')?.textContent).toContain('step 3');
    expect(el.querySelector('.live-draft')).toBeNull();
    expect(el.querySelector('.live-step')).toBeNull();
    expect(el.textContent).not.toContain('html live');
  });

  it('folds to one line once it ended, and only for its own card', () => {
    const f = render();
    events.next({ type: 'live-work', work: work({ state: 'DONE', outcome: '→ replied; turned #12 into a BUG',
      startedAt: new Date(Date.now() - 6000).toISOString(), updatedAt: new Date().toISOString() }) });
    events.next({ type: 'live-work', work: work({ id: 'other', cardNumber: 13 }) });
    f.detectChanges();
    const el: HTMLElement = f.nativeElement;
    expect(el.querySelector('.live-box')).toBeNull();
    expect(el.querySelector('.live-fold')?.textContent).toContain('✦ Claude · 6 s · 2 steps ▸');
    expect(el.textContent).toContain('→ replied; turned #12 into a BUG');
  });

  it('names the step the card shows and how long it took', () => {
    expect(currentStep(work())).toBe('checking call #3');
    expect(currentStep(work({ draft: 'x' }))).toBe('writing the reply');
    expect(currentStep(work({ steps: [] }))).toBe('reading the card');
    expect(liveDuration(work({ state: 'DONE', startedAt: '2026-10-13T09:00:00Z', updatedAt: '2026-10-13T09:01:04Z' }))).toBe('1 min 4 s');
    const state = TestBed.inject(LiveWorkStateService);
    state.put(work({ state: 'DONE', updatedAt: new Date(Date.now() - 11 * 60_000).toISOString() }));
    expect(state.forCard('p', 12)).toBeNull();
  });
});
