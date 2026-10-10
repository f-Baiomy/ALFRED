import { ActivityEntry, CardDetail, CardKind, CardStatus, Flag, Resolution } from '../../core/models/board.models';
import { BOARD_FORMAT, BoardExport, buildBoardJsonLines, parseBoardJsonLines } from './board-json';

/** A realistic card: a 1 MB description, every field set. Fixtures go through the exporter, never written by hand. */
function card(n: number, over: Partial<CardDetail> = {}): CardDetail {
  return {
    id: `id${n}`, project: 'odeysys', number: n, kind: 'BUG' as CardKind, title: `card ${n}`,
    description: `see @[call:in:c${n}|POST /orders · 500]\n${'x'.repeat(1024 * 1024)}`, status: 'CLOSED' as CardStatus,
    resolution: 'FINE' as Resolution, reason: 'expected: health needs no session', flags: ['URGENT', 'RISK'] as Flag[],
    scope: 'OUT_OF_SCOPE', author: 'CLAUDE', cycleId: 'cy1', cycleDeleted: false, signature: '4xx|GET /health', createdAt: '2026-10-01T10:00:00Z',
    updatedAt: '2026-10-02T10:00:00Z', updatedBy: 'USER', commentCount: 1, similarClosed: null,
    links: [{ type: 'CALL', ref: `in:c${n}`, label: 'POST /orders · 500' }, { type: 'CYCLE', ref: 'cy1', label: 'order-flow-3' }],
    ...over,
  };
}

function history(cardId: string, count: number): ActivityEntry[] {
  return Array.from({ length: count }, (_, i) => ({
    id: i + 1, cardId, actor: i % 2 ? 'CLAUDE' : 'USER', kind: i === 0 ? 'CREATED' : 'COMMENT',
    text: i === 0 ? null : `**Did** step ${i}\n\n**Found** @[stmt:c1/${i}|INSERT #${i}]\n\n**Next** more`, oldValue: null, newValue: i === 0 ? 'INBOX' : null,
    at: `2026-10-01T10:${String(i % 60).padStart(2, '0')}:00Z`,
  } as ActivityEntry));
}

describe('board .json export (alfred-board/1)', () => {
  const spec = '## Acceptance\n1. one\n' + 'y'.repeat(5 * 1024 * 1024 - 64);
  const data: BoardExport = {
    project: 'odeysys',
    cards: [card(1), card(2, { kind: 'NOTE', status: 'IN_PROGRESS', resolution: null, reason: null, flags: [], scope: 'IN_SCOPE' })],
    activity: { id1: history('id1', 200), id2: history('id2', 3) },
    briefs: [{ cycleId: 'cy1', text: 'what the cycle is for @[spec:cy1/spec.md|spec]', updatedAt: '2026-10-01T09:00:00Z' }],
    specs: [{ cycleId: 'cy1', name: 'spec.md', content: spec, uploadedAt: '2026-10-01T09:00:00Z' }],
    marks: [{ cycleId: 'cy1', fileName: 'spec.md', itemKey: 'abc', mark: 'FAIL', actor: 'USER', evidence: '@[stmt:c1/88|#88]', history: [],
      updatedAt: '2026-10-01T11:00:00Z' }],
  };

  it('round-trips every card field, every history entry and every spec byte - nothing shortened', () => {
    const lines = buildBoardJsonLines(data, '2026-10-10T00:00:00Z');
    expect(JSON.parse(lines[0]).format).toBe(BOARD_FORMAT);

    const back = parseBoardJsonLines(lines);

    expect(back.project).toBe('odeysys');
    expect(back.cards.length).toBe(2);
    expect(back.cards[0]['description']).toBe(data.cards[0].description);
    expect(back.cards[0]['reason']).toBe('expected: health needs no session');
    expect(back.cards[0]['flags']).toEqual(['URGENT', 'RISK']);
    expect(back.cards[0]['resolution']).toBe('FINE');
    expect(back.cards[0]['author']).toBe('CLAUDE');
    expect(back.activity.filter((a) => a.cardNumber === 1).length).toBe(200);
    expect(back.activity[199].entry['text']).toBe(data.activity['id1'][199].text);
    expect(back.specs[0].content).toBe(spec);
    expect(back.briefs[0]['text']).toBe(data.briefs[0].text);
    expect(back.marks[0]['evidence']).toBe('@[stmt:c1/88|#88]');
  });

  it('writes only the links no text holds - mentioned ones come back from the text', () => {
    const back = parseBoardJsonLines(buildBoardJsonLines(data));
    expect(back.cards[0].links).toEqual([{ type: 'cycle', ref: 'cy1', label: 'order-flow-3' }]);
  });

  it('is one record per line', () => {
    const lines = buildBoardJsonLines(data);
    expect(lines.every((l) => !l.includes('\n'))).toBeTrue();
    expect(lines.length).toBe(1 + 2 + 203 + 1 + 1 + 1);
  });

  it('refuses a file that is not a board export', () => {
    expect(() => parseBoardJsonLines(['{"format":"alfred-calls/3"}'])).toThrowError(SyntaxError);
  });
});
