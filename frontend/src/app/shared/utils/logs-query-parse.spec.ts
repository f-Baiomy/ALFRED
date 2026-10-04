import { enterTakesSuggestion, highlightSegments, parseQuery, pillClass, pillText, samePill } from './logs-query-parse';

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

  it('reads any field name, including ones with spaces, slashes or colons, and unquotes values', () => {
    const odd = new Set(['level', 'first name', 'http/status', 'a:b', 'a']);
    expect(parseQuery('first name:Ann', odd)).toEqual({ op: 'EQ', field: 'first name', value: 'Ann' });
    expect(parseQuery('-http/status:500', odd)).toEqual({ op: 'NEQ', field: 'http/status', value: '500' });
    expect(parseQuery('a:b:c', odd)).toEqual({ op: 'EQ', field: 'a:b', value: 'c' }); // the longest known field wins
    expect(parseQuery('level:"API request"', odd)).toEqual({ op: 'EQ', field: 'level', value: 'API request' });
    expect(parseQuery('url:http://x:8080/a', new Set(['url']))).toEqual({ op: 'EQ', field: 'url', value: 'http://x:8080/a' });
    expect(parseQuery('levelx:1', odd)).toEqual({ op: 'TEXT', value: 'levelx:1' });
  });

  it('never turns an unfinished field filter into a text search', () => {
    expect(parseQuery('level:', fields)).toBeNull();
    expect(parseQuery('-level:', fields)).toBeNull();
    expect(parseQuery('nope:', fields)).toEqual({ op: 'TEXT', value: 'nope:' });
  });

  it('lets Enter take the highlighted suggestion only when it completes what was typed', () => {
    // level:E with level:ERROR highlighted (the reported bug: it searched level = E).
    expect(enterTakesSuggestion('level:E', 'level:ERROR', false)).toBeTrue();
    expect(enterTakesSuggestion('-level:e', '-level:ERROR', false)).toBeTrue();
    // level: with nothing typed yet: the highlighted value (or "exists").
    expect(enterTakesSuggestion('level:', 'level:ERROR', false)).toBeTrue();
    expect(enterTakesSuggestion('level:', 'level:*', false)).toBeTrue();
    // A typed value no suggestion starts with stays as typed; "exists" is never taken over a typed value.
    expect(enterTakesSuggestion('message:timeout', 'message:*', false)).toBeFalse();
    expect(enterTakesSuggestion('statusCode:2', 'statusCode:500', false)).toBeFalse();
    expect(enterTakesSuggestion('timeTaken>6000', 'timeTaken:', false)).toBeFalse();
    // A field name completes to "field:"; arrow keys always win.
    expect(enterTakesSuggestion('lev', 'level:', false)).toBeTrue();
    expect(enterTakesSuggestion('message:timeout', 'message:*', true)).toBeTrue();
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
