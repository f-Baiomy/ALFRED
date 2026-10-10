import { TestBed } from '@angular/core/testing';
import { CardSummary } from '../../../core/models/board.models';
import { TriageDecision, TriageDialogComponent } from './triage-dialog.component';

function card(id: string, number: number): CardSummary {
  return {
    id, project: 'p', number, kind: 'BUG', title: `card ${number}`, status: 'INBOX', resolution: null, reason: null, flags: [],
    scope: 'NOT_DECIDED', author: 'CLAUDE', cycleId: null, cycleDeleted: false, signature: null, createdAt: '2026-10-10T09:00:00Z',
    updatedAt: '2026-10-10T09:00:00Z', updatedBy: 'CLAUDE', commentCount: 0, similarClosed: null, description: '',
  };
}

describe('TriageDialogComponent', () => {
  it('decides F, N, T and S in order, one card at a time, and ends on "Inbox clear"', () => {
    TestBed.configureTestingModule({ imports: [TriageDialogComponent] });
    const fixture = TestBed.createComponent(TriageDialogComponent);
    const cards = [card('a', 1), card('b', 2), card('c', 3), card('d', 4)];
    fixture.componentRef.setInput('queue', cards);
    const decisions: TriageDecision[] = [];
    fixture.componentInstance.decided.subscribe((d) => decisions.push(d));
    fixture.detectChanges();

    for (const key of ['f', 'n', 't', 's']) {
      document.dispatchEvent(new KeyboardEvent('keydown', { key }));
      fixture.detectChanges();
    }

    expect(decisions).toEqual([
      { card: cards[0], kind: 'close', resolution: 'FINE', reason: '' },
      { card: cards[1], kind: 'close', resolution: 'NOT_IN_FLOW', reason: '' },
      { card: cards[2], kind: 'todo' },
    ]);
    expect(fixture.nativeElement.textContent).toContain('Inbox clear');
  });

  it('passes the typed reason with the decision', () => {
    TestBed.configureTestingModule({ imports: [TriageDialogComponent] });
    const fixture = TestBed.createComponent(TriageDialogComponent);
    fixture.componentRef.setInput('queue', [card('a', 1)]);
    const decisions: TriageDecision[] = [];
    fixture.componentInstance.decided.subscribe((d) => decisions.push(d));
    fixture.detectChanges();

    fixture.componentInstance.reasonText.set('expected: health needs no session');
    fixture.componentInstance.decide('F');

    expect(decisions[0]).toEqual({ card: jasmine.anything() as unknown as CardSummary, kind: 'close', resolution: 'FINE',
      reason: 'expected: health needs no session' });
  });
});
