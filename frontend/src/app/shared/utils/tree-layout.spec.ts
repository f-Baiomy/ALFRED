import { BoardItem, BoardItemRow } from '../../core/team/team.models';
import { byType, layoutTree } from './tree-layout';

function it_(item: string, relation: string, depth: number, parent: string | null, extra: Partial<BoardItemRow> = {}): BoardItem {
  const row: BoardItemRow = { boardId: 'b', conn: 'c', item, role: relation === 'ROOT' ? 'MAIN' : 'REF', relation, linkKind: null, parent, depth,
    type: 'Task', title: 'T' + item, state: 'Active', stateCategory: 'InProgress', rev: 1, leftTreeAt: null, addedAt: null, addedBy: null, ...extra };
  return { row, hasCopy: row.role !== 'REF', copyRev: null, changed: false, cards: [] };
}

describe('layoutTree (specs/028 US2)', () => {
  const main = it_('10', 'ROOT', 0, null, { type: 'User Story' });
  const items = [
    it_('2', 'ANCESTOR', -1, '1', { type: 'Feature' }),
    it_('1', 'ANCESTOR', -2, null, { type: 'Epic' }),
    it_('12', 'DESCENDANT', 1, '10'),
    it_('11', 'DESCENDANT', 1, '10'),
    it_('13', 'DESCENDANT', 2, '11'),
    it_('20', 'LINK', 1, '10', { linkKind: 'Related' }),
    it_('30', 'ADDED', 0, null),
    it_('14', 'DESCENDANT', 1, '10', { leftTreeAt: '2026-10-01T00:00:00Z' }),
  ];

  it('puts ancestors above the main, descendants under their parents, then links, then the rest', () => {
    const lines = layoutTree(main, items);
    expect(lines.map((l) => `${l.item.row.item}:${l.indent}:${l.group}`)).toEqual([
      '1:0:tree', '2:1:tree', '10:2:tree', '11:3:tree', '13:4:tree', '12:3:tree', '20:3:link', '30:0:added', '14:0:added',
    ]);
  });

  it('lists each item once even when the main is also in the items', () => {
    const lines = layoutTree(main, [main, ...items]);
    expect(lines.filter((l) => l.item.row.item === '10').length).toBe(1);
  });

  it('with no main, everything is "added"', () => {
    expect(layoutTree(null, items).every((l) => l.group === 'added' && l.indent === 0)).toBeTrue();
  });

  it('groups by type with the main first', () => {
    const g = byType([items[2], main, it_('40', 'ADDED', 0, null, { type: 'User Story' })]);
    expect(g.map((x) => x.type)).toEqual(['Task', 'User Story']);
    expect(g[1].items[0].row.item).toBe('10');
  });
});
