import {
  captureValueFor,
  collectAtPath,
  maskText,
  parseCapturePath,
  parseCookieHeader,
  parseSetCookieHeader,
  shapeOf,
  LOOKS_SECRET,
} from './capture-preview';

describe('parseCapturePath', () => {
  it('splits dotted names', () => {
    expect(parseCapturePath('supplier')).toEqual(['supplier']);
    expect(parseCapturePath('searchCriteria.origin')).toEqual(['searchCriteria', 'origin']);
  });

  it('reads an index', () => {
    expect(parseCapturePath('searchCriteria[0].origin')).toEqual(['searchCriteria', 0, 'origin']);
  });

  it('reads a wildcard', () => {
    expect(parseCapturePath('items[*].code')).toEqual(['items', '*', 'code']);
  });

  it('reads a negative index', () => {
    expect(parseCapturePath('items[-1]')).toEqual(['items', -1]);
  });

  it('reads chained brackets', () => {
    expect(parseCapturePath('a[0][1]')).toEqual(['a', 0, 1]);
  });

  it('ignores empty segments', () => {
    expect(parseCapturePath('')).toEqual([]);
    expect(parseCapturePath(null)).toEqual([]);
    expect(parseCapturePath('a..b')).toEqual(['a', 'b']);
  });

  it('drops a non-numeric, non-wildcard index', () => {
    expect(parseCapturePath('a[x]')).toEqual(['a']);
  });
});

describe('collectAtPath', () => {
  it('returns the node itself with no segments', () => {
    expect(collectAtPath({ a: 1 }, [])).toEqual([{ a: 1 }]);
  });

  it('reads a plain field', () => {
    expect(collectAtPath({ supplier: 'ACME' }, ['supplier'])).toEqual(['ACME']);
  });

  it('reads an index', () => {
    expect(collectAtPath({ a: [{ b: 1 }, { b: 2 }] }, ['a', 0, 'b'])).toEqual([1]);
  });

  it('reads a negative index', () => {
    expect(collectAtPath({ a: [1, 2, 3] }, ['a', -1])).toEqual([3]);
  });

  it('a wildcard flattens every item, even one item', () => {
    expect(collectAtPath({ items: [{ code: 1 }] }, ['items', '*', 'code'])).toEqual([1]);
    expect(collectAtPath({ items: [{ code: 1 }, { code: 2 }] }, ['items', '*', 'code'])).toEqual([1, 2]);
  });

  it('a wildcard over a non-list is empty', () => {
    expect(collectAtPath({ items: {} }, ['items', '*'])).toEqual([]);
  });

  it('an out-of-range index is empty', () => {
    expect(collectAtPath({ a: [1] }, ['a', 5])).toEqual([]);
    expect(collectAtPath({ a: [1] }, ['a', -5])).toEqual([]);
  });

  it('a missing key is empty, not an error', () => {
    expect(collectAtPath({ a: 1 }, ['missing', 'field'])).toEqual([]);
  });

  it('indexing into a non-list is empty', () => {
    expect(collectAtPath({ a: { b: 1 } }, ['a', 0])).toEqual([]);
  });

  it('null is a found value', () => {
    expect(collectAtPath({ x: null }, ['x'])).toEqual([null]);
  });
});

describe('captureValueFor - JSON_FIELD', () => {
  it('captures a plain field from the request body', () => {
    const out = captureValueFor({ body: '{"supplier":"ACME"}' }, 'JSON_FIELD', 'supplier', 'request');
    expect(out).toEqual({ found: true, value: 'ACME' });
  });

  it('is not found on a missing path', () => {
    const out = captureValueFor({ body: '{}' }, 'JSON_FIELD', 'missing', 'request');
    expect(out).toEqual({ found: false, value: null });
  });

  it('null is a found value', () => {
    const out = captureValueFor({ body: '{"x":null}' }, 'JSON_FIELD', 'x', 'request');
    expect(out).toEqual({ found: true, value: null });
  });

  it('a [*] path returns an array even for one match', () => {
    const out = captureValueFor({ body: '{"items":[{"code":1}]}' }, 'JSON_FIELD', 'items[*].code', 'response');
    expect(out).toEqual({ found: true, value: [1] });
  });

  it('a [*] path with several matches preserves JSON types', () => {
    const out = captureValueFor({ body: '{"items":[{"code":1},{"code":2}]}' }, 'JSON_FIELD', 'items[*].code', 'response');
    expect(out).toEqual({ found: true, value: [1, 2] });
  });

  it('a non-JSON body is not found', () => {
    const out = captureValueFor({ body: 'not json' }, 'JSON_FIELD', 'x', 'request');
    expect(out).toEqual({ found: false, value: null });
  });

  it('no body at all is not found', () => {
    const out = captureValueFor({}, 'JSON_FIELD', 'x', 'request');
    expect(out).toEqual({ found: false, value: null });
  });
});

