import { formatChecks, parseCheck, parseChecks } from './evidence-syntax';

describe('evidence-syntax (specs/018)', () => {
  it('reads every kind of check and writes it back the same', () => {
    const text = 'shape $.branch* list\nwhen $.branch* list>=2\nmatch $.payload branch* in $.branch*\nrows $.payload\nrows $.payload 3\nstatus 2xx';
    const { checks, error } = parseChecks(text);
    expect(error).toBeNull();
    expect(checks.map((c) => c.kind)).toEqual(['REQUEST_SHAPE', 'REQUEST_WHEN', 'ROWS_MATCH_FILTER', 'ROWS_PRESENT', 'ROWS_PRESENT', 'STATUS']);
    expect(checks[2]).toEqual({ kind: 'ROWS_MATCH_FILTER', rows: '$.payload', field: 'branch*', path: '$.branch*' });
    expect(checks[4]).toEqual({ kind: 'ROWS_PRESENT', rows: '$.payload', min: 3 });
    expect(formatChecks(checks)).toBe(text);
  });

  it('says what is wrong with a line', () => {
    expect(parseCheck('shape $.branch* list>=2')).toContain('the shape is one of list, scalar, present');
    expect(parseCheck('when branch none')).toContain('when <request path>');
    expect(parseCheck('match $.payload branch* $.branch*')).toContain('match <response list>');
    expect(parseCheck('rows $.payload 0')).toContain('min is a whole number');
    expect(parseCheck('status ok')).toContain('status <2xx');
    expect(parseCheck('branch must be a list')).toContain('starts with shape, when, match, rows or status');
    expect(parseChecks('shape $.a list\n\nbogus').error).toContain('"bogus"');
  });
});
