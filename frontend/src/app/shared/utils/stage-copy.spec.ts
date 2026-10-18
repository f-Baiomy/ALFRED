import { BoardStage } from '../../core/models/board.models';
import { otherSteps, stepCopy, stepOf } from './stage-copy';

const counts = { brief: true, items: 12, inbox: 0, waitingOnUser: 0, toDo: 0, inProgress: 0, fixed: 0, untested: 0, failing: 0, unmarked: 0 };

function stage(s: Partial<BoardStage> & Pick<BoardStage, 'stage' | 'next'>): BoardStage {
  return { ref: 'AB#59851', counts, ...s };
}

describe('stage-copy', () => {
  // one case per BoardStage.of branch, as the backend sends it
  const cases: [BoardStage, string, string][] = [
    [stage({ stage: 'DEFINE', next: '/alfred-setup AB#59851 - …', step: { kind: 'CLAUDE', skill: 'alfred-setup', command: '/alfred-setup AB#59851', count: 0 } }), 'Define the task', 'define it'],
    [stage({ stage: 'DEFINE', next: '/alfred-spec AB#59851 - …', step: { kind: 'CLAUDE', skill: 'alfred-spec', command: '/alfred-spec AB#59851', count: 0 } }), 'Write the requirements', 'draft them'],
    [stage({ stage: 'TRIAGE', next: '/alfred-triage …', step: { kind: 'CLAUDE', skill: 'alfred-triage', command: '/alfred-triage AB#59851', count: 4 } }), 'Sort the 4 new cards', 'triage with me'],
    [stage({ stage: 'TRIAGE', next: 'Answer the 2 …', step: { kind: 'USER', skill: null, command: null, count: 2 } }), 'Answer the 2 questions waiting on you', 'answer'],
    [stage({ stage: 'CODE', next: 'Write the code …', step: { kind: 'CLAUDE', skill: 'alfred-fix', command: '/alfred-fix AB#59851', count: 2 } }), 'Fix the 2 To do cards', 'fix them'],
    [stage({ stage: 'VERIFY', next: '/alfred-verify …', counts: { ...counts, fixed: 2 }, step: { kind: 'CLAUDE', skill: 'alfred-verify', command: '/alfred-verify AB#59851', count: 2 } }), 'Check the 2 fixed cards', 'verify'],
    [stage({ stage: 'TEST', next: 'Press Record …', step: { kind: 'RECORD', skill: 'alfred-listen', command: '/alfred-listen AB#59851', count: 4 } }), 'Test it in the app', 'watch while I test'],
    [stage({ stage: 'VERIFY', next: '/alfred-verify … mark', step: { kind: 'CLAUDE', skill: 'alfred-verify', command: '/alfred-verify AB#59851', count: 1 } }), 'Mark the 1 remaining requirement', 'suggest the marks'],
    [stage({ stage: 'CLOSE', next: '/alfred-report …', step: { kind: 'CLAUDE', skill: 'alfred-report', command: '/alfred-report AB#59851', count: 0 } }), 'Close the task', 'write the close-out'],
  ];

  it('words every branch in plain language, with no command in the title or the sentence', () => {
    for (const [s, title, verb] of cases) {
      const c = stepCopy(s);
      expect(c.title).withContext(s.next).toBe(title);
      expect(c.verb).toBe(verb);
      expect(c.title + c.detail).not.toMatch(/\/alfred-/);
      expect(c.command).toBe(s.step!.command);
    }
  });

  it('reads an older Alfred without step from its next text', () => {
    expect(stepOf(stage({ stage: 'TRIAGE', next: '/alfred-triage AB#59851 - sort the 4 Inbox card(s): yours' })))
      .toEqual({ kind: 'CLAUDE', skill: 'alfred-triage', command: '/alfred-triage AB#59851', count: 4 });
    expect(stepOf(stage({ stage: 'TRIAGE', next: 'Answer the 2 question(s) and proposal(s) waiting on you' })).kind).toBe('USER');
    expect(stepOf(stage({ stage: 'TEST', next: 'Press Record (Cycles tab), then /alfred-listen AB#59851 and run - 4 item(s)' })).kind).toBe('RECORD');
    expect(stepOf(stage({ stage: 'CODE', next: 'Write the code for the 2 To do card(s), then /alfred-verify AB#59851' })).skill).toBe('alfred-fix');
  });

  it('treats an unknown kind as something for the user', () => {
    expect(stepCopy(stage({ stage: 'CLOSE', next: 'x', step: { kind: 'LATER', skill: null, command: null, count: 0 } })).kind).toBe('USER');
  });

  it('lists every step with its command for this board', () => {
    expect(otherSteps('AB#1').map((s) => s.command)).toContain('/alfred-triage AB#1');
    expect(otherSteps('AB#1').length).toBe(7);
  });
});
