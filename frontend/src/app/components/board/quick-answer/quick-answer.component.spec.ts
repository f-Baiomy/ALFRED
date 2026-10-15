import { TestBed } from '@angular/core/testing';
import { Subject, of } from 'rxjs';
import { ActivityEntry, BoardQuestion, BoardSocketEvent } from '../../../core/models/board.models';
import { BoardApiService } from '../../../core/services/board-api.service';
import { BoardSocketService } from '../../../core/services/board-socket.service';
import { QuickAnswerComponent } from './quick-answer.component';

function entry(id: number, text: string, actor: 'USER' | 'CLAUDE' = 'CLAUDE', replyTo: number | null = null): ActivityEntry {
  return { id, cardId: 'k', actor, kind: 'COMMENT', text, oldValue: null, newValue: null, at: '2026-10-11T00:00:00Z', replyTo };
}

function row(entryId: number, idx: number, header: string, state: BoardQuestion['state'] = 'OPEN', parentIdx: number | null = null,
  parentOption: string | null = null): BoardQuestion {
  return { entryId, cardId: 'k', idx, header, text: `${header}?`, state, laterUntil: null, answerEntry: null, parentIdx, parentOption, askedAt: '2026-10-11T00:00:00Z' };
}

const ASK = '**Question** Keep all the steps?\n\n```questions\n' + JSON.stringify({ questions: [
  { header: 'Steps', question: 'Keep all the steps?', why: 'The cycle replays them', options: [
    { label: 'Keep all', then: 'I record every step', recommended: true, preview: 'Covers **A1**' },
    { label: 'Rewrite', followUp: { header: 'Plan', question: 'Which plan?', options: [{ label: 'Short' }, { label: 'Long' }] } }] },
  { header: 'Checks', question: 'Which checks?', multiSelect: true, options: [{ label: 'SQL' }, { label: 'Status' }] },
] }) + '\n```';

describe('QuickAnswerComponent (the questions dialog, specs/019)', () => {
  let answers: jasmine.Spy;
  let rows: BoardQuestion[];
  let history: ActivityEntry[];
  let socket: Subject<BoardSocketEvent>;

  function create() {
    answers = jasmine.createSpy('answers').and.returnValue(of({ entries: [] }));
    socket = new Subject();
    TestBed.configureTestingModule({
      imports: [QuickAnswerComponent],
      providers: [
        { provide: BoardApiService, useValue: {
          card: () => of({ id: 'k', project: 'p', number: 44, title: 'Branches', cycleId: null }),
          activity: () => of({ entries: history, total: history.length }),
          questions: () => of(rows),
          answers,
        } },
        { provide: BoardSocketService, useValue: { events$: socket } },
      ],
    });
    const fixture = TestBed.createComponent(QuickAnswerComponent);
    fixture.componentRef.setInput('cardId', 'k');
    fixture.detectChanges();
    fixture.detectChanges();
    return fixture;
  }

  beforeEach(() => {
    history = [entry(5, ASK)];
    rows = [row(5, 0, 'Steps'), row(5, 1, 'Checks'), row(5, 2, 'Plan', 'PENDING', 0, 'Rewrite')];
  });

  it('shows a tab per open question and Review; options say what Claude will then do, one Recommended', () => {
    const fixture = create();
    const text = fixture.nativeElement.textContent;
    const tabs = Array.from(fixture.nativeElement.querySelectorAll('.board-qa-tab')).map((t) => (t as HTMLElement).textContent?.trim());
    expect(tabs).toEqual(['Steps', 'Checks', 'Review']);
    expect(text).toContain('Claude asks 2 questions');
    expect(text).toContain('Then I will: I record every step');
    expect(text).toContain('Recommended');
    expect(text).toContain('Why I ask:');
  });

  it('a follow-up shows at once when its option is picked, and goes again when the answer changes', () => {
    const fixture = create();
    const c = fixture.componentInstance;
    const steps = c.visible()[0];
    c.pick(steps, 'Rewrite');
    fixture.detectChanges();
    expect(c.visible().map((q) => q.ask.header)).toEqual(['Steps', 'Checks', 'Plan']);
    c.pick(steps, 'Keep all');
    expect(c.visible().map((q) => q.ask.header)).toEqual(['Steps', 'Checks']);
  });

  it('hovering an option shows its preview', () => {
    const fixture = create();
    fixture.componentInstance.hover.set(0);
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.board-qa-preview').textContent).toContain('A1');
    expect(fixture.nativeElement.querySelector('.board-qa-pvt').textContent).toContain('if you pick 1');
  });

  it('sends only the answered questions in one batch - the rest stay open', () => {
    const fixture = create();
    const c = fixture.componentInstance;
    c.pick(c.visible()[0], 'Rewrite');
    c.pick(c.visible()[2], 'Short');
    c.setNote(c.visible()[2], 'only the first branch');
    fixture.detectChanges();
    expect(c.sendLabel()).toBe('Send 2 of 3 answers');
    c.send();
    expect(answers).toHaveBeenCalledWith('k', [{ entry: 5, answers: {
      Steps: { chose: ['Rewrite'] }, Plan: { chose: ['Short'], note: 'only the first branch' } } }], true);
  });

  it('multi-select takes several options; Something else keeps them; Decide later sends a time', () => {
    const fixture = create();
    const c = fixture.componentInstance;
    const checks = c.visible()[1];
    c.pick(checks, 'SQL');
    c.pick(checks, 'Status');
    c.setOther(checks, 'and no ERROR line');
    c.toggleLater(c.visible()[0]);
    c.send();
    const sent = answers.calls.mostRecent().args[1][0].answers;
    expect(sent.Checks).toEqual({ chose: ['SQL', 'Status'], other: 'and no ERROR line' });
    expect(Date.parse(sent.Steps.later)).toBeGreaterThan(Date.now());
  });

  it('a question Claude asks after the send arrives live, marked new', () => {
    const fixture = create();
    const c = fixture.componentInstance;
    history = [...history, entry(9, '**Question** Which dates?\n\n```questions\n' + JSON.stringify({ because: { entry: 8, header: 'Steps' },
      questions: [{ header: 'Dates', question: 'Which dates?', options: [{ label: 'Today' }, { label: 'Week' }] }] }) + '\n```')];
    rows = [...rows, row(9, 0, 'Dates')];
    socket.next({ type: 'board-changed', cardId: 'k', what: 'activity' });
    fixture.detectChanges();
    const dates = c.visible().find((q) => q.ask.header === 'Dates')!;
    expect(c.isNew(dates)).toBeTrue();
    expect(c.becauseText(dates)).toBe('your answer to Steps');
  });

  it('a plain question (no options) is answered in words', () => {
    history = [entry(3, '**Question** Name the branch?')];
    rows = [row(3, 0, 'Question')];
    const fixture = create();
    const c = fixture.componentInstance;
    expect(fixture.nativeElement.textContent).toContain('Name the branch?');
    c.setOther(c.visible()[0], 'Dubai');
    c.send();
    expect(answers).toHaveBeenCalledWith('k', [{ entry: 3, answers: { Question: { chose: [], other: 'Dubai' } } }], true);
  });
});
