import { ChatSummary } from '../../core/models/chat.models';
import { BarInput, BarRow, barRows, barSections, shouldNotify, totalUnread } from './chat-bar';

function summary(scope: string, over: Partial<ChatSummary> = {}): ChatSummary {
  return { scope, name: scope, kind: scope === 'project' ? 'project' : 'cycle', lastId: null, lastAt: null, lastPreview: '', lastAuthor: null,
    waiting: 0, typing: false, needsYou: { questions: 0, proposals: 0, confirms: 0 }, claudeOn: false, terminal: null, ...over } as ChatSummary;
}

function input(over: Partial<BarInput> = {}): BarInput {
  return { project: 'odeysys', summaries: [], inView: null, seen: {}, mute: {}, names: new Map(), hasDraft: () => false,
    unreadIn: () => 1, ...over };
}

describe('chat-bar', () => {
  it('puts the project chat first, then the cycles newest first, named by their cycle', () => {
    const rows = barRows(input({
      summaries: [summary('c1', { lastId: 5 }), summary('project', { lastId: 1 }), summary('c2', { lastId: 9 })],
      names: new Map([['c1', 'order-flow']]),
    }));
    expect(rows.map((r) => r.label)).toEqual(['odeysys', 'c2', 'order-flow']);
    expect(barRows(input({ project: '', summaries: [summary('project')] }))[0].label).toBe('No project');
  });

  it('gives the cycle in view a row before its chat has a message', () => {
    expect(barRows(input({ inView: 'c7' })).map((r) => r.scope)).toEqual(['c7']);
    expect(barRows(input({ inView: 'c7', summaries: [summary('c7', { lastId: 3 })] }))).toHaveSize(1);
  });

  it('counts unread only after the last seen message and only when the last word is not the user\'s', () => {
    const rows = barRows(input({
      summaries: [summary('c1', { lastId: 9, lastAuthor: 'CLAUDE' }), summary('c2', { lastId: 9, lastAuthor: 'USER' }),
        summary('c3', { lastId: 4, lastAuthor: 'CLAUDE' })],
      seen: { 'odeysys/c3': 4 },
      unreadIn: (scope) => (scope === 'c1' ? 3 : 0),
    }));
    const by = new Map(rows.map((r) => [r.scope, r.unread]));
    expect(by.get('c1')).toBe(3);
    expect(by.get('c2')).toBe(0);
    expect(by.get('c3')).toBe(0);
    // A chat not loaded yet still shows that something is new.
    expect(barRows(input({ summaries: [summary('c1', { lastId: 9, lastAuthor: 'ALFRED' })], unreadIn: () => 0 }))[0].unread).toBe(1);
  });

  it('marks drafts and mute per project and chat, and leaves muted chats out of the badge', () => {
    const rows = barRows(input({
      summaries: [summary('c1', { lastId: 9, lastAuthor: 'CLAUDE' }), summary('c2', { lastId: 8, lastAuthor: 'CLAUDE' })],
      hasDraft: (key) => key === 'odeysys/c2',
      mute: { 'odeysys/c1': 'none' },
      unreadIn: () => 2,
    }));
    expect(rows.map((r) => [r.scope, r.draft, r.mute])).toEqual([['c1', false, 'none'], ['c2', true, 'all']]);
    expect(totalUnread(rows)).toBe(2);
  });

  it('lists chats waiting on the user once, on top, and finds a chat by name or id', () => {
    const rows: BarRow[] = barRows(input({
      summaries: [summary('project'), summary('c1', { lastId: 2, needsYou: { questions: 1, proposals: 0, confirms: 0 } }), summary('c2', { lastId: 1 })],
      names: new Map([['c1', 'Order flow'], ['c2', 'Checkout']]),
    }));
    const all = barSections(rows, '');
    expect(all.needs.map((r) => r.scope)).toEqual(['c1']);
    expect(all.sections.map((s) => [s.label, s.rows.map((r) => r.scope)])).toEqual([['Project', ['project']], ['Cycles', ['c2']]]);
    expect(barSections(rows, ' order ').needs.map((r) => r.scope)).toEqual(['c1']);
    expect(barSections(rows, 'c2').sections[1].rows.map((r) => r.label)).toEqual(['Checkout']);
    expect(barSections(rows, 'nothing').sections.every((s) => s.rows.length === 0)).toBeTrue();
  });

  it('notifies per chat level: every reply, only questions and failures, or never', () => {
    const row = (mute: BarRow['mute'], over: Partial<ChatSummary> = {}): BarRow =>
      barRows(input({ summaries: [summary('c1', { lastId: 3, lastAuthor: 'CLAUDE', lastPreview: 'done', ...over })], mute: { 'odeysys/c1': mute } }))[0];
    expect(shouldNotify(row('all'), 0)).toBeTrue();
    expect(shouldNotify(row('none'), 0)).toBeFalse();
    expect(shouldNotify(row('questions'), 0)).toBeFalse();
    expect(shouldNotify(row('questions', { needsYou: { questions: 1, proposals: 0, confirms: 0 } }), 0)).toBeTrue();
    expect(shouldNotify(row('questions', { needsYou: { questions: 1, proposals: 0, confirms: 0 } }), 1)).toBeFalse();
    expect(shouldNotify(row('questions', { lastAuthor: 'ALFRED', lastPreview: 'Claude could not answer: timeout - ask again' }), 0)).toBeTrue();
    expect(shouldNotify(row('all', { lastAuthor: 'USER' }), 0)).toBeFalse();
  });
});
