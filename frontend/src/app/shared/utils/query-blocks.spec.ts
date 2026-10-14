import { callRefsIn, parseShow, percentile, queryFields, rowsChart } from './query-blocks';
import { parseChart } from './board-visuals';

describe('query blocks', () => {
  it('reads key: value lines, ignoring comments and case of keys', () => {
    expect(queryFields('Endpoint: POST /fare\n# a note\nsince: fix\nshow: chart(ms)')).toEqual({ endpoint: 'POST /fare', since: 'fix', show: 'chart(ms)' });
  });

  it('finds the calls a text names, as mentions or bare refs', () => {
    expect(callRefsIn('@[call:in:a1|POST /x · 500]\n@[call:in:b2@c9|POST /x · 200]')).toEqual(['in:a1', 'in:b2@c9']);
    expect(callRefsIn('call: in:abc-1\nseq: 3')).toEqual(['in:abc-1']);
    expect(callRefsIn('nothing here')).toEqual([]);
  });

  it('reads show: as a table of fields or a chart, with friendly names, and says what is wrong', () => {
    expect(parseShow(undefined)).toEqual(jasmine.objectContaining({ kind: 'table', error: null }));
    expect(parseShow('table(status, ms, sql)').fields).toEqual(['status', 'durationMs', 'statements']);
    expect(parseShow('chart(ms, bar)')).toEqual(jasmine.objectContaining({ kind: 'chart', fields: ['durationMs'], chart: 'bar' }));
    expect(parseShow('chart').fields).toEqual(['durationMs']);
    expect(parseShow('table(colour)').error).toContain('"colour" is not a call field');
    expect(parseShow('pie').error).toContain('show is');
  });

  it('takes percentiles of what is known', () => {
    expect(percentile([5, 1, 3, NaN, 2, 4], 0.5)).toBe(3);
    expect(percentile([1, 2, 3, 4, 100], 0.95)).toBe(100);
    expect(percentile([], 0.5)).toBeNull();
  });

  it('turns rows into a chart the board draws, oldest first', () => {
    const rows = [{ at: '2026-10-14T10:02:00Z', durationMs: 610 }, { at: '2026-10-14T10:01:00Z', durationMs: 2400 }];
    const spec = parseChart(rowsChart(rows, parseShow('chart(ms)'), 'Fare'));
    expect(spec.error).toBeNull();
    expect(spec.model!.series[0].values).toEqual([2400, 610]);
    expect(spec.model!.unit).toBe('ms');
  });
});
