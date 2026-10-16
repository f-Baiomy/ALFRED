import { CardSummary } from '../../core/models/board.models';
import { actionText, adviceAction, confidenceLabel, confidenceOf, highCards, worstFirst } from './triage-advice';

function card(number: number, advice: string | null, detail: Partial<NonNullable<CardSummary['adviceDetail']>> = {}, open = 1): CardSummary {
  return {
    id: 'c' + number, project: 'p', number, kind: 'BUG', title: `card ${number}`, status: 'INBOX', resolution: null, reason: null, flags: [],
    scope: 'NOT_DECIDED', author: 'CLAUDE', cycleId: null, cycleDeleted: false, signature: null, createdAt: '2026-10-10T09:00:00Z',
    updatedAt: '2026-10-10T09:00:00Z', updatedBy: 'CLAUDE', commentCount: 0, similarClosed: null, description: '', openQuestions: open,
    advice, adviceDetail: advice ? { option: advice, ...detail } : null,
  };
}

describe('triage advice', () => {
  it('turns the advised option into the action the board takes', () => {
    expect(adviceAction(card(1, 'To do'))).toEqual({ kind: 'move', status: 'TO_DO' });
    expect(adviceAction(card(1, 'Fine'))).toEqual({ kind: 'close', resolution: 'FINE' });
    expect(adviceAction(card(1, 'Not in this flow'))).toEqual({ kind: 'close', resolution: 'NOT_IN_FLOW' });
    expect(adviceAction(card(1, 'Merge into #12'))).toEqual({ kind: 'merge', into: 12 });
    expect(adviceAction(card(12, 'Merge #14 #17 into #12'))).toEqual({ kind: 'mergeGroup', group: [14, 17] });
    expect(adviceAction(card(12, 'Merge them here', { group: [14, 17] }))).toEqual({ kind: 'mergeGroup', group: [14, 17] });
    expect(adviceAction(card(1, 'Ask the team'))).toBeNull();
    expect(adviceAction(card(1, 'To do', {}, 0))).withContext('answered: no advice left').toBeNull();
  });

  it('reads the confidence in any case and names the action in plain words', () => {
    expect(confidenceOf(card(1, 'To do', { confidence: 'high' }))).toBe('HIGH');
    expect(confidenceOf(card(1, 'To do', { confidence: 'sure' }))).toBeNull();
    expect(confidenceLabel('MEDIUM')).toBe('Medium');
    expect(actionText({ kind: 'mergeGroup', group: [14, 17] })).toBe('Merge #14 #17 here');
    expect(actionText({ kind: 'close', resolution: 'NOT_IN_FLOW' })).toBe('Not in this flow');
  });

  it('puts ranked cards worst first and keeps the rest in their order', () => {
    const cards = [card(1, null), card(2, 'To do', { rank: 2 }), card(3, null), card(4, 'Fine', { rank: 1 })];
    expect(worstFirst(cards).map((c) => c.number)).toEqual([4, 2, 1, 3]);
  });

  it('accepts all High only for High advice the board can take', () => {
    const cards = [card(1, 'To do', { confidence: 'HIGH' }), card(2, 'Fine', { confidence: 'MEDIUM' }), card(3, 'Ask', { confidence: 'HIGH' }),
      card(4, 'Merge into #1', { confidence: 'high' })];
    expect(highCards(cards).map((c) => c.number)).toEqual([1, 4]);
  });
});
