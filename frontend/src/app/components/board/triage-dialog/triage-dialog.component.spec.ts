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

  it('goes worst first, shows Claude\'s advice with its confidence, and M takes an advised merge', () => {
    TestBed.configureTestingModule({ imports: [TriageDialogComponent] });
    const fixture = TestBed.createComponent(TriageDialogComponent);
    const a = { ...card('a', 1) };
    const b = { ...card('b', 2), openQuestions: 1, advice: 'Merge into #1',
      adviceDetail: { option: 'Merge into #1', confidence: 'MEDIUM', checked: 'same 409 as #1', rank: 1, of: 2 } };
    fixture.componentRef.setInput('queue', [a, b]);
    const decisions: TriageDecision[] = [];
    fixture.componentInstance.decided.subscribe((d) => decisions.push(d));
    fixture.detectChanges();

    const text: string = fixture.nativeElement.textContent;
    expect(text).toContain('#2 card 2');
    expect(text).toContain('Claude advises: Merge into #1');
    expect(text).toContain('Medium');
    expect(text).toContain('Checked: same 409 as #1');
    expect(fixture.nativeElement.querySelector('.board-triage-btns button.advised').textContent).toContain('Merge');

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'm' }));
    fixture.detectChanges();
    expect(decisions).toEqual([{ card: b, kind: 'merge', into: 1, reason: '' }]);
    expect(fixture.nativeElement.textContent).toContain('#1 card 1');
  });

  it('M with no advice asks which card to merge into', () => {
    TestBed.configureTestingModule({ imports: [TriageDialogComponent] });
    const fixture = TestBed.createComponent(TriageDialogComponent);
    fixture.componentRef.setInput('queue', [card('a', 3)]);
    const decisions: TriageDecision[] = [];
    fixture.componentInstance.decided.subscribe((d) => decisions.push(d));
    fixture.detectChanges();

    fixture.componentInstance.decide('M');
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.board-triage-into')).not.toBeNull();
    fixture.componentInstance.mergeInto.set(9);
    fixture.componentInstance.mergeTo();
    expect(decisions).toEqual([{ card: jasmine.anything() as unknown as CardSummary, kind: 'merge', into: 9, reason: '' }]);
  });

  it('Accept all High takes every High advice at once and skips those cards; the rest stay', () => {
    TestBed.configureTestingModule({ imports: [TriageDialogComponent] });
    const fixture = TestBed.createComponent(TriageDialogComponent);
    const high = (id: string, n: number, option: string) => ({ ...card(id, n), openQuestions: 1, advice: option, adviceDetail: { option, confidence: 'HIGH' } });
    const c1 = high('a', 1, 'To do');
    const c2 = { ...card('b', 2), openQuestions: 1, advice: 'Fine', adviceDetail: { option: 'Fine', confidence: 'LOW' } };
    const c3 = high('c', 3, 'Fine');
    fixture.componentRef.setInput('queue', [c1, c2, c3]);
    const decisions: TriageDecision[] = [];
    fixture.componentInstance.decided.subscribe((d) => decisions.push(d));
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain('Accept all High (2)');

    fixture.componentInstance.acceptHigh();
    fixture.detectChanges();

    expect(decisions).toEqual([{ card: c1, kind: 'todo' }, { card: c3, kind: 'close', resolution: 'FINE', reason: '' }]);
    expect(fixture.nativeElement.textContent).toContain('#2 card 2');
    fixture.componentInstance.decide('S');
    fixture.detectChanges();
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
