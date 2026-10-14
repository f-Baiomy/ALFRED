import { ActivityEntry, CardDetail } from '../../core/models/board.models';
import { issueMarkdown, skillArg, skillFor, waitingText } from './board-skills';

function card(over: Partial<CardDetail> = {}): CardDetail {
  return {
    id: 'k', project: 'odeysys', number: 11, kind: 'BUG', title: 'read-pnr 409', status: 'TO_DO', resolution: null, reason: null, flags: [],
    scope: 'NOT_DECIDED', author: 'CLAUDE', cycleId: null, cycleDeleted: false, signature: null, createdAt: '2026-10-11T00:00:00Z',
    updatedAt: '2026-10-11T00:00:00Z', updatedBy: 'CLAUDE', commentCount: 0, similarClosed: null, description: '', links: [], ...over,
  };
}

describe('board-skills', () => {
  it('names the skill a card needs next', () => {
    expect(skillFor(card({ status: 'INBOX' }))).toBe('/alfred-triage');
    expect(skillFor(card({ status: 'TO_DO' }))).toBe('/alfred-fix 11');
    expect(skillFor(card({ status: 'FIXED' }))).toBe('/alfred-verify 11');
    expect(skillFor(card({ status: 'INBOX', flags: ['NEEDS_DECISION'], waiting: { who: 'USER', since: '', setBy: 'CLAUDE' } }))).toBe('/alfred-sync');
    expect(skillFor(card({ status: 'DONE' }))).toBeNull();
    // waiting on Claude: Claude catches up with this card - but sorted to To do / In progress it is the fix (which
    // catches up first): moving a card there is what makes it wait on Claude
    expect(skillFor(card({ status: 'INBOX', waiting: { who: 'CLAUDE', since: '', setBy: 'USER' } }))).toBe('/alfred-sync 11');
    expect(skillFor(card({ status: 'TO_DO', waiting: { who: 'CLAUDE', since: '', setBy: 'USER' } }))).toBe('/alfred-fix 11');
    expect(skillFor(card({ status: 'IN_PROGRESS', waiting: { who: 'CLAUDE', since: '', setBy: 'USER' } }))).toBe('/alfred-fix 11');
  });

  it('quotes a cycle name with spaces', () => {
    expect(skillArg('ODY-482')).toBe('ODY-482');
    expect(skillArg('ODY 482 import')).toBe('"ODY 482 import"');
  });

  it('says who a card waits on and how long', () => {
    const now = Date.parse('2026-10-13T00:00:00Z');
    expect(waitingText({ who: 'USER', since: '2026-10-11T00:00:00Z', setBy: 'CLAUDE' }, now)).toBe('waiting on you · 2 d');
    expect(waitingText({ who: 'NONE', since: '2026-10-11T00:00:00Z', setBy: 'USER' }, now)).toBeNull();
    expect(waitingText(null, now)).toBeNull();
  });

  it('copies a card as an issue with its evidence, the spec it breaks and the user\'s answers', () => {
    const history: ActivityEntry[] = [
      { id: 1, cardId: 'k', actor: 'CLAUDE', kind: 'COMMENT', text: '**Question** Branch 948 meant to have PCC 321?', oldValue: null, newValue: null, at: '2026-10-11T00:49:00Z' },
      { id: 2, cardId: 'k', actor: 'USER', kind: 'COMMENT', text: 'No - filter by branch', oldValue: null, newValue: null, at: '2026-10-11T09:12:00Z', replyTo: 1 },
    ];
    const md = issueMarkdown(card({
      description: 'see @[call:in:a1|POST /read-pnr · 409]',
      links: [{ type: 'call', ref: 'in:a1', label: 'POST /read-pnr · 409' }],
      specItems: [{ cycleId: 'c', fileName: 'spec.md', itemKey: 'x', text: 'Branch offers only its own PCCs' }],
    }), history);
    expect(md).toContain('## read-pnr 409');
    expect(md).toContain('see POST /read-pnr · 409');
    expect(md).toContain('- call: POST /read-pnr · 409 (`in:a1`)');
    expect(md).toContain('- spec.md: Branch offers only its own PCCs');
    expect(md).toContain('- Q: Branch 948 meant to have PCC 321?\n  A: No - filter by branch (2026-10-11 09:12)');
  });
});
