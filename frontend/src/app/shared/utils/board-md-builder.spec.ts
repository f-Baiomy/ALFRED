import { ActivityEntry, CardDetail } from '../../core/models/board.models';
import { BoardExport } from './board-json';
import { buildBoardHtmlParts } from './board-html-builder';
import { buildBoardMarkdownLines } from './board-md-builder';

const EVIL = '<script>alert("x")</script>';

const card: CardDetail = {
  id: 'k1', project: 'odeysys', number: 7, kind: 'BUG', title: `Discount ${EVIL}`, description: `desc ${EVIL} @[call:in:a|POST /orders]`,
  status: 'CLOSED', resolution: 'NOT_IN_FLOW', reason: `reason ${EVIL}`, flags: ['URGENT', 'AFFECTS_PROJECT'], scope: 'OUT_OF_SCOPE',
  author: 'CLAUDE', cycleId: 'cy1', cycleDeleted: true, signature: null, createdAt: '2026-10-01T10:00:00Z', updatedAt: '2026-10-02T10:00:00Z',
  updatedBy: 'USER', commentCount: 1, similarClosed: null, links: [{ type: 'CALL', ref: 'in:a', label: 'POST /orders' }],
};

const activity: ActivityEntry[] = [
  { id: 1, cardId: 'k1', actor: 'USER', kind: 'CREATED', text: null, oldValue: null, newValue: 'INBOX', at: '2026-10-01T10:00:00Z' },
  { id: 2, cardId: 'k1', actor: 'CLAUDE', kind: 'COMMENT', text: `**Did** read ${EVIL}\n\n**Found** NULL\n\n**Next** rerun`, oldValue: null,
    newValue: null, at: '2026-10-01T10:05:00Z' },
  { id: 3, cardId: 'k1', actor: 'USER', kind: 'STATUS', text: null, oldValue: 'INBOX', newValue: 'CLOSED', at: '2026-10-01T10:06:00Z' },
];

const data: BoardExport = {
  project: 'odeysys', cards: [card], activity: { k1: activity },
  briefs: [{ cycleId: 'cy1', text: `brief ${EVIL}`, updatedAt: '2026-10-01T09:00:00Z' }],
  specs: [{ cycleId: 'cy1', name: 'spec.md', content: `## Acceptance\n- ${EVIL}`, uploadedAt: '2026-10-01T09:00:00Z' }],
  marks: [{ cycleId: 'cy1', fileName: 'spec.md', itemKey: 'abcdef0123456789', mark: 'PASS', actor: 'USER', evidence: 'ok', history: [],
    updatedAt: '2026-10-01T11:00:00Z' }],
};

describe('board markdown export', () => {
  it('holds every field, the Linked list, the whole history, the brief and the spec in full', () => {
    const md = buildBoardMarkdownLines(data, 'Board - odeysys').join('\n');
    for (const piece of [card.title, card.description, `reason ${EVIL}`, 'Urgent, Affects project', 'Not in this flow', 'Out of scope',
      '(deleted)', 'in:a', '**DID** read', 'You moved Inbox → Closed', `brief ${EVIL}`, `- ${EVIL}`, 'Pass']) {
      expect(md).withContext(piece).toContain(piece);
    }
  });
});

describe('board html export', () => {
  it('escapes every value so nothing from a card runs in the reader\'s browser', () => {
    const html = buildBoardHtmlParts(data, `Board ${EVIL}`).join('');
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
    for (const piece of ['Discount', 'Not in this flow', 'POST /orders', 'rerun', 'brief', 'Acceptance', 'Pass']) {
      expect(html).withContext(piece).toContain(piece);
    }
  });
});
