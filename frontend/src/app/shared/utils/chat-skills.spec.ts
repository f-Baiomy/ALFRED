import { CHAT_SKILLS, skillsMatching, slashSkill } from './chat-skills';

describe('chat-skills', () => {
  it('offers every shipped skill but the two that run the chat', () => {
    expect(CHAT_SKILLS).toHaveSize(15);
    expect(CHAT_SKILLS.some((s) => s.name === 'alfred-live' || s.name === 'alfred-listen')).toBeFalse();
  });

  it('reads a picked skill and its arguments from the text, and nothing else', () => {
    expect(slashSkill('/alfred-fix 35 42')).toEqual({ skill: 'alfred-fix', args: '35 42' });
    expect(slashSkill('  /alfred-status ')).toEqual({ skill: 'alfred-status', args: '' });
    expect(slashSkill('/alfred-live')).toBeNull();
    expect(slashSkill('please /alfred-fix')).toBeNull();
  });

  it('narrows the list by what follows the slash', () => {
    expect(skillsMatching('/').length).toBe(15);
    expect(skillsMatching('/fi').map((s) => s.name)).toEqual(['alfred-fix']);
    expect(skillsMatching('/alfred-s').map((s) => s.name)).toEqual(['alfred-setup', 'alfred-spec', 'alfred-sync', 'alfred-status']);
    expect(skillsMatching('hello')).toEqual([]);
  });
});
