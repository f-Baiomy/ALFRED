import { CallVerdicts } from '../../core/models/board.models';
import { cellFor, columnsFor, rowsFor } from './cycle-verdicts';

const call = (id: string, boards: CallVerdicts['boards'], home: string | null = null): CallVerdicts => ({
  callId: id, method: 'POST', endpoint: '/x', status: 200, ms: 1, at: null, boards,
  cards: home ? [{ project: 'p', number: 1, title: 't', home }] : [],
});

describe('cycle-verdicts', () => {
  const a = call('a', [{ boardId: 'b1', name: 'Refund', items: [{ fileName: 's', key: 'k1', result: 'MEETS' }, { fileName: 's', key: 'k2', result: 'WRONG' }] }]);
  const b = call('b', [], 'b2');

  it('shows the worst result of a board and how many items spoke', () => {
    expect(cellFor(a, 'b1')).toEqual({ result: 'WRONG', items: 2, tone: 'bad', text: 'wrong ·2' });
    expect(cellFor(a, 'b2').tone).toBe('none');
  });

  it('filters rows to a board by its verdicts or its cards', () => {
    expect(rowsFor([a, b], null).length).toBe(2);
    expect(rowsFor([a, b], 'b1').map((c) => c.callId)).toEqual(['a']);
    expect(rowsFor([a, b], 'b2').map((c) => c.callId)).toEqual(['b']);
  });

  it('puts the asked board first', () => {
    const cols = [{ boardId: 'b1', name: 'A', items: [] }, { boardId: 'b2', name: 'B', items: [] }];
    expect(columnsFor(cols, 'b2').map((c) => c.boardId)).toEqual(['b2', 'b1']);
  });
});
