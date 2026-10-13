import { CardSummary, ChecklistFile, ChecklistItem } from '../../core/models/board.models';
import {
  briefParts, countStates, decisionsOf, doneWhen, itemsOf, needsYou, notesOf, phaseOf, requirementsOf, taskRefs, verdictOf,
} from './task-view';

function card(number: number, kind: CardSummary['kind'], status: CardSummary['status'], extra: Partial<CardSummary> = {}): CardSummary {
  return {
    id: 'c' + number, project: 'p', number, kind, title: 'card ' + number, status, resolution: null, reason: null, flags: [],
    scope: 'NOT_DECIDED', author: 'CLAUDE', cycleId: 'cy', cycleDeleted: false, signature: null, createdAt: '2026-10-12T10:00:00Z',
    updatedAt: '2026-10-12T10:00:00Z', updatedBy: 'CLAUDE', commentCount: 0, similarClosed: null, description: '', ...extra,
  };
}

function item(key: string, extra: Partial<ChecklistItem> = {}): ChecklistItem {
  return { key, text: 'item ' + key, mark: null, ...extra };
}

const mark = (m: 'PASS' | 'FAIL' | 'CANT_TELL') => ({
  cycleId: 'cy', fileName: 'spec.md', itemKey: 'k', mark: m, actor: 'USER' as const, evidence: 'seen', history: [], updatedAt: '2026-10-12T10:00:00Z',
});
const suggestion = (m: 'PASS' | 'FAIL' | 'CANT_TELL') => ({ cycleId: 'cy', fileName: 'spec.md', itemKey: 'k', mark: m, evidence: 'Claude says', at: '2026-10-12T10:00:00Z' });
const ref = (number: number, status: CardSummary['status']) => ({ project: 'p', number, title: 'card ' + number, status });

