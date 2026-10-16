import { NO_SKILL_RUNS } from '../../../core/state/skill-runs-state.service';
import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { NEVER, Subject, of } from 'rxjs';
import { BriefComment, CardSummary, ChecklistFile, CycleBrief, TestStep } from '../../../core/models/board.models';
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
    { key: 'd', text: 'The fare is shown', mark: null,
      suggestion: { cycleId: 'cy', fileName: 'spec.md', itemKey: 'd', mark: 'PASS', evidence: 'seen in the code', at: '' } },
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

const ASK: BriefComment = { id: 1, cycleId: 'cy', quote: 'OrderMapper', actor: 'CLAUDE', text: 'Only the mapper?', replyTo: null, asks: true,
  suggestFrom: null, suggestTo: null, createdAt: '2026-10-12T10:00:00Z', resolvedAt: null, resolvedBy: null };

describe('TaskViewComponent (specs/024)', () => {
  let api: jasmine.SpyObj<BoardApiService>;
  let events: Subject<unknown>;

  beforeEach(() => {
    for (const k of Object.keys(localStorage)) if (k.startsWith('alfred.task.')) localStorage.removeItem(k);
    api = jasmine.createSpyObj<BoardApiService>('BoardApiService',
      ['brief', 'briefComments', 'checklist', 'requirements', 'cards', 'steps', 'sessionLog', 'specs', 'mark', 'acceptSuggestion', 'putBrief', 'restoreBrief']);
    api.brief.and.returnValue(of(BRIEF));
    api.briefComments.and.returnValue(of([ASK]));
    api.checklist.and.returnValue(of(FILES));
    api.requirements.and.returnValue(of({ cycleId: 'cy', items: [], counts: {} }));
    api.cards.and.returnValue(of({ cards: CARDS, total: CARDS.length, counts: { open: 5, fixed: 0, done: 0 } }));
    api.steps.and.returnValue(of(STEPS));
    api.sessionLog.and.returnValue(of([
      { id: 2, cycleId: 'cy', skill: 'alfred-listen', did: 'listened to 12 calls', found: 'nothing new', next: 'test step 2', at: '2026-10-12T12:00:00Z' },
      { id: 1, cycleId: 'cy', skill: 'alfred-review', did: 'checked 40 calls', found: '1 bug', next: 'fix #38', at: '2026-10-12T11:00:00Z' },
    ]));
    api.specs.and.returnValue(of([{ name: 'spec.md', size: 120, uploadedAt: '2026-10-12T09:00:00Z' }]));
    events = new Subject();
    TestBed.configureTestingModule({
      imports: [TaskViewComponent],
      providers: [
        NO_SKILL_RUNS,
        provideHttpClient(), provideHttpClientTesting(),
        { provide: BoardApiService, useValue: api },
        { provide: BoardSocketService, useValue: { events$: events } },
      ],
    });
  });

  function render(editable = true) {
    const f = TestBed.createComponent(TaskViewComponent);
    f.componentRef.setInput('cycleId', 'cy');
    f.componentRef.setInput('project', 'p');
    f.componentRef.setInput('cycleName', 'ODY-482 booking');
    f.componentRef.setInput('editable', editable);
    f.detectChanges();
    f.detectChanges();
    return f;
  }

  function tab(el: HTMLElement, label: string): HTMLButtonElement {
    return Array.from(el.querySelectorAll('.tv-tab')).find((t) => t.textContent?.includes(label)) as HTMLButtonElement;
  }

  it('the header says the task, the next step, where it stands and the verdict with a bar', () => {
    const el: HTMLElement = render().nativeElement;
    expect(el.querySelector('.tv-title')?.textContent).toContain('Bookings keep every passenger and the confirmed fare.');
    expect(Array.from(el.querySelectorAll('.tv-chip')).map((c) => c.textContent?.trim())).toEqual(['ODY-482', 'feature/ODY-482']);
    expect(el.querySelector('.tv-stepper .now')?.textContent).toBe('Verifying');
    expect(el.querySelector('.tv-verdict')?.textContent).toContain('Not yet - 1 bug, 1 requirement missing');
    expect(Array.from(el.querySelectorAll('.tv-bar i')).map((i) => i.className)).toEqual(['tv-g-MET', 'tv-g-BUG', 'tv-g-MISSING', 'tv-g-DECIDE']);
    // a bug is open: the next step is fixing it
    expect(el.querySelector('.tv-next-l')?.textContent).toContain('Fix the bug');
    expect(el.querySelector('.tv-next .run-cmd')?.textContent).toBe('/alfred-fix "ODY-482 booking"');
  });

  it('Run ▾ lists every skill in plain words and Continue anywhere; a click outside closes it', () => {
    const f = render();
    const el: HTMLElement = f.nativeElement;
    (Array.from(el.querySelectorAll('.tv-menu > .tv-btn'))[0] as HTMLButtonElement).click();
    f.detectChanges();
    const items = Array.from(el.querySelectorAll('.tv-mi .tv-mi-t')).map((m) => m.firstChild?.textContent?.trim());
    expect(items).toEqual(['Check while I test', 'Review what was recorded', 'Write the requirements', 'Fix the bugs', 'Re-test the fixes',
      'Hand-over report', 'Continue anywhere']);
    expect(el.textContent).toContain('/alfred-resume "ODY-482 booking"');
    document.body.click();
    f.detectChanges();
    expect(el.querySelector('.tv-menu-pop')).toBeNull();
  });

  it('Needs you leads where each thing is dealt with', () => {
    const f = render();
    const el: HTMLElement = f.nativeElement;
    const needs = Array.from(el.querySelectorAll('.tv-it')).map((b) => b.textContent?.trim());
    expect(needs).toEqual(['✦ 1 suggestion to accept', '✗ 1 requirement failed', '💬 Claude asks about the brief',
      '#48 May fare.total change? - a question', '1 of 2 test steps not done']);
    (el.querySelectorAll('.tv-it')[0] as HTMLButtonElement).click();
    f.detectChanges();
    expect(Array.from(el.querySelectorAll('.tv-req .tv-st')).map((s) => s.textContent)).toEqual(['✦ CLAUDE SUGGESTS']);
    (el.querySelectorAll('.tv-it')[2] as HTMLButtonElement).click();
    f.detectChanges();
    expect(tab(el, 'Brief').classList).toContain('on');
    (el.querySelectorAll('.tv-it')[3] as HTMLButtonElement).click();
    expect(TestBed.inject(BoardMentionsService).cardToOpen()).toEqual({ project: 'p', number: 48 });
  });

  it('tabs carry their counts, the tab is remembered per cycle, and each tab has its guide until hidden', () => {
    const f = render();
    const el: HTMLElement = f.nativeElement;
    expect(Array.from(el.querySelectorAll('.tv-tab')).map((t) => [t.firstChild?.textContent?.trim(), t.querySelector('.tv-n')?.textContent ?? '']))
      .toEqual([['Requirements', '3 open'], ['Test plan', '1 / 2'], ['Brief', '💬 1'], ["Claude's runs", '2'], ['Spec & files', '1']]);
    expect(el.querySelector('.tv-guide')?.textContent).toContain('Each row is one Acceptance line');
    (el.querySelector('.tv-info-btn') as HTMLButtonElement).click();
    f.detectChanges();
    expect(el.querySelector('.tv-guide')).toBeNull();
    tab(el, 'Test plan').click();
    f.detectChanges();
    expect(el.querySelector('.tv-guide')?.textContent).toContain('Do the steps in the app');
    expect(localStorage.getItem('alfred.task.tab.cy')).toBe('test');
    expect(localStorage.getItem('alfred.task.guide.req')).toBe('closed');

    const again = render();
    expect((again.nativeElement as HTMLElement).querySelector('.tv-tab.on')?.textContent).toContain('Test plan');
  });

  it('the Test plan has the steps, the data, and Done when leading to what is left', () => {
    const f = render();
    const el: HTMLElement = f.nativeElement;
    tab(el, 'Test plan').click();
    f.detectChanges();
    expect(Array.from(el.querySelectorAll('.tv-step')).map((s) => Array.from(s.children).map((c) => c.textContent?.trim()).join(' ')))
      .toEqual(['✓ 1 Search DXB to LHR 31 calls', '✗ 2 Book for both passengers #38']);
    expect(el.querySelector('.tv-card .tv-list')?.textContent).toContain('Jane Doe');
    const dws = Array.from(el.querySelectorAll('.tv-dw')) as HTMLButtonElement[];
    expect(dws.map((d) => d.disabled)).toEqual([false, false, true]);
    dws[1].click();
    f.detectChanges();
    expect(tab(el, 'Requirements').classList).toContain('on');
    expect(Array.from(el.querySelectorAll('.tv-req .tv-st')).map((s) => s.textContent)).toEqual(['BUG']);
  });

  it("Claude's runs: newest open, Did / Found / Next", () => {
    const f = render();
    const el: HTMLElement = f.nativeElement;
    tab(el, "Claude's runs").click();
    f.detectChanges();
    const runs = Array.from(el.querySelectorAll('details.tv-run')) as HTMLDetailsElement[];
    expect(runs.map((r) => r.open)).toEqual([true, false]);
    expect(runs[0].textContent).toContain('listened to 12 calls');
    expect(runs[1].querySelector('.tv-nx')?.textContent).toContain('fix #38');
  });

  it('the brief stays loaded behind its tab, so the title and the asks count come from it', () => {
    const el: HTMLElement = render().nativeElement;
    expect((el.querySelector('app-cycle-brief') as HTMLElement).hidden).toBeTrue();
    expect(api.brief).toHaveBeenCalledTimes(1);
    expect(api.briefComments).toHaveBeenCalledTimes(1);
  });

  it('a board change for the cycle reloads it; brief comments reload only the brief', async () => {
    render();
    expect(api.cards).toHaveBeenCalledTimes(1);
    events.next({ type: 'board-changed', cycleId: 'cy', what: 'checklist' });
    await new Promise((r) => setTimeout(r, 200));
    expect(api.cards).toHaveBeenCalledTimes(2);
    events.next({ type: 'board-changed', cycleId: 'cy', what: 'brief-comments' });
    await new Promise((r) => setTimeout(r, 200));
    expect(api.cards).toHaveBeenCalledTimes(2);
    expect(api.briefComments).toHaveBeenCalledTimes(2);
  });

  it('read-only: no mark controls', () => {
    const el: HTMLElement = render(false).nativeElement;
    expect(el.querySelector('.tv-seg')).toBeNull();
  });
});

void NEVER;
