import { BoardSummary } from '../../core/models/board.models';
import { groupCyclesByBoard } from './cycle-groups';

function board(id: string, name: string, cycleIds: string[], isDefault = false): BoardSummary {
  return {
    board: { id, project: 'odeysys', name, isDefault, state: 'OPEN', migratedFrom: null, createdAt: '', updatedAt: '' },
    cards: 0, cycleIds, boardIds: [], linkedItem: null,
  };
}

describe('groupCyclesByBoard', () => {
  const cycles = [{ id: 'c1' }, { id: 'c2' }, { id: 'c3' }, { id: 'c4' }];

  it('puts a cycle under every board it is on and names the others', () => {
    const groups = groupCyclesByBoard(cycles, [
      board('b-s42', 'Sprint 42', ['c1', 'c3']),
      board('b-ref', 'Refund', ['c1', 'c2']),
      board('default:odeysys', 'odeysys', ['c4'], true),
    ]);
    expect(groups.map((g) => g.board?.board.name ?? null)).toEqual(['odeysys', 'Refund', 'Sprint 42']);
    expect(groups[1].cycles.map((c) => c.id)).toEqual(['c1', 'c2']);
    expect(groups[1].alsoOn.get('c1')).toEqual(['Sprint 42']);
    expect(groups[2].alsoOn.get('c1')).toEqual(['Refund']);
    expect(groups[2].alsoOn.get('c3')).toEqual([]);
  });

  it('lists cycles on no board last and leaves out boards without cycles', () => {
    const groups = groupCyclesByBoard(cycles, [board('b-ref', 'Refund', ['c2']), board('b-empty', 'Empty', [])]);
    expect(groups.map((g) => g.board?.board.id ?? null)).toEqual(['b-ref', null]);
    expect(groups[1].cycles.map((c) => c.id)).toEqual(['c1', 'c3', 'c4']);
  });
});
