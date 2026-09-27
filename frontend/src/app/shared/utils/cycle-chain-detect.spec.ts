import { CallRecord } from '../../core/models/call.model';
import { buildChainedDrafts, detectChains } from './cycle-chain-detect';

function call(overrides: Partial<CallRecord> & { id: string; url: string; method: string }): CallRecord {
  return {
    original_url: overrides.url,
    timestamp: '2026-01-01T00:00:00.000Z',
    duration_ms: 10,
    ...overrides,
  } as CallRecord;
}

describe('detectChains', () => {
  it('chains a login token from JSON into a later Authorization Bearer header', () => {
    const calls: CallRecord[] = [
      call({
        id: 'c1', method: 'POST', url: 'https://api.example.com/login',
        request: { headers: { 'content-type': 'application/json' }, body: '{"user":"a","pass":"b"}' },
        response: { status: 200, headers: { 'content-type': 'application/json' }, body: '{"accessToken":"abcdef1234567890"}' },
      }),
      call({
        id: 'c2', method: 'GET', url: 'https://api.example.com/profile',
        request: { headers: { authorization: 'Bearer abcdef1234567890' } },
        response: { status: 200, headers: {}, body: '{"name":"Ann"}' },
      }),
    ];
    const suggestions = detectChains(calls);
    const token = suggestions.find((s) => s.from.path === 'accessToken');
    expect(token).withContext(JSON.stringify(suggestions)).toBeTruthy();
    expect(token!.from.callIndex).toBe(0);
    expect(token!.from.kind).toBe('JSON');
    expect(token!.uses.some((u) => u.where === 'HEADER' && u.location.includes('Authorization'))).toBeTrue();
  });

  it('chains an id from a list response into a later URL path segment', () => {
    const calls: CallRecord[] = [
      call({
        id: 'c1', method: 'GET', url: 'https://api.example.com/bookings',
        request: { headers: {} },
        response: { status: 200, headers: {}, body: '{"bookings":[{"bookingId":"BK1029384756"}]}' },
      }),
      call({
        id: 'c2', method: 'GET', url: 'https://api.example.com/bookings/BK1029384756',
        request: { headers: {} },
        response: { status: 200, headers: {}, body: '{}' },
      }),
    ];
    const suggestions = detectChains(calls);
    const idSuggestion = suggestions.find((s) => s.from.path.includes('bookingId'));
    expect(idSuggestion).withContext(JSON.stringify(suggestions)).toBeTruthy();
    expect(idSuggestion!.uses.some((u) => u.where === 'URL_PATH')).toBeTrue();
  });

  it('ignores noise headers and short/static values', () => {
    const calls: CallRecord[] = [
      call({
        id: 'c1', method: 'GET', url: 'https://api.example.com/a?key=fixedApiKey123',
        request: { headers: { 'x-api-key': 'fixedApiKey123' } },
        response: { status: 200, headers: { 'content-length': '12345', date: 'Mon, 01 Jan 2026 00:00:00 GMT', etag: 'W/"abc123456"' }, body: '{"ok":true}' },
      }),
      call({
        id: 'c2', method: 'GET', url: 'https://api.example.com/b?key=fixedApiKey123',
        request: { headers: { 'x-api-key': 'fixedApiKey123' } },
        response: { status: 200, headers: {}, body: '{}' },
      }),
    ];
    const suggestions = detectChains(calls);
    // fixedApiKey123 was already in the FIRST call's own request, so it is static, not a chain.
    expect(suggestions.find((s) => s.uses.some((u) => u.location === 'key'))).toBeFalsy();
    // Noise headers never become sources.
    expect(suggestions.some((s) => s.from.kind === 'HEADER' && ['content-length', 'date', 'etag'].includes(s.from.path.toLowerCase()))).toBeFalse();
  });

  it('flags an echoed session cookie as "use current session" instead of extracting it', () => {
    const calls: CallRecord[] = [
      call({
        id: 'c1', method: 'POST', url: 'https://api.example.com/login',
        request: { headers: {} },
        response: { status: 200, headers: { 'set-cookie': 'JSESSIONID=9f8e7d6c5b4a3f2e1d0c; Path=/; HttpOnly' }, body: '{}' },
      }),
      call({
        id: 'c2', method: 'GET', url: 'https://api.example.com/profile',
        request: { headers: { cookie: 'JSESSIONID=9f8e7d6c5b4a3f2e1d0c' } },
        response: { status: 200, headers: {}, body: '{}' },
      }),
    ];
    const suggestions = detectChains(calls);
    const sessionSuggestion = suggestions.find((s) => s.useCurrentSession);
    expect(sessionSuggestion).withContext(JSON.stringify(suggestions)).toBeTruthy();
    expect(sessionSuggestion!.from.path.toLowerCase()).toBe('jsessionid');
    // Not double-reported as a normal chained value too.
    expect(suggestions.filter((s) => !s.useCurrentSession && s.uses.some((u) => u.where === 'COOKIE')).length).toBe(0);
  });

  it('caps work and never throws on an oversized cycle', () => {
    const calls: CallRecord[] = Array.from({ length: 600 }, (_, i) =>
      call({
        id: `c${i}`, method: 'GET', url: `https://api.example.com/x/${i}`,
        request: { headers: {} },
        response: { status: 200, headers: {}, body: JSON.stringify({ token: `value${i}00000000` }) },
      })
    );
    expect(() => detectChains(calls)).not.toThrow();
  });

  it('skips oversized bodies rather than freezing on them', () => {
    const bigBody = JSON.stringify({ token: 'a'.repeat(3 * 1024 * 1024) });
    const calls: CallRecord[] = [
      call({ id: 'c1', method: 'GET', url: 'https://api.example.com/a', request: { headers: {} }, response: { status: 200, headers: {}, body: bigBody } }),
      call({ id: 'c2', method: 'GET', url: 'https://api.example.com/b', request: { headers: {} }, response: { status: 200, headers: {}, body: '{}' } }),
    ];
    expect(() => detectChains(calls)).not.toThrow();
  });

  it('returns nothing for fewer than two calls', () => {
    expect(detectChains([])).toEqual([]);
    expect(detectChains([call({ id: 'c1', method: 'GET', url: 'https://a.com/x' })])).toEqual([]);
  });
});

