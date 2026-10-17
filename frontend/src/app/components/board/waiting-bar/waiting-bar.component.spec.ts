import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { Subject, of } from 'rxjs';
import { ActivityEntry, BoardQuestion, BoardSocketEvent, CardSummary } from '../../../core/models/board.models';
import { BoardApiService } from '../../../core/services/board-api.service';
import { BoardSocketService } from '../../../core/services/board-socket.service';
import { waitingPill } from '../../../shared/utils/board-skills';
import { WaitingBarComponent } from './waiting-bar.component';

function entry(id: number, text: string, actor: 'USER' | 'CLAUDE' = 'CLAUDE', replyTo: number | null = null): ActivityEntry {
  return { id, cardId: 'k', actor, kind: 'COMMENT', text, oldValue: null, newValue: null, at: '2026-10-17T00:00:00Z', replyTo };
}

function row(entryId: number, header: string, state: BoardQuestion['state'] = 'OPEN'): BoardQuestion {
  return { entryId, cardId: 'k', idx: 0, header, text: `${header}?`, state, laterUntil: null, answerEntry: null, parentIdx: null, parentOption: null,
    askedAt: '2026-10-17T00:00:00Z' };
}

const ASK = '**Question** Close it as Not in this flow?\n\n```questions\n' + JSON.stringify({ questions: [
  { header: 'Triage', question: 'Close it as Not in this flow?', checked: 'Azure 61953 is Removed', options: [
    { label: 'To do', then: 'Move #75 to To do.' },
    { label: 'Not in this flow', then: 'Propose closing #75.', recommended: true, confidence: 'high' }] },
] }) + '\n```';

function card(over: Partial<CardSummary> = {}): CardSummary {
  return { id: 'k', project: 'odeysys', number: 75, title: 'Global support', kind: 'TASK', status: 'INBOX', flags: ['NEEDS_DECISION'],
    waiting: { who: 'USER', since: '2026-10-17T00:00:00Z', setBy: 'CLAUDE' }, openQuestions: 1, ...over } as CardSummary;
}

