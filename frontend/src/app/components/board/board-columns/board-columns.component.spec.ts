import { TestBed } from '@angular/core/testing';
import { CdkDragDrop } from '@angular/cdk/drag-drop';
import { CardStatus, CardSummary } from '../../../core/models/board.models';
import { BoardColumnsComponent, CardDrop } from './board-columns.component';

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
    TestBed.configureTestingModule({ imports: [BoardColumnsComponent] });
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
    TestBed.configureTestingModule({ imports: [BoardColumnsComponent] });
    const fixture = TestBed.createComponent(BoardColumnsComponent);
    fixture.componentRef.setInput('cards', []);
    fixture.detectChanges();
    const el: HTMLElement = fixture.nativeElement;
    expect(el.querySelectorAll('.board-col').length).toBe(7);
    expect(el.textContent).toContain('Inbox clear');
  });
});
