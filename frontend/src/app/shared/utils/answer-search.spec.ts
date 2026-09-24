import { CallRecord } from '../../core/models/call.model';
import {
  AnswerQuery,
  EMPTY_ANSWER_QUERY,
  formatAnswerQuery,
  hasClientFilters,
  matchesAnswerFilters,
  parseAnswerQuery,
  toServerSearch,
  toggleToken,
} from './answer-search';

function call(overrides: Partial<CallRecord> = {}): CallRecord {
  return {
    id: 'c1',
    original_url: 'https://api.supplier.com/v2/fares/quote?x=1',
    url: 'https://api.supplier.com/v2/fares/quote?x=1',
    method: 'POST',
    timestamp: '2026-09-24T10:00:00Z',
    duration_ms: 812,
    response: { status: 500 },
    ...overrides,
  };
}

const NOW = Date.parse('2026-09-24T10:05:00Z');

describe('parseAnswerQuery', () => {
  it('keeps plain words as free text', () => {
    expect(parseAnswerQuery('  fare  expired ')).toEqual({ ...EMPTY_ANSWER_QUERY, free: 'fare expired' });
  });

  it('reads every field token', () => {
    const q = parseAnswerQuery('quote host:api.supplier.com path:/v2/fares method:post status:5xx body:expired');
    expect(q).toEqual({
      free: 'quote',
      host: 'api.supplier.com',
      path: '/v2/fares',
      methods: ['POST'],
      statuses: ['5xx'],
      body: 'expired',
    });
  });

  it('treats url: as path:', () => {
    expect(parseAnswerQuery('url:/v2').path).toBe('/v2');
  });

  it('reads quoted values, for free text and for a field', () => {
    const q = parseAnswerQuery('"fare expired" body:"code 4012"');
    expect(q.free).toBe('fare expired');
    expect(q.body).toBe('code 4012');
  });

  it('collects repeated and comma-separated methods and statuses, without duplicates', () => {
    const q = parseAnswerQuery('method:GET method:post,GET status:4xx,404 status:FAILED');
    expect(q.methods).toEqual(['GET', 'POST']);
    expect(q.statuses).toEqual(['4xx', '404', 'failed']);
  });

  it('keeps an unknown key as free text rather than dropping what was typed', () => {
    expect(parseAnswerQuery('foo:bar').free).toBe('foo:bar');
  });

  it('keeps a status it cannot read as free text', () => {
    const q = parseAnswerQuery('status:weird');
    expect(q.statuses).toEqual([]);
    expect(q.free).toBe('status:weird');
  });
});

describe('formatAnswerQuery', () => {
  it('round-trips through parse', () => {
    const text = 'quote host:api.supplier.com path:/v2 method:GET,POST status:5xx body:"code 4012"';
    expect(formatAnswerQuery(parseAnswerQuery(text))).toBe(text);
  });
});

describe('toggleToken', () => {
  it('adds and then removes a method, leaving the rest of the text alone', () => {
    const once = toggleToken('fares status:5xx', 'methods', 'GET');
    expect(once).toBe('fares method:GET status:5xx');
    expect(toggleToken(once, 'methods', 'GET')).toBe('fares status:5xx');
  });
});

describe('toServerSearch', () => {
  it('prefers body, then free text, then path, then host', () => {
    const base: AnswerQuery = { ...EMPTY_ANSWER_QUERY, host: 'h', path: 'p', free: 'f', body: 'b' };
    expect(toServerSearch(base)).toBe('b');
    expect(toServerSearch({ ...base, body: null })).toBe('f');
    expect(toServerSearch({ ...base, body: null, free: '' })).toBe('p');
    expect(toServerSearch({ ...base, body: null, free: '', path: null })).toBe('h');
    expect(toServerSearch(EMPTY_ANSWER_QUERY)).toBe('');
  });
});

describe('hasClientFilters', () => {
  it('is false for plain text alone, which the server search covers completely', () => {
    expect(hasClientFilters(parseAnswerQuery('fares'), null)).toBeFalse();
    expect(hasClientFilters(parseAnswerQuery('body:fares'), null)).toBeFalse();
  });

  it('is true for any field the server cannot filter on, or a time window', () => {
    expect(hasClientFilters(parseAnswerQuery('method:GET'), null)).toBeTrue();
    expect(hasClientFilters(parseAnswerQuery('host:a'), null)).toBeTrue();
    expect(hasClientFilters(EMPTY_ANSWER_QUERY, 15)).toBeTrue();
    // Two text searches, only one of which the server can take.
    expect(hasClientFilters(parseAnswerQuery('fares body:expired'), null)).toBeTrue();
  });
});

describe('matchesAnswerFilters', () => {
  const match = (text: string, c: CallRecord = call(), windowMinutes: number | null = null) =>
    matchesAnswerFilters(c, parseAnswerQuery(text), windowMinutes, NOW);

  it('matches everything when nothing is set', () => {
    expect(match('')).toBeTrue();
  });

  it('matches the host as a substring, or a leading *. as a suffix like a rule does', () => {
    expect(match('host:supplier')).toBeTrue();
    expect(match('host:*.supplier.com')).toBeTrue();
    expect(match('host:*.other.com')).toBeFalse();
    expect(match('host:other')).toBeFalse();
  });

  it('matches the path and query string case-insensitively', () => {
    expect(match('path:/V2/FARES')).toBeTrue();
    expect(match('path:x=1')).toBeTrue();
    expect(match('path:/v3')).toBeFalse();
  });

  it('matches any of the listed methods', () => {
    expect(match('method:GET,POST')).toBeTrue();
    expect(match('method:GET')).toBeFalse();
  });

  it('matches a status class, an exact code, or failed', () => {
    expect(match('status:5xx')).toBeTrue();
    expect(match('status:500')).toBeTrue();
    expect(match('status:2xx')).toBeFalse();
    expect(match('status:failed')).toBeFalse();
    expect(match('status:failed', call({ response: undefined, error: 'timeout' }))).toBeTrue();
  });

  it('checks free text against method and URL only when the server search went to body', () => {
    expect(match('quote body:x')).toBeTrue();
    expect(match('nothing body:x')).toBeFalse();
    // Alone, free text is the server's job - it also searches headers and bodies, which a summary row does not have.
    expect(match('nothing')).toBeTrue();
  });

  it('keeps only calls inside the time window', () => {
    expect(match('', call(), 15)).toBeTrue();
    expect(match('', call(), 1)).toBeFalse();
  });
});
