import { TestBed } from '@angular/core/testing';
import { CdkDragDrop } from '@angular/cdk/drag-drop';
import { CardStatus, CardSummary } from '../../../core/models/board.models';
import { BoardColumnsComponent, CardDrop } from './board-columns.component';
import { signal } from '@angular/core';
import { LiveWorkStateService } from '../../../core/state/live-work-state.service';

/** The cards ask what /alfred-live is doing on them; here nothing. */
import { NO_SKILL_RUNS } from '../../../core/state/skill-runs-state.service';
const NO_LIVE_WORK = [{ provide: LiveWorkStateService, useValue: { working: signal([]) } }, NO_SKILL_RUNS];

function card(id: string, status: CardStatus): CardSummary {
  return {
    id, project: 'p', number: 1, kind: 'BUG', title: 't', status, resolution: null, reason: null, flags: [], scope: 'NOT_DECIDED',
    author: 'USER', cycleId: null, cycleDeleted: false, signature: null, createdAt: '2026-10-10T09:00:00Z',
    updatedAt: '2026-10-10T09:00:00Z', updatedBy: 'USER', commentCount: 0, similarClosed: null, description: '',
  };
}

function drop(item: CardSummary, to: CardStatus): CdkDragDrop<CardStatus, CardStatus, CardSummary> {
  return { item: { data: item }, container: { data: to } } as unknown as CdkDragDrop<CardStatus, CardStatus, CardSummary>;
}

describe('BoardColumnsComponent', () => {
  function create(cards: CardSummary[]) {
    TestBed.configureTestingModule({ imports: [BoardColumnsComponent], providers: NO_LIVE_WORK });
    const fixture = TestBed.createComponent(BoardColumnsComponent);
    fixture.componentRef.setInput('cards', cards);
    fixture.detectChanges();
    return fixture.componentInstance;
  }

  it('asks for a move when a card is dropped in another open column', () => {
    const c = card('a', 'INBOX');
    const columns = create([c]);
    const moves: CardDrop[] = [];
    columns.moved.subscribe((m) => moves.push(m));

    columns.onDrop(drop(c, 'IN_PROGRESS'));

    expect(moves).toEqual([{ card: c, to: 'IN_PROGRESS' }]);
  });

  it('opens the card instead of moving it when dropped on Closed (a close needs a resolution)', () => {
    const c = card('a', 'TO_DO');
    const columns = create([c]);
    const opened: CardSummary[] = [];
    const moves: CardDrop[] = [];
    columns.opened.subscribe((o) => opened.push(o));
    columns.moved.subscribe((m) => moves.push(m));

    columns.onDrop(drop(c, 'CLOSED'));
    columns.onDrop(drop(c, 'TO_DO'));

    expect(opened).toEqual([c]);
    expect(moves).toEqual([]);
  });

  it('shows the Inbox empty state and one column per status', () => {
    TestBed.configureTestingModule({ imports: [BoardColumnsComponent], providers: NO_LIVE_WORK });
    const fixture = TestBed.createComponent(BoardColumnsComponent);
    fixture.componentRef.setInput('cards', []);
    fixture.detectChanges();
    const el: HTMLElement = fixture.nativeElement;
    expect(el.querySelectorAll('.board-col').length).toBe(7);
    expect(el.textContent).toContain('Inbox clear');
  });

  it('re-tests one Fixed card, the selected ones or all, and shows each card re-test chip', () => {
    TestBed.configureTestingModule({ imports: [BoardColumnsComponent], providers: NO_LIVE_WORK });
    const fixture = TestBed.createComponent(BoardColumnsComponent);
    const a = { ...card('a', 'FIXED'), number: 18 };
    const b = { ...card('b', 'FIXED'), number: 19 };
    fixture.componentRef.setInput('cards', [a, b]);
    fixture.componentRef.setInput('selected', new Set(['b']));
    fixture.componentRef.setInput('retests', new Map([[19, { number: 19, project: 'p', title: 't', status: 'FIXED', since: null, verdict: 'PASSES',
      statusOnly: false, summary: 'passes · 3 calls since the fix', results: [], calls: [], steps: [], newBuild: false }]]));
    fixture.detectChanges();
    const asked: (readonly number[])[] = [];
    fixture.componentInstance.retest.subscribe((n) => asked.push(n));
    const el: HTMLElement = fixture.nativeElement;
    const buttons = Array.from(el.querySelectorAll('button'));
    buttons.find((x) => x.textContent?.includes('Re-test all 2'))!.click();
    buttons.find((x) => x.textContent?.includes('Re-test 1 selected'))!.click();
    buttons.filter((x) => x.textContent?.trim() === '▶ Re-test')[0].click();
    expect(asked).toEqual([[18, 19], [19], [18]]);
    // specs/026: a Fixed card shows its two checks - implemented (nobody looked yet) and worked
    const checks = Array.from(el.querySelectorAll('.board-vcheck')).map((c) => c.textContent?.replace(/\s+/g, ' ').trim());
    expect(checks).toEqual(['? Code not checked/alfred-verify checks it', '✓ Worked3 calls since the fix']);
    expect(buttons.some((x) => x.textContent?.includes('✓ Verified'))).toBeTrue();
  });
});