describe('captureValueFor - HEADER', () => {
  it('is case-insensitive', () => {
    const out = captureValueFor({ headers: { 'X-Source': 'secret' } }, 'HEADER', 'x-source', 'request');
    expect(out).toEqual({ found: true, value: 'secret' });
  });

  it('is not found when absent', () => {
    const out = captureValueFor({ headers: {} }, 'HEADER', 'X-Source', 'request');
    expect(out).toEqual({ found: false, value: null });
  });

  it('reads the response half in the response phase', () => {
    const out = captureValueFor({ headers: { 'X-Session': 'abc' } }, 'HEADER', 'X-Session', 'response');
    expect(out).toEqual({ found: true, value: 'abc' });
  });
});

describe('captureValueFor - COOKIE', () => {
  it('reads a request cookie', () => {
    const out = captureValueFor({ headers: { Cookie: 'session=a1; consent=yes' } }, 'COOKIE', 'session', 'request');
    expect(out).toEqual({ found: true, value: 'a1' });
  });

  it('first occurrence wins for a duplicated cookie name', () => {
    const out = captureValueFor({ headers: { Cookie: 'a=1; a=2' } }, 'COOKIE', 'a', 'request');
    expect(out).toEqual({ found: true, value: '1' });
  });

  it('is not found when the request cookie is absent', () => {
    const out = captureValueFor({ headers: { Cookie: 'consent=yes' } }, 'COOKIE', 'session', 'request');
    expect(out).toEqual({ found: false, value: null });
  });

  it('reads a Set-Cookie in the response phase, ignoring its attributes', () => {
    const out = captureValueFor({ headers: { 'Set-Cookie': 'sid=abc; Path=/' } }, 'COOKIE', 'sid', 'response');
    expect(out).toEqual({ found: true, value: 'abc' });
  });

  it('a request cookie is not read from Set-Cookie, and vice versa', () => {
    expect(captureValueFor({ headers: { 'Set-Cookie': 'sid=abc' } }, 'COOKIE', 'sid', 'request')).toEqual({ found: false, value: null });
    expect(captureValueFor({ headers: { Cookie: 'sid=abc' } }, 'COOKIE', 'sid', 'response')).toEqual({ found: false, value: null });
  });
});

describe('parseCookieHeader / parseSetCookieHeader', () => {
  it('parses several request cookies', () => {
    expect(parseCookieHeader('session=a1; consent=yes; theme=dark')).toEqual({ session: 'a1', consent: 'yes', theme: 'dark' });
  });

  it('parses a Set-Cookie, dropping its attributes', () => {
    expect(parseSetCookieHeader('sid=abc; Path=/; HttpOnly; Secure')).toEqual({ sid: 'abc' });
  });

  it('empty input is an empty map', () => {
    expect(parseCookieHeader(null)).toEqual({});
    expect(parseSetCookieHeader(undefined)).toEqual({});
  });
});

describe('shapeOf', () => {
  it('reports text length', () => expect(shapeOf('hello')).toEqual({ type: 'text', length: 5 }));
  it('reports list length', () => expect(shapeOf([1, 2, 3])).toEqual({ type: 'list', length: 3 }));
  it('reports object key count', () => expect(shapeOf({ a: 1, b: 2 })).toEqual({ type: 'object', length: 2 }));
  it('a number has no length', () => expect(shapeOf(5)).toEqual({ type: 'number', length: null }));
  it('null has no length', () => expect(shapeOf(null)).toEqual({ type: 'null', length: null }));
});

describe('LOOKS_SECRET', () => {
  it('matches token/session/auth/key/password/secret, case-insensitively', () => {
    for (const name of ['token', 'sessionId', 'Authorization', 'apiKey', 'password', 'clientSecret']) {
      expect(LOOKS_SECRET.test(name)).toBe(true);
    }
  });

  it('does not match an unrelated name', () => {
    expect(LOOKS_SECRET.test('supplier')).toBe(false);
  });
});

describe('maskText', () => {
  it('masks with the same length, capped at 12', () => {
    expect(maskText('abc')).toBe('•••');
    expect(maskText('x'.repeat(40)).length).toBe(12);
  });

  it('never returns empty', () => {
    expect(maskText('')).toBe('•');
  });
});