describe('task-view', () => {
  const BRIEF = `Bookings keep every passenger.

## Task
- ODY-482, branch \`feature/ODY-482\`

## Description
When a customer books for two, only one reaches the airline.

## Scope
- OrderMapper
- booking save

## Out of scope
- payment

## Test steps
1. Search
2. Book

## Data
- Jane Doe

## Decisions
- 2026-10-12 fare may change at confirm - show it
- keep the old endpoint

## Notes
free text`;

  it('splits the brief into its sections, keeping unknown ones', () => {
    const p = briefParts(BRIEF);
    expect(p.goal).toBe('Bookings keep every passenger.');
    expect(p.sections['description']).toContain('only one reaches');
    expect(itemsOf(p.sections['scope'])).toEqual(['OrderMapper', 'booking save']);
    expect(itemsOf(p.sections['test steps'])).toEqual(['Search', 'Book']);
    expect(p.other).toEqual([{ title: 'Notes', text: 'free text' }]);
    expect(taskRefs(p.sections['task'])).toEqual({ tickets: ['ODY-482'], branch: 'feature/ODY-482' });
    expect(decisionsOf(p.sections['decisions'])).toEqual([
      { date: '2026-10-12', text: 'fare may change at confirm - show it' }, { date: null, text: 'keep the old endpoint' },
    ]);
  });

  it('shows an older free-text brief whole', () => {
    const p = briefParts('Check the import page.\nSteps: open it.');
    expect(p.goal).toBe('');
    expect(p.other).toEqual([{ title: '', text: 'Check the import page.\nSteps: open it.' }]);
    expect(itemsOf('- <what this task changes>')).toEqual([]);
  });

  it('gives each requirement a state: the mark first, then its cards, then Claude\'s suggestion', () => {
    const files: ChecklistFile[] = [{
      fileName: 'spec.md', items: [
        item('a', { mark: mark('PASS') }),
        item('b', { cards: [ref(1, 'TO_DO')] }),
        item('c', { cards: [ref(2, 'INBOX')] }),
        item('d', { cards: [ref(3, 'FIXED')] }),
        item('e', { suggestion: suggestion('PASS') }),
        item('f', { suggestion: suggestion('CANT_TELL') }),
        item('g'),
        item('h', { mark: mark('FAIL'), cards: [ref(2, 'INBOX')] }),
      ],
    }];
    const cards = [card(1, 'BUG', 'TO_DO'), card(2, 'TASK', 'INBOX'), card(3, 'BUG', 'FIXED')];
    const reqs = requirementsOf(files, cards);
    const by = Object.fromEntries(reqs.map((r) => [r.item.key, r]));
    expect(by['a'].state).toBe('MET');
    expect(by['a'].byUser).toBeTrue();
    expect(by['b'].state).toBe('BUG');
    expect(by['c'].state).toBe('MISSING');
    expect(by['d'].state).toBe('FIXED');
    expect(by['e'].state).toBe('MET');
    expect(by['e'].suggested).toBeTrue();
    expect(by['f'].state).toBe('CANT_TELL');
    expect(by['g'].state).toBe('UNTESTED');
    expect(by['h'].state).toBe('MISSING');
    expect(reqs.map((r) => r.state)).toEqual(['BUG', 'MISSING', 'MISSING', 'FIXED', 'CANT_TELL', 'UNTESTED', 'MET', 'MET']);
    expect(by['a'].label).toBe('R1');
    expect(by['h'].label).toBe('R8');
    expect(countStates(reqs)).toEqual({ BUG: 1, MISSING: 2, FIXED: 1, CANT_TELL: 1, UNTESTED: 1, MET: 2 });
    expect(verdictOf(reqs)).toEqual({ tone: 'bad', head: 'Not yet', detail: '1 bug, 2 requirements missing' });
  });

  it('answers the verdict and the phase as the task moves on', () => {
    const files = (items: ChecklistItem[]): ChecklistFile[] => [{ fileName: 'spec.md', items }];
    expect(verdictOf([]).tone).toBe('none');
    expect(phaseOf([], [], [], [])).toBe(0);

    const verifying = requirementsOf(files([item('a', { cards: [ref(1, 'TO_DO')] })]), [card(1, 'BUG', 'TO_DO')]);
    expect(phaseOf(verifying, [card(1, 'BUG', 'TO_DO')], [], [])).toBe(1);

    const fixedCards = [card(1, 'BUG', 'FIXED')];
    const fixed = requirementsOf(files([item('a', { cards: [ref(1, 'FIXED')] })]), fixedCards);
    expect(verdictOf(fixed).head).toBe('Fixed, not re-tested');
    expect(phaseOf(fixed, fixedCards, [], [])).toBe(2);

    const suggested = requirementsOf(files([item('a', { suggestion: suggestion('PASS') })]), [card(1, 'BUG', 'VERIFIED')]);
    expect(verdictOf(suggested).head).toBe('Looks done');
    expect(phaseOf(suggested, [card(1, 'BUG', 'VERIFIED')], [], [])).toBe(3);

    const done = requirementsOf(files([item('a', { mark: mark('PASS') })]), []);
    expect(verdictOf(done)).toEqual({ tone: 'ok', head: 'Yes', detail: 'every requirement met and marked' });
    expect(phaseOf(done, [], [], [])).toBe(4);
    expect(doneWhen(done, []).every((d) => d.ok)).toBeTrue();
    expect(doneWhen(fixed, fixedCards).map((d) => d.ok)).toEqual([false, true, false]);
  });

  it('keeps notes, unlinked tasks and "not in the task" apart from the requirements', () => {
    const cards = [
      card(1, 'NOTE', 'INBOX', { title: 'N+1 airports', flags: ['RISK'] }),
      card(2, 'NOTE', 'INBOX', { title: 'Not in the task: AgencyService credential lookup' }),
      card(3, 'TASK', 'TO_DO', { title: 'price change shown' }),
      card(4, 'BUG', 'TO_DO'),
      card(5, 'NOTE', 'CLOSED'),
      card(6, 'TASK', 'TO_DO'),
    ];
    const reqs = requirementsOf([{ fileName: 's', items: [item('a', { cards: [ref(6, 'TO_DO')] })] }], cards);
    const { notes, notInTask } = notesOf(cards, reqs);
    expect(notes.map((n) => [n.card.number, n.tag])).toEqual([[1, 'RISK'], [3, 'TASK']]);
    expect(notInTask.map((n) => n.title)).toEqual(['AgencyService credential lookup']);
  });

  it('lists what waits on the user', () => {
    const cards = [
      card(1, 'QUESTION', 'INBOX'),
      card(2, 'BUG', 'FIXED', { proposal: { cardId: 'c2', status: 'VERIFIED', resolution: null, reason: '', evidence: '', at: '' } }),
      card(3, 'BUG', 'TO_DO', { waiting: { who: 'USER', since: '', setBy: 'CLAUDE' } }),
      card(4, 'BUG', 'TO_DO', { waiting: { who: 'CLAUDE', since: '', setBy: 'CLAUDE' } }),
    ];
    expect(needsYou(cards).map((n) => [n.card.number, n.why])).toEqual([[1, 'a question'], [2, 'Claude proposes verified'], [3, 'waits on you']]);
  });
});
