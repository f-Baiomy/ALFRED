import { ActivityEntry } from '../../core/models/board.models';
import { changeText, claudeParts, proposalTarget } from './board-activity';

function entry(kind: ActivityEntry['kind'], fields: Partial<ActivityEntry> = {}): ActivityEntry {
  return { id: 1, cardId: 'k', actor: 'CLAUDE', kind, text: null, oldValue: null, newValue: null, at: '2026-10-10T09:00:00Z', ...fields };
}

describe('board-activity', () => {
  it('splits a Claude comment into Did / Found / Next / Impact', () => {
    expect(claudeParts('**Did** a\n\n**Found** b\n\n**Next** c')?.map((p) => p.label)).toEqual(['DID', 'FOUND', 'NEXT']);
    expect(claudeParts('plain words')).toBeNull();
  });

  it('labels a reply and a question', () => {
    expect(claudeParts('**Reply** It is the cache.')).toEqual([{ label: 'REPLY', text: 'It is the cache.' }]);
    expect(claudeParts('**Question** Stack vouchers?')).toEqual([{ label: 'QUESTION', text: 'Stack vouchers?' }]);
  });

  it('says what a proposal asks for in words', () => {
    expect(proposalTarget('VERIFIED')).toBe('Verified');
    expect(proposalTarget('CLOSED:FINE')).toContain('close as Fine');
    expect(changeText(entry('PROPOSED', { newValue: 'VERIFIED', text: 'retest passed' }))).toBe('Claude proposed Verified - retest passed');
    expect(changeText(entry('PROPOSAL_ACCEPTED', { actor: 'USER', newValue: 'DONE' }))).toBe("You accepted Claude's proposal: Done");
    expect(changeText(entry('PROPOSAL_DISMISSED', { actor: 'USER', newValue: 'CLOSED:NOT_IN_FLOW' }))).toContain("You dismissed Claude's proposal: close as");
  });
});
