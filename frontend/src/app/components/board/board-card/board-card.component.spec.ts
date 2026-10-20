import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { CardSummary } from '../../../core/models/board.models';
import { BundleOutboxService } from '../../../core/team/bundle-outbox.service';
import { LiveWorkStateService } from '../../../core/state/live-work-state.service';
import { NO_SKILL_RUNS } from '../../../core/state/skill-runs-state.service';
import { BoardCardComponent, shortTime } from './board-card.component';

const PROVIDERS = [{ provide: LiveWorkStateService, useValue: { working: signal([]) } }, NO_SKILL_RUNS,
  { provide: BundleOutboxService, useValue: { byCard: signal(new Map()) } }];

function card(over: Partial<CardSummary> = {}): CardSummary {
  return {
    id: 'c1', project: 'p', number: 97, kind: 'QUESTION', title: 'What does it mean?', status: 'INBOX', resolution: null, reason: null, flags: [],
    scope: 'NOT_DECIDED', author: 'CLAUDE', cycleId: null, cycleDeleted: false, signature: null, createdAt: '2026-10-10T09:00:00Z',
    updatedAt: '2026-10-10T09:00:00Z', updatedBy: 'CLAUDE', commentCount: 4, similarClosed: null, description: '', ...over,
  };
}

describe('BoardCardComponent (compact)', () => {
  function render(c: CardSummary) {
    TestBed.configureTestingModule({ imports: [BoardCardComponent], providers: PROVIDERS });
    const f = TestBed.createComponent(BoardCardComponent);
    f.componentRef.setInput('card', c);
    f.componentRef.setInput('compact', true);
    f.componentRef.setInput('now', Date.parse('2026-10-10T09:27:00Z'));
    f.detectChanges();
    return { f, el: f.nativeElement as HTMLElement };
  }

  it('shows the questions as its one state line, Claude\'s proposal in its own box, and pulses', () => {
    const { el } = render(card({
      openQuestions: 1, advice: 'إعدادات البلاد', flags: ['NEEDS_DECISION'],
      proposal: { cardId: 'c1', kind: 'STATUS', status: 'TO_DO', resolution: null, reason: 'r', evidence: '', at: '2026-10-10T09:00:00Z' },
      waiting: { who: 'USER', since: '2026-10-10T09:00:00Z', setBy: 'CLAUDE' },
    }));
    const line = el.querySelector('.bcc-q')!;
    expect(line.textContent).toContain('1 question');
    expect(line.querySelector('bdi')!.getAttribute('dir')).toBe('rtl');
    expect(el.querySelector('.bcc-more')).toBeNull();
    expect(el.querySelector('.board-prop')!.textContent).toContain('Claude proposes To do');
    expect(el.querySelector('.board-card')!.classList).toContain('asks');
    expect(el.querySelector('.bcc-wait')!.textContent).toContain('you · 27m');
    // the sort row keeps its three buttons and keys
    const acts = Array.from(el.querySelectorAll('.board-card-acts > button')).map((b) => b.textContent!.replace(/\s+/g, ''));
    expect(acts).toEqual(['✓FineF', '⊘NotinflowN', '→TodoT']);
  });

  it('does not pulse a card that only waits to be sorted, nor a closed one', () => {
    const sortOnly = render(card({ kind: 'TASK', waiting: { who: 'USER', since: '2026-10-10T09:00:00Z', setBy: 'CLAUDE' } }));
    expect(sortOnly.el.querySelector('.board-card')!.classList).not.toContain('asks');
    TestBed.resetTestingModule();
    const closed = render(card({ status: 'CLOSED', resolution: 'FINE', flags: ['NEEDS_DECISION'], openQuestions: 1 }));
    expect(closed.el.querySelector('.board-card')!.classList).not.toContain('asks');
  });

  it('counts the mentions by kind and keeps the title direction its own', () => {
    const { el } = render(card({
      kind: 'BUG', title: 'الـ Admin بيشيل البلد من البلاد المتحددة',
      mentionChips: [{ type: 'CALL', ref: 'a', label: 'GET /x' }, { type: 'CALL', ref: 'b', label: 'GET /y' }, { type: 'STMT', ref: 's', label: '#1' }],
    }));
    const counts = Array.from(el.querySelectorAll('.bcc-count')).map((c) => c.textContent!.trim());
    expect(counts).toEqual(['⇄2', '◆1']);
    expect(el.querySelector('.board-card-title')!.getAttribute('dir')).toBe('rtl');
  });

  it('decides Claude\'s proposal on the card: why, Accept naming the step, Dismiss - never opening the card', () => {
    const { f, el } = render(card({
      proposal: { cardId: 'c1', kind: 'STATUS', status: 'CLOSED', resolution: 'WONT_FIX', reason: 'AB#60766 is outside this board', evidence: '', at: '2026-10-10T09:00:00Z' },
    }));
    const actions: string[] = [];
    let opened = 0;
    f.componentInstance.action.subscribe((a) => actions.push(a.kind));
    f.componentInstance.opened.subscribe(() => opened++);
    const box = el.querySelector('.board-prop')!;
    expect(box.querySelector('.board-prop-why')!.textContent).toContain('AB#60766 is outside this board');
    const [accept, dismiss] = Array.from(box.querySelectorAll<HTMLButtonElement>('.board-prop-acts > button'));
    expect(accept.textContent).toContain('Close as');
    accept.click();
    dismiss.click();
    (box as HTMLElement).click();
    expect(actions).toEqual(['acceptProposal', 'dismissProposal']);
    expect(opened).toBe(0);
  });

  it('shows a proposal without buttons to someone who cannot edit the board', () => {
    TestBed.configureTestingModule({ imports: [BoardCardComponent], providers: PROVIDERS });
    const f = TestBed.createComponent(BoardCardComponent);
    f.componentRef.setInput('card', card({ proposal: { cardId: 'c1', kind: 'MERGE', status: 'CLOSED', resolution: null, reason: '', evidence: '', at: '2026-10-10T09:00:00Z', intoNumber: 11 } }));
    f.componentRef.setInput('editable', false);
    f.detectChanges();
    const el = f.nativeElement as HTMLElement;
    expect(el.querySelector('.board-prop')!.textContent).toContain('merge into #11');
    expect(el.querySelector('.board-prop-acts')).toBeNull();
  });

  it('shortens times to one style', () => {
    expect(shortTime('27 min')).toBe('27m');
    expect(shortTime('5 h')).toBe('5h');
    expect(shortTime('3 d')).toBe('3d');
  });
});