describe('buildChainedDrafts', () => {
  const calls: CallRecord[] = [
    {
      id: 'c1', original_url: 'https://api.example.com/login', url: 'https://api.example.com/login', method: 'POST', timestamp: 't', duration_ms: 1,
      request: { headers: { 'content-type': 'application/json' }, body: '{"user":"a"}' },
      response: { status: 200, headers: {}, body: '{"accessToken":"abcdef1234567890"}' },
    } as CallRecord,
    {
      id: 'c2', original_url: 'https://api.example.com/profile', url: 'https://api.example.com/profile', method: 'GET', timestamp: 't', duration_ms: 1,
      request: { headers: { authorization: 'Bearer abcdef1234567890' } },
      response: { status: 200, headers: {}, body: '{}' },
    } as CallRecord,
  ];

  it('substitutes the value with {{this.<name>}} in later requests and attaches an ExtractRule to the source draft', () => {
    const suggestions = detectChains(calls);
    const names = new Set(suggestions.map((s) => s.name));
    const { drafts, groups } = buildChainedDrafts(calls, null, 'My cycle', suggestions, names);

    expect(Object.values(groups)[0].name).toBe('My cycle');
    expect(drafts.every((d) => d.groupId === Object.keys(groups)[0])).toBeTrue();

    const source = drafts[0] as ResendDraftWithExtract;
    expect(source.extract?.[0]?.as).toBe(suggestions[0].name);

    const useDraft = drafts[1];
    const authHeader = useDraft.headers.find((h) => h.name.toLowerCase() === 'authorization');
    expect(authHeader!.value).toBe(`Bearer {{this.${suggestions[0].name}}}`);
  });

  it('does nothing when no suggestion is accepted', () => {
    const suggestions = detectChains(calls);
    const { drafts } = buildChainedDrafts(calls, null, 'My cycle', suggestions, new Set());
    const useDraft = drafts[1];
    const authHeader = useDraft.headers.find((h) => h.name.toLowerCase() === 'authorization');
    expect(authHeader!.value).toBe('Bearer abcdef1234567890');
  });
});

interface ResendDraftWithExtract {
  extract?: { as: string }[];
}
