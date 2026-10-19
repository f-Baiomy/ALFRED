import { TestBed } from '@angular/core/testing';
import { Subject, of } from 'rxjs';
import { ActivityEntry, BoardQuestion, CardDetail, CardSummary } from '../../../core/models/board.models';
import { BoardApiService } from '../../../core/services/board-api.service';
import { BoardSocketService } from '../../../core/services/board-socket.service';
import { CardPeekComponent } from './card-peek.component';

const CARD: CardSummary = {
  id: 'peek-1', project: 'p', number: 97, kind: 'QUESTION', title: 'What does deactivating a country mean?', status: 'INBOX', resolution: null,
  reason: null, flags: ['NEEDS_DECISION'], scope: 'NOT_DECIDED', author: 'CLAUDE', cycleId: null, cycleDeleted: false, signature: null,
  createdAt: '2026-10-10T09:00:00Z', updatedAt: '2026-10-10T09:05:00Z', updatedBy: 'CLAUDE', commentCount: 2, similarClosed: null,
  description: '', openQuestions: 1, waiting: { who: 'USER', since: '2026-10-10T09:00:00Z', setBy: 'CLAUDE' },
};

const ASK = '**Question** What does it mean?\n\n```questions\n' + JSON.stringify({ questions: [{ header: 'قفل بلد', question: 'يعني إيه deactivate country؟',
  why: 'Decides the last item.', options: [{ label: 'إعدادات البلاد', description: 'البلد بتتقفل من شاشة إعدادات البلاد في الـ Admin.', then: 'هنختبر من الـ Admin.', recommended: true },
    { label: 'Remove from item', description: 'The admin removes it.' }] }] }) + '\n```';

const HISTORY: ActivityEntry[] = [
  { id: 1, cardId: 'peek-1', actor: 'CLAUDE', kind: 'COMMENT', text: '**Did** Raised by setup.\n\n**Next** Answer the question.', oldValue: null, newValue: null, at: '2026-10-10T09:01:00Z' },
  { id: 2, cardId: 'peek-1', actor: 'CLAUDE', kind: 'COMMENT', text: ASK, oldValue: null, newValue: null, at: '2026-10-10T09:02:00Z' },
] as unknown as ActivityEntry[];

const QUESTIONS: BoardQuestion[] = [{ entryId: 2, cardId: 'peek-1', idx: 0, header: 'قفل بلد', text: 'يعني إيه deactivate country؟', state: 'OPEN',
  laterUntil: null, answerEntry: null, parentIdx: null, parentOption: null, askedAt: '2026-10-10T09:02:00Z' }];

describe('CardPeekComponent', () => {
  function render(anchor = { top: 300, bottom: 420, left: 30, right: 290 }) {
    TestBed.configureTestingModule({
      imports: [CardPeekComponent],
      providers: [
        { provide: BoardApiService, useValue: {
          card: () => of({ ...CARD, description: 'The **item** text.', links: [{ type: 'WORKITEM', ref: 'x/1', label: 'AB#1' }] } as CardDetail),
          questions: () => of(QUESTIONS), activity: () => of({ entries: HISTORY, total: 2 }) } },
        { provide: BoardSocketService, useValue: { events$: new Subject() } },
      ],
    });
    const f = TestBed.createComponent(CardPeekComponent);
    f.componentRef.setInput('card', { ...CARD, id: 'peek-' + Math.random() });
    f.componentRef.setInput('anchor', anchor);
    f.componentRef.setInput('now', Date.parse('2026-10-10T09:30:00Z'));
    f.detectChanges();
    f.detectChanges();
    return f.nativeElement as HTMLElement;
  }

  it('reads the question whole: every option, the advised one marked, in its own direction', () => {
    const el = render();
    const opts = Array.from(el.querySelectorAll('.card-peek-opt'));
    expect(opts.length).toBe(2);
    expect(opts[0].classList).toContain('rec');
    expect(opts[0].textContent).toContain('Claude advises');
    expect(opts[0].getAttribute('dir')).toBe('rtl');
    expect(el.querySelector('.card-peek-why')!.textContent).toContain('Decides the last item.');
    expect(el.querySelector('.card-peek-wait')!.textContent).toContain('Waiting on you for 30 min · 1 open question');
  });

  it("shows Claude's latest state comment, never the question again, and the evidence", () => {
    const el = render();
    const latest = Array.from(el.querySelectorAll('.card-peek-sec')).find((s) => s.textContent!.includes('Latest comment'))!;
    expect(latest.textContent).toContain('Raised by setup.');
    expect(latest.textContent).not.toContain('What does it mean?');
    expect(el.querySelector('.card-peek-ev')!.textContent).toContain('AB#1');
  });

  it('sits beside the card and inside the window', () => {
    const el = render({ top: 300, bottom: 420, left: window.innerWidth - 280, right: window.innerWidth - 20 });
    const box = el.querySelector('.card-peek') as HTMLElement;
    const left = parseFloat(box.style.left);
    expect(left).toBeGreaterThanOrEqual(0);
    expect(left + 440).toBeLessThanOrEqual(window.innerWidth);
    expect(parseFloat(box.style.top)).toBeGreaterThanOrEqual(12);
  });
});
