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

  it('carries the brief comments, a thread before its replies, every field kept (specs/024)', () => {
    const c = { cycleId: 'cy1', quote: null, actor: 'USER' as const, asks: false, suggestFrom: null, suggestTo: null, resolvedAt: null, resolvedBy: null };
    const withComments: BoardExport = { ...data, briefComments: [
      { ...c, id: 9, replyTo: 7, actor: 'CLAUDE', text: 'Not yet', suggestFrom: 'is no longer', suggestTo: 'should not be', createdAt: '2026-10-01T10:01:00Z' },
      { ...c, id: 7, replyTo: null, quote: 'Branch is no longer required', text: 'Still true?', createdAt: '2026-10-01T10:00:00Z',
        resolvedAt: '2026-10-02T10:00:00Z', resolvedBy: 'USER' },
    ] };
    const back = parseBoardJsonLines(buildBoardJsonLines(withComments));
    expect(back.briefComments.map((r) => r['id'])).toEqual([7, 9]);
    expect(back.briefComments[0]).toEqual(jasmine.objectContaining({ quote: 'Branch is no longer required', resolvedBy: 'USER' }));
    expect(back.briefComments[1]).toEqual(jasmine.objectContaining({ replyTo: 7, actor: 'CLAUDE', suggestTo: 'should not be' }));
  });

  it('refuses a file that is not a board export', () => {
    expect(() => parseBoardJsonLines(['{"format":"alfred-calls/3"}'])).toThrowError(SyntaxError);
  });

  it('writes the boards, their relations, card homes and related cycles, and the work item snapshots (specs/027)', () => {
    const b = (id: string, isDefault = false) => ({ id, project: 'odeysys', name: id, isDefault, state: 'OPEN' as const, migratedFrom: null,
      createdAt: '2026-10-01T09:00:00Z', updatedAt: '2026-10-01T09:00:00Z' });
    const lines = buildBoardJsonLines({
      ...data,
      cards: [card(1, { boardId: 'b-refund' }), card(2)],
      boards: [
        { board: b('default:odeysys', true), cards: 1, cycleIds: [], boardIds: [], linkedItem: null },
        { board: b('b-refund'), cards: 1, cycleIds: ['cy1', 'cy2'], boardIds: ['b-sprint'], linkedItem: 'c1/7' },
        { board: b('b-sprint'), cards: 0, cycleIds: [], boardIds: ['b-refund'], linkedItem: null },
      ],
      cardCycles: { id1: ['cy9'] },
      workItems: [{ board: 'b-refund', conn: 'c1', extId: '7', provider: 'Azure DevOps', snapshot: { title: 'Refund', state: 'Active' } }],
    }, '2026-10-10T00:00:00Z');
    const records = lines.slice(1).map((l) => JSON.parse(l).record as string);
    expect(records.indexOf('board')).toBeGreaterThan(records.lastIndexOf('card'));
    expect(records.indexOf('board')).toBeLessThan(records.indexOf('brief'));
    const parsed = parseBoardJsonLines(lines);
    expect(parsed.cards[0]['boardId']).toBe('b-refund');
    expect(parsed.boards.map((x) => x['id'])).toEqual(['default:odeysys', 'b-refund', 'b-sprint']);
    expect(parsed.boardCycles).toEqual([{ boardId: 'b-refund', cycleId: 'cy1' }, { boardId: 'b-refund', cycleId: 'cy2' }]);
    expect(records.filter((r) => r === 'board-board').length).withContext('one record per related pair').toBe(1);
    expect(parsed.cardCycles).toEqual([{ cardNumber: 1, cycleId: 'cy9' }]);
    expect(parsed.workItems[0]['snapshot']).toEqual({ title: 'Refund', state: 'Active' });
  });

  it('writes the tracker side of each board whole - copies uncut, card links by card number - and the owners (specs/028)', () => {
    const copy = { rev: 4, itemJson: JSON.stringify({ extId: '101', description: 'x'.repeat(50_000) }), savedAt: '2026-10-01T09:00:00Z' };
    const lines = buildBoardJsonLines({
      ...data,
      cards: [card(1), card(2)],
      teamRecords: [
        { record: 'team-item', boardId: 'b-refund', conn: 'c1', item: '101', role: 'MAIN', relation: 'ROOT', copy },
        { record: 'team-card-link', cardId: 'id2', boardId: 'b-refund', conn: 'c1', item: '102' },
        { record: 'team-card-link', cardId: 'gone', boardId: 'b-refund', conn: 'c1', item: '103' },
        { record: 'team-watch-rule', boardId: 'b-refund', conn: 'c1', name: 'New refund bugs', queryJson: '{"text":"refund"}' },
      ],
      owners: { id1: 'c1/p-1|Sara Ali' },
    }, '2026-10-10T00:00:00Z');
    const parsed = parseBoardJsonLines(lines);
    const item = parsed.teamRecords.find((r) => r['record'] === 'team-item')!;
    expect((item['copy'] as { itemJson: string }).itemJson).toBe(copy.itemJson);
    const links = parsed.teamRecords.filter((r) => r['record'] === 'team-card-link');
    expect(links).withContext('a link to a card not in the file is left out').toEqual([
      { record: 'team-card-link', boardId: 'b-refund', conn: 'c1', item: '102', cardNumber: 2 }]);
    expect(parsed.teamRecords.find((r) => r['record'] === 'card-owner')).toEqual({ record: 'card-owner', cardNumber: 1, owner: 'c1/p-1|Sara Ali' });
    expect(parsed.teamRecords.some((r) => r['record'] === 'team-watch-rule')).toBeTrue();
  });
});
