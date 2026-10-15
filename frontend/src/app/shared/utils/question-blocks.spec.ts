import { ActivityEntry } from '../../core/models/board.models';
import { allAnswered, askBlock, answersBlock, questionLines, withoutBlocks } from './question-blocks';
import { historyThreads } from './board-threads';

function entry(id: number, text: string, actor: 'USER' | 'CLAUDE' = 'CLAUDE', replyTo: number | null = null): ActivityEntry {
  return { id, cardId: 'k', actor, kind: 'COMMENT', text, oldValue: null, newValue: null, at: '2026-10-11T00:00:00Z', replyTo };
}

const ASK = '**Question** Keep?\n\n```questions\n' + JSON.stringify({ about: 2, questions: [
  { header: 'Steps', question: 'Keep?', options: [{ label: 'Keep', recommended: true }, { label: 'Rewrite', followUp: { header: 'Plan', question: 'Which?' } }] },
  { header: 'Checks', question: 'Which checks?' },
] }, null, 2) + '\n```';

function answer(id: number, json: object): ActivityEntry {
  return entry(id, `**Answers** …\n\n\`\`\`answers\n${JSON.stringify(json, null, 2)}\n\`\`\``, 'USER', 1);
}

describe('question-blocks (specs/019)', () => {
  it('reads the questions block and the answers block; withoutBlocks leaves the words', () => {
    expect(askBlock(ASK)?.about).toBe(2);
    expect(askBlock(ASK)?.questions.map((q) => q.header)).toEqual(['Steps', 'Checks']);
    expect(askBlock('**Question** plain?')).toBeNull();
    expect(askBlock('**Question** x\n\n```questions\n{not json\n```')).toBeNull();
    expect(answersBlock(answer(2, { Steps: { chose: ['Keep'], note: 'n' } }).text)).toEqual({ Steps: { chose: ['Keep'], other: undefined, note: 'n', later: undefined } });
    expect(withoutBlocks(ASK)).toBe('**Question** Keep?');
  });

  it('the thread shows each question\'s state from the replies; a follow-up once its option was picked', () => {
    const q = entry(1, ASK);
    expect(questionLines(q, [])!.map((l) => `${l.header}:${l.state}`)).toEqual(['Steps:open', 'Checks:open']);
    const lines = questionLines(q, [answer(2, { Steps: { chose: ['Rewrite'] }, Checks: { later: '2026-10-12T00:00:00Z' } })])!;
    expect(lines.map((l) => `${l.header}:${l.state}`)).toEqual(['Steps:answered', 'Plan:open', 'Checks:later']);
    expect(lines[0].options.find((o) => o.picked)?.label).toBe('Rewrite');
    const withdrawn = questionLines(q, [entry(3, '**Withdrawn** Checks - the SQL settles it', 'CLAUDE', 1)])!;
    expect(withdrawn.find((l) => l.header === 'Checks')!.state).toBe('withdrawn');
  });

  it('a question with options is answered only when every question is - one answer of two leaves it open', () => {
    const q = entry(1, ASK);
    const partial = [q, answer(2, { Steps: { chose: ['Keep'] } })];
    expect(allAnswered(q, partial.slice(1))).toBeFalse();
    expect(historyThreads(partial)[0].answered).toBeFalse();
    const whole = [...partial, answer(3, { Checks: { chose: [], other: 'SQL' } })];
    expect(historyThreads(whole)[0].answered).toBeTrue();
    // a plain question: any reply answers it
    expect(historyThreads([entry(1, '**Question** plain?'), entry(2, 'yes', 'USER', 1)])[0].answered).toBeTrue();
  });
});