describe('WaitingBarComponent (the waiting pill opened)', () => {
  let answers: jasmine.Spy;
  let comment: jasmine.Spy;
  let rows: BoardQuestion[];
  let history: ActivityEntry[];

  function create(c: CardSummary = card()) {
    answers = jasmine.createSpy('answers').and.returnValue(of({ entries: [] }));
    comment = jasmine.createSpy('comment').and.returnValue(of({}));
    TestBed.configureTestingModule({
      imports: [WaitingBarComponent],
      providers: [
        provideHttpClient(), provideHttpClientTesting(),
        { provide: BoardApiService, useValue: {
          activity: () => of({ entries: history, total: history.length }),
          questions: () => of(rows),
          liveRunner: () => of(null),
          answers, comment,
        } },
        { provide: BoardSocketService, useValue: { events$: new Subject<BoardSocketEvent>() } },
      ],
    });
    const fixture = TestBed.createComponent(WaitingBarComponent);
    fixture.componentRef.setInput('card', c);
    fixture.componentRef.setInput('anchor', { top: 100, bottom: 120, left: 40 });
    fixture.detectChanges();
    fixture.detectChanges();
    return fixture;
  }

  function type(fixture: ReturnType<typeof create>, text: string) {
    const area = fixture.nativeElement.querySelector('textarea') as HTMLTextAreaElement;
    area.value = text;
    area.dispatchEvent(new Event('input'));
    fixture.detectChanges();
  }

  function button(fixture: ReturnType<typeof create>, label: string): HTMLButtonElement {
    return Array.from(fixture.nativeElement.querySelectorAll('button') as NodeListOf<HTMLButtonElement>).find((b) => b.textContent?.trim() === label)!;
  }

  beforeEach(() => {
    history = [entry(5, ASK), entry(6, 'why not To do?', 'USER', 5)];
    rows = [row(5, 'Triage')];
  });

  it('shows the question with the recommended option first, what was checked, and the thread', () => {
    const fixture = create();
    const opts = Array.from(fixture.nativeElement.querySelectorAll('.wbar-opt')).map((o) => (o as HTMLElement).querySelector('.wbar-ol')?.textContent?.trim());
    expect(opts[0]).toContain('Not in this flow');
    expect(opts[0]).toContain('recommended · high');
    expect(fixture.nativeElement.textContent).toContain('Azure 61953 is Removed');
    expect(fixture.nativeElement.textContent).toContain('why not To do?');
    expect(fixture.nativeElement.textContent).toContain('No Claude session is listening');
  });

  it('one click on an option answers the question', () => {
    const fixture = create();
    (fixture.nativeElement.querySelector('.wbar-opt') as HTMLButtonElement).click();
    expect(answers).toHaveBeenCalledWith('k', [{ entry: 5, answers: { Triage: { chose: ['Not in this flow'] } } }], true);
  });

  it('"Decide with this" answers in the user\'s words; "Ask first" asks back and keeps it open', () => {
    const fixture = create();
    type(fixture, 'keep it, QA logs support hours there');
    button(fixture, 'Decide with this').click();
    expect(answers).toHaveBeenCalledWith('k', [{ entry: 5, answers: { Triage: { chose: [], other: 'keep it, QA logs support hours there' } } }], true);

    type(fixture, 'what does Removed mean here?');
    button(fixture, 'Ask first').click();
    expect(comment).toHaveBeenCalledWith('k', 'what does Removed mean here?', 5, false, { keepOpen: true });
  });

  it('with no question, the comment hands the card to Claude and Claude\'s Next is shown', () => {
    rows = [];
    history = [entry(7, '**Did** looked\n\n**Found** a gap\n\n**Next** Tell me which branch to test on.')];
    const fixture = create(card({ status: 'TO_DO', openQuestions: 0, flags: [] }));
    expect(fixture.nativeElement.textContent).toContain('Tell me which branch to test on.');
    expect(button(fixture, 'Ask first')).toBeUndefined();
    type(fixture, 'test on develop');
    button(fixture, 'Decide with this').click();
    expect(comment).toHaveBeenCalledWith('k', 'test on develop', undefined, false, { waitingOn: 'CLAUDE' });
  });

  it('an Inbox card with no question offers the sort', () => {
    rows = [];
    history = [];
    const fixture = create(card({ openQuestions: 0 }));
    const acted: unknown[] = [];
    fixture.componentInstance.action.subscribe((a) => acted.push(a));
    button(fixture, '→ To do').click();
    expect(acted).toEqual([{ kind: 'move', status: 'TO_DO' }]);
  });
});

describe('waitingPill', () => {
  const now = Date.parse('2026-10-17T00:03:00Z');
  const since = '2026-10-17T00:00:00Z';
  it('says what the user is asked for', () => {
    expect(waitingPill({ waiting: { who: 'USER', since, setBy: 'CLAUDE' }, openQuestions: 2, proposal: null, status: 'INBOX' }, now)).toBe('waiting on you: 2 decisions · 3 min');
    expect(waitingPill({ waiting: { who: 'USER', since, setBy: 'CLAUDE' }, openQuestions: 0, proposal: null, status: 'INBOX' }, now)).toBe('waiting on you: sort it · 3 min');
    expect(waitingPill({ waiting: { who: 'USER', since, setBy: 'CLAUDE' }, openQuestions: 0, proposal: null, status: 'TO_DO' }, now)).toBe('waiting on you: your reply · 3 min');
    expect(waitingPill({ waiting: { who: 'CLAUDE', since, setBy: 'USER' }, openQuestions: 1, proposal: null, status: 'INBOX' }, now)).toBe('waiting on Claude: your question · 3 min');
    expect(waitingPill({ waiting: { who: 'NONE', since, setBy: 'USER' }, openQuestions: 0, proposal: null, status: 'DONE' }, now)).toBeNull();
  });
});
