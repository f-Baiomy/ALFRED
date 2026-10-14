import { SkillRun } from '../../core/models/board.models';
import { failureHint, shellLine, skillOf, skillPrompt, startSteps, usualText } from './skill-prompt';

describe('skill-prompt', () => {
  it('the prompt is the command, then the Alfred, project, cycle, card, who it waits on and the user\'s last word', () => {
    expect(skillPrompt({
      command: '/alfred-sync 35', alfredUrl: 'http://localhost:3000', project: 'odeysys', cycleId: 'e8fe', cycleName: 'Performance',
      card: { number: 35, kind: 'BUG', status: 'INBOX', title: 'pax-details', waiting: { who: 'CLAUDE', since: '2026-10-14T02:11:00Z', setBy: 'USER' } },
      lastUserWord: '  move it\n to todo ',
    })).toBe('/alfred-sync 35\nAlfred: http://localhost:3000 · project odeysys · cycle "Performance" (e8fe)\nCard #35 BUG Inbox "pax-details"\n'
      + 'Waiting on Claude since 2026-10-14 02:11\nThe user\'s last word on it: "move it to todo"');
    expect(skillPrompt({ command: '/alfred-status', alfredUrl: 'http://a', project: '' })).toBe('/alfred-status\nAlfred: http://a · project No project');
  });

  it('a shell line survives quotes, $ and backticks', () => {
    expect(shellLine('/alfred-fix 1\nsay "hi" $HOME `x`')).toBe('claude -p "/alfred-fix 1\nsay \\"hi\\" \\$HOME \\`x\\`"');
  });

  it('usually-takes is rounded for a hint', () => {
    expect(usualText(38_000)).toBe('~40 s');
    expect(usualText(95_000)).toBe('~2 min');
    expect(usualText(null)).toBeNull();
    expect(skillOf(' /alfred-fix 35 ')).toBe('/alfred-fix');
  });

  it('a failure says what came of it; the start steps name the cycle and the repo', () => {
    const r = { failure: 'error', outcome: 'the repo has uncommitted changes' } as unknown as SkillRun;
    expect(failureHint(r)).toBe('the chat could not run it: the repo has uncommitted changes');
    expect(failureHint({ ...r, failure: 'lost' })).toContain('stopped before');
    expect(startSteps('cy1', 'C:/work/odeysys')).toEqual({ cd: 'cd "C:/work/odeysys"', live: '/alfred-live cy1', listen: '/alfred-listen cy1' });
    expect(startSteps('cy1', null).cd).toContain("the app's repo");
  });
});
