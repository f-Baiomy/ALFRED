import { NO_SKILL_RUNS } from '../../../core/state/skill-runs-state.service';
import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { NEVER, of } from 'rxjs';
import { CardSummary, ChecklistFile, CycleBrief, TestStep } from '../../../core/models/board.models';
import { BoardApiService } from '../../../core/services/board-api.service';
import { BoardMentionsService } from '../../../core/services/board-mentions.service';
import { BoardSocketService } from '../../../core/services/board-socket.service';
import { TaskViewComponent } from './task-view.component';

const BRIEF: CycleBrief = {
  cycleId: 'cy', updatedAt: '2026-10-12T10:42:00Z', updatedBy: 'CLAUDE', hasPrevious: true,
  text: `Bookings keep every passenger and the confirmed fare.

## Task
- ODY-482, branch \`feature/ODY-482\`

## Description
When a customer books for two, only the first passenger reaches the airline.

## Scope
- OrderMapper

## Out of scope
- payment

## Test steps
1. Search DXB to LHR
2. Book for both passengers

## Data
- Jane Doe

## Decisions
- 2026-10-12 fare may change at confirm - show it`,
};

const FILES: ChecklistFile[] = [{
  fileName: 'spec.md', items: [
    { key: 'a', text: 'Search returns offers', mark: { cycleId: 'cy', fileName: 'spec.md', itemKey: 'a', mark: 'PASS', actor: 'USER', evidence: '', history: [], updatedAt: '' } },
    { key: 'b', text: 'The booking keeps every passenger', mark: null, cards: [{ project: 'p', number: 38, title: 'passengers dropped', status: 'TO_DO' }] },
    { key: 'c', text: 'The traveller sees a price change', mark: null, cards: [{ project: 'p', number: 45, title: 'price change', status: 'INBOX' }] },
  ],
}];

function card(number: number, kind: CardSummary['kind'], status: CardSummary['status'], title: string, extra: Partial<CardSummary> = {}): CardSummary {
  return {
    id: 'c' + number, project: 'p', number, kind, title, status, resolution: null, reason: null, flags: [], scope: 'NOT_DECIDED',
    author: 'CLAUDE', cycleId: 'cy', cycleDeleted: false, signature: null, createdAt: '', updatedAt: '', updatedBy: 'CLAUDE',
    commentCount: 0, similarClosed: null, description: '', ...extra,
  };
}

const CARDS = [
  card(38, 'BUG', 'TO_DO', 'passengers dropped'),
  card(45, 'TASK', 'INBOX', 'price change'),
  card(46, 'NOTE', 'INBOX', 'N+1 airports', { flags: ['RISK'] }),
  card(47, 'NOTE', 'INBOX', 'Not in the task: AgencyService credential lookup'),
  card(48, 'QUESTION', 'INBOX', 'May fare.total change?'),
];

const STEPS: TestStep[] = [
  { key: '1', text: 'Search DXB to LHR', state: 'SEEN', calls: 31, cardNumber: null, note: null },
  { key: '2', text: 'Book for both passengers', state: 'FAILED', calls: 2, cardNumber: 38, note: 'one passenger' },
];

describe('TaskViewComponent', () => {
  let api: jasmine.SpyObj<BoardApiService>;

  beforeEach(() => {
    api = jasmine.createSpyObj<BoardApiService>('BoardApiService',
      ['brief', 'checklist', 'requirements', 'cards', 'steps', 'sessionLog', 'specs', 'mark', 'acceptSuggestion', 'putBrief', 'restoreBrief']);
    api.brief.and.returnValue(of(BRIEF));
    api.checklist.and.returnValue(of(FILES));
    api.requirements.and.returnValue(of({ cycleId: 'cy', items: [], counts: {} }));
    api.cards.and.returnValue(of({ cards: CARDS, total: CARDS.length, counts: { open: 5, fixed: 0, done: 0 } }));
    api.steps.and.returnValue(of(STEPS));
    api.sessionLog.and.returnValue(of([{ id: 1, cycleId: 'cy', skill: 'alfred-review', did: 'checked 40 calls', found: '1 bug', next: 'fix #38', at: '2026-10-12T11:00:00Z' }]));
    api.specs.and.returnValue(of([]));
    TestBed.configureTestingModule({
      imports: [TaskViewComponent],
      providers: [
        NO_SKILL_RUNS,
        provideHttpClient(), provideHttpClientTesting(),
        { provide: BoardApiService, useValue: api },
        { provide: BoardSocketService, useValue: { events$: NEVER } },
      ],
    });
  });

  function render() {
    const f = TestBed.createComponent(TaskViewComponent);
    f.componentRef.setInput('cycleId', 'cy');
    f.componentRef.setInput('project', 'p');
    f.componentRef.setInput('cycleName', 'ODY-482 booking');
    f.detectChanges();
    f.detectChanges();
    return f;
  }

  it('shows the task, the verdict, requirements by state, notes and what needs the user', () => {
    const el: HTMLElement = render().nativeElement;
    const text = el.textContent ?? '';
    expect(el.querySelector('.task-title')?.textContent).toContain('Bookings keep every passenger and the confirmed fare.');
    expect(el.querySelector('.task-ticket')?.textContent).toBe('ODY-482');
    expect(el.querySelector('.task-ph.now')?.textContent).toBe('Verifying');
    expect(el.querySelector('.task-v-a')?.textContent).toContain('Not yet - 1 bug, 1 requirement missing');
    expect(Array.from(el.querySelectorAll('.task-req .task-dot')).map((d) => d.textContent)).toEqual(['BUG', 'MISSING']);
    expect(el.querySelector('.task-met summary')?.textContent).toContain('1 requirement met');
    expect(text).toContain('When a customer books for two');
    expect(text).toContain('fare may change at confirm - show it');
    expect(Array.from(el.querySelectorAll('.task-note')).map((n) => Array.from(n.children).map((c) => c.textContent?.trim()).join(' ')))
      .toEqual(['RISK N+1 airports #46', 'EXTRA AgencyService credential lookup #47']);
    expect(el.querySelector('.task-need')?.textContent).toContain('May fare.total change?');
    expect(text).toContain('/mcp__alfred__resume "ODY-482 booking"');
    expect(text).toContain('checked 40 calls');
    expect(el.querySelector('.task-data')?.textContent).toContain('Jane Doe');
  });

  it('a tile shows only its requirements; a card link opens the card', () => {
    const f = render();
    const el: HTMLElement = f.nativeElement;
    const opened = jasmine.createSpy('opened');
    f.componentInstance.cardOpened.subscribe(opened);
    (el.querySelector('.task-t-MISSING') as HTMLButtonElement).click();
    f.detectChanges();
    expect(Array.from(el.querySelectorAll('.task-req .task-dot')).map((d) => d.textContent)).toEqual(['MISSING']);
    expect(el.querySelector('.task-met')).toBeNull();
    (el.querySelector('.task-req-cards .board-link') as HTMLButtonElement).click();
    expect(TestBed.inject(BoardMentionsService).cardToOpen()).toEqual({ project: 'p', number: 45 });
    expect(opened).toHaveBeenCalled();
  });

  it('marks a requirement with the user\'s mark', () => {
    api.mark.and.returnValue(of(FILES[0].items[1]));
    const el: HTMLElement = render().nativeElement;
    const pass = Array.from(el.querySelectorAll('.task-req'))[0].querySelector('.task-req-acts .board-tog') as HTMLButtonElement;
    pass.click();
    expect(api.mark).toHaveBeenCalledWith('cy', 'spec.md', 'b', 'PASS', '');
  });
});
