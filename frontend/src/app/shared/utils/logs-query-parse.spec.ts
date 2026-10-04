import { highlightSegments, parseQuery, pillClass, pillText, samePill } from './logs-query-parse';

describe('logs-query-parse', () => {
  const fields = new Set(['level', 'statusCode', 'timeTaken', 'externalService', '@timestamp']);

  it('parses the query-bar grammar from contracts/log-query.md', () => {
    expect(parseQuery('level:ERROR', fields)).toEqual({ op: 'EQ', field: 'level', value: 'ERROR' });
    expect(parseQuery('-statusCode:200', fields)).toEqual({ op: 'NEQ', field: 'statusCode', value: '200' });
    expect(parseQuery('externalService:*', fields)).toEqual({ op: 'EXISTS', field: 'externalService' });
    expect(parseQuery('-externalService:*', fields)).toEqual({ op: 'NOT_EXISTS', field: 'externalService' });
    expect(parseQuery('timeTaken>6000', fields)).toEqual({ op: 'GT', field: 'timeTaken', value: '6000' });
    expect(parseQuery('timeTaken < 10', fields)).toEqual({ op: 'LT', field: 'timeTaken', value: '10' });
    expect(parseQuery('"Read timed out"', fields)).toEqual({ op: 'TEXT', value: 'Read timed out' });
    expect(parseQuery('anotrav', fields)).toEqual({ op: 'TEXT', value: 'anotrav' });
    expect(parseQuery('   ', fields)).toBeNull();
  });

  it('treats an unknown field as free text instead of a broken filter', () => {
    expect(parseQuery('nope:1', fields)).toEqual({ op: 'TEXT', value: 'nope:1' });
    expect(parseQuery('http://x:8080/a', fields)).toEqual({ op: 'TEXT', value: 'http://x:8080/a' });
  });

  it('labels and colours pills like the mock', () => {
    expect(pillText({ op: 'NEQ', field: 'statusCode', value: '200' })).toBe('statusCode ≠ 200');
    expect(pillText({ op: 'EXISTS', field: 'error' })).toBe('error exists');
    expect(pillText({ op: 'SELECTION', lineIds: ['a', 'b'] })).toBe('selection only (2)');
    // A recorded session's window; a session still recording runs to "now".
    expect(pillText({ op: 'INGESTED', from: '1000', to: '2000' }, (ms) => `t${ms}`)).toBe('recorded t1000 – t2000');
    expect(pillText({ op: 'INGESTED', from: '1000', to: null }, (ms) => `t${ms}`)).toBe('recorded t1000 – now');
    expect(pillClass({ op: 'NEQ', field: 'x', value: '1' })).toBe('lg-qp-neq');
    expect(pillClass({ op: 'BETWEEN', field: 't', from: '1', to: '2' })).toBe('lg-qp-range');
    expect(samePill({ op: 'EQ', field: 'a', value: '1' }, { op: 'EQ', field: 'a', value: '1' })).toBeTrue();
  });

  it('splits text around every term, case-insensitively', () => {
    expect(highlightSegments('email=evilanotravel@gmail.com', ['ANOTRAV'])).toEqual([
      { text: 'email=evil', hit: false },
      { text: 'anotrav', hit: true },
      { text: 'el@gmail.com', hit: false },
    ]);
    expect(highlightSegments('abc', [])).toEqual([{ text: 'abc', hit: false }]);
  });
});
