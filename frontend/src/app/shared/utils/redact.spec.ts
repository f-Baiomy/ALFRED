import { CallRecord } from '../../core/models/call.model';
import { Redaction, RedactionKind, RedactionScope } from '../../core/models/redaction.model';
import { REDACTED, redactCall, redactCalls, redactSecrets, redactableNameOf, setSecretValues } from './redact';

const TOKEN = 'Bearer eyJhbGciOiJIUzI1NiJ9.SUPERSECRET';
const APIKEY = 'test_api_key_do_not_use_in_production';

function redaction(kind: RedactionKind, name: string, scope: RedactionScope = 'all', callId: string | null = null): Redaction {
  return { id: `${kind}:${name}`, scope, callId, kind, name, createdAt: '2026-01-01T00:00:00.000Z' };
}

function call(overrides: Partial<CallRecord> = {}): CallRecord {
  return {
    id: 'c1',
    original_url: 'http://localhost:9001/v1/search?credential=hunter2&page=1',
    url: 'https://api.example.com/v1/search?credential=hunter2&page=1',
    method: 'POST',
    request: { headers: { Accept: 'application/json', Authorization: TOKEN, 'x-api-key': APIKEY }, body: '{"q":"x"}' },
    timestamp: '2026-01-01T00:00:00.000Z',
    duration_ms: 10,
    response: {
      status: 200,
      headers: { 'content-type': 'application/json', 'set-cookie': 'sid=abc; HttpOnly' },
      body: JSON.stringify({ data: { access_token: 'at_live_9f2', nested: [{ access_token: 'at_live_aa' }] }, ok: true }),
    },
    ...overrides,
  };
}

/**
 * A call an interception rule touched carries a SECOND copy of both halves - that is the whole
 * point of the before/after record. Every secret in the fixture above appears again here.
 */
function intercepted(): CallRecord {
  const base = call();
  return {
    ...base,
    interception: {
      applied: [{ action: 'REPLACE_RESPONSE', detail: '500' }],
      originalRequest: {
        method: 'POST',
        url: base.url,
        headers: { Authorization: TOKEN, 'x-api-key': APIKEY },
        body: '{"q":"x"}',
      },
      finalRequest: {
        method: 'POST',
        url: base.url,
        headers: { Authorization: TOKEN, 'x-api-key': APIKEY, 'X-Alfred': 'on' },
        body: '{"q":"x"}',
      },
      originalResponse: {
        status: 200,
        headers: { 'set-cookie': 'sid=abc; HttpOnly' },
        body: JSON.stringify({ data: { access_token: 'at_live_9f2' } }),
      },
      finalResponse: { status: 500, headers: {}, body: '{"error":"Replaced by Alfred"}' },
    },
  };
}

describe('redactCall', () => {
  it('replaces a header value but keeps the header itself', () => {
    const { call: out, count } = redactCall(call(), [redaction('request-header', 'authorization')]);

    expect(out.request?.headers?.['Authorization']).toBe(REDACTED);
    // The fact that auth WAS sent is usually the diagnostically important part, so the key survives.
    expect(Object.keys(out.request?.headers ?? {})).toContain('Authorization');
    expect(out.request?.headers?.['Accept']).toBe('application/json');
    expect(count).toBe(1);
  });

  it('matches header names case-insensitively, since the wire casing is not the user\'s to predict', () => {
    const { call: out } = redactCall(call(), [redaction('request-header', 'AUTHORIZATION')]);

    expect(out.request?.headers?.['Authorization']).toBe(REDACTED);
  });

  it('redacts a response header without touching the request', () => {
    const { call: out } = redactCall(call(), [redaction('response-header', 'set-cookie')]);

    expect(out.response?.headers?.['set-cookie']).toBe(REDACTED);
    expect(out.request?.headers?.['Authorization']).toBe(TOKEN);
  });

  it('redacts a body key at every depth, including inside arrays', () => {
    const { call: out, count } = redactCall(call(), [redaction('response-body-key', 'access_token')]);
    const body = JSON.parse(out.response!.body!);

    expect(body.data.access_token).toBe(REDACTED);
    expect(body.data.nested[0].access_token).toBe(REDACTED);
    expect(body.ok).toBe(true);
    expect(count).toBe(2);
  });

  it('leaves the redacted body as valid JSON - the whole reason values are masked instead of lines blanked', () => {
    const { call: out } = redactCall(call(), [redaction('response-body-key', 'access_token')]);

    expect(() => JSON.parse(out.response!.body!)).not.toThrow();
  });

  it('redacts a query parameter in BOTH url and original_url', () => {
    const { call: out, count } = redactCall(call(), [redaction('url-param', 'credential')]);

    expect(out.url).toBe(`https://api.example.com/v1/search?credential=${REDACTED}&page=1`);
    // original_url is printed as the pre-proxy URL, so redacting only `url` leaves the secret one line up.
    expect(out.original_url).toBe(`http://localhost:9001/v1/search?credential=${REDACTED}&page=1`);
    expect(out.url).toContain('page=1');
    expect(count).toBe(2);
  });

  it('leaves a url with no query string alone', () => {
    const plain = call({ url: 'https://api.example.com/v1/search', original_url: 'http://localhost:9001/v1/search' });
    const { call: out, count } = redactCall(plain, [redaction('url-param', 'credential')]);

    expect(out.url).toBe('https://api.example.com/v1/search');
    expect(count).toBe(0);
  });

  it('does not reformat an untouched body, however large', () => {
    // Re-serializing for nothing would reformat a body the export promises to reproduce as it
    // crossed the wire - and cost a parse/stringify of megabytes per call to achieve it.
    const compact = '{"a":1,"b":[2,3]}';
    const c = call({ response: { status: 200, headers: {}, body: compact } });
    const { call: out } = redactCall(c, [redaction('response-body-key', 'nothing-matches')]);

    expect(out.response?.body).toBe(compact);
  });

  it('masks the same key in an XML body (a SOAP secret leaked into exports while only JSON was read)', () => {
    const c = call({ response: { status: 200, headers: {}, body: '<xml><token>abc</token></xml>' } });
    const { call: out, count } = redactCall(c, [redaction('response-body-key', 'token')]);

    expect(out.response?.body).toBe(`<xml><token>${REDACTED}</token></xml>`);
    expect(count).toBe(1);
  });

  it('leaves a body that is neither JSON, XML nor a form alone instead of throwing', () => {
    const c = call({ response: { status: 200, headers: {}, body: 'token abc, plain text' } });
    const { call: out, count } = redactCall(c, [redaction('response-body-key', 'token')]);

    expect(out.response?.body).toBe('token abc, plain text');
    expect(count).toBe(0);
  });

  it('returns the very same object when nothing applies, so an unredacted export costs nothing', () => {
    const input = call();

    expect(redactCall(input, []).call).toBe(input);
    expect(redactCall(input, [redaction('request-header', 'x-nothing')]).call).toBe(input);
  });

  describe('scope', () => {
    it('a call-scoped redaction touches only that call', () => {
      const only = redaction('request-header', 'authorization', 'call', 'c1');
      const other = call({ id: 'c2' });

      expect(redactCall(call(), [only]).call.request?.headers?.['Authorization']).toBe(REDACTED);
      expect(redactCall(other, [only]).call.request?.headers?.['Authorization']).toBe(TOKEN);
    });

    it('an all-scoped redaction covers every call - the point of the second click', () => {
      const every = redaction('request-header', 'authorization', 'all', null);
      const calls = [call({ id: 'c1' }), call({ id: 'c2' }), call({ id: 'c3' })];

      const { calls: out, redactedValueCount } = redactCalls(calls, [every]);

      expect(out.every((c) => c.request?.headers?.['Authorization'] === REDACTED)).toBeTrue();
      expect(redactedValueCount).toBe(3);
    });
  });
});

describe('redactCalls', () => {
  it('counts every value it replaced, which is what the export reports to its reader', () => {
    const { redactedValueCount } = redactCalls(
      [call()],
      [
        redaction('request-header', 'authorization'),
        redaction('request-header', 'x-api-key'),
        redaction('response-header', 'set-cookie'),
        redaction('response-body-key', 'access_token'),
        redaction('url-param', 'credential'),
      ]
    );

    // 1 auth + 1 api-key + 1 cookie + 2 access_token + 2 url (url and original_url)
    expect(redactedValueCount).toBe(7);
  });

  /**
   * The test this feature exists for. A redaction that masks the body but leaves the secret in a
   * header - or in original_url, or in a nested copy - is worse than no redaction at all, because
   * the user believes the file is safe to send.
   */
  it('leaves no trace of any redacted secret anywhere in the call', () => {
    const { calls } = redactCalls(
      // The intercepted variant deliberately, because it holds a second copy of both halves - a
      // redaction that masks `request.headers` and leaves the same token in
      // `interception.originalRequest.headers` has done nothing except mislead the user into
      // sending the file.
      [intercepted()],
      [
        redaction('request-header', 'authorization'),
        redaction('request-header', 'x-api-key'),
        redaction('response-header', 'set-cookie'),
        redaction('response-body-key', 'access_token'),
        redaction('url-param', 'credential'),
      ]
    );
    const serialized = JSON.stringify(calls);

    for (const secret of [TOKEN, APIKEY, 'hunter2', 'sid=abc', 'at_live_9f2', 'at_live_aa']) {
      expect(serialized).not.toContain(secret);
    }
  });

  it('masks every interception snapshot with the rule for the half it is a copy of', () => {
    const { call: out, count } = redactCall(intercepted(), [
      redaction('request-header', 'authorization'),
      redaction('response-header', 'set-cookie'),
    ]);

    expect(out.interception?.originalRequest?.headers?.['Authorization']).toBe(REDACTED);
    expect(out.interception?.finalRequest?.headers?.['Authorization']).toBe(REDACTED);
    expect(out.interception?.originalResponse?.headers?.['set-cookie']).toBe(REDACTED);
    // A request-header redaction must not reach into the response snapshot, and the rest of the
    // record is untouched.
    expect(out.interception?.finalRequest?.headers?.['x-api-key']).toBe(APIKEY);
    expect(out.interception?.applied.length).toBe(1);
    // Two in the call's own headers, plus every copy: authorization twice more (both request
    // snapshots) and set-cookie once more (the original response).
    expect(count).toBe(5);
  });

  it('keeps an untouched interception record byte-identical', () => {
    const original = intercepted();
    const { call: out } = redactCall(original, [redaction('request-header', 'nothing-matches-this')]);

    expect(out).toBe(original);
  });
});

describe('secret variable values (D6)', () => {
  afterEach(() => setSecretValues([]));

  it('masks a secret value wherever it appears, longest first, and counts it', () => {
    setSecretValues(['abcd', 'abcdefgh', 'x']);
    const call = {
      id: 'c1', url: 'https://h/p?k=abcdefgh', method: 'GET', timestamp: 't',
      request: { headers: { Authorization: 'Bearer abcdefgh' }, body: '{"a":"abcd"}' },
      resendEdits: { note: 'abcd' },
    } as unknown as CallRecord;
    const { call: out, count } = redactCall(call, []);
    expect(out.url).toBe('https://h/p?k=***REDACTED***');
    expect(out.request?.headers?.['Authorization']).toBe('Bearer ***REDACTED***');
    expect(out.request?.body).toBe('{"a":"***REDACTED***"}');
    expect((out.resendEdits as { note: string }).note).toBe('***REDACTED***');
    expect(count).toBe(4);
  });

  it('returns the same call when no secret occurs', () => {
    setSecretValues(['zzzz']);
    const call = { id: 'c1', url: 'u', method: 'GET', timestamp: 't' } as unknown as CallRecord;
    expect(redactCall(call, []).call).toBe(call);
  });

  it('redactSecrets masks free text', () => {
    setSecretValues(['s3cret-token']);
    expect(redactSecrets('curl -H "X: s3cret-token"')).toBe('curl -H "X: ***REDACTED***"');
  });
});

describe('body keys in XML and form bodies', () => {
  const soap = '<soapenv:Envelope><soapenv:Header><wsse:Security><wsse:UsernameToken><wsse:Username>agent</wsse:Username>'
    + '<wsse:Password Type="PasswordText">s3cret-pw</wsse:Password></wsse:UsernameToken></wsse:Security></soapenv:Header>'
    + '<soapenv:Body><OTA_AirAvailRQ Password="attr-secret" EchoToken="1"/></soapenv:Body></soapenv:Envelope>';

  it('masks an element by its local name and an attribute of the same name, leaving the rest byte for byte', () => {
    const { call: masked, count } = redactCall(call({ request: { headers: {}, body: soap } }), [redaction('request-body-key', 'password')]);
    expect(masked.request?.body).not.toContain('s3cret-pw');
    expect(masked.request?.body).not.toContain('attr-secret');
    expect(masked.request?.body).toBe(soap.replace('s3cret-pw', REDACTED).replace('attr-secret', REDACTED));
    expect(count).toBe(2);
  });

  it('matches a qualified name too', () => {
    const { call: masked } = redactCall(call({ request: { headers: {}, body: soap } }), [redaction('request-body-key', 'wsse:Password')]);
    expect(masked.request?.body).not.toContain('s3cret-pw');
    expect(masked.request?.body).toContain('attr-secret');
  });

  it('masks a form-encoded body pair by pair', () => {
    const { call: masked, count } = redactCall(call({ request: { headers: {}, body: 'user=agent&Password=hunter2&lang=en' } }), [redaction('request-body-key', 'password')]);
    expect(masked.request?.body).toBe(`user=agent&Password=${REDACTED}&lang=en`);
    expect(count).toBe(1);
  });

  it('leaves a body untouched when nothing matches', () => {
    const { call: masked, count } = redactCall(call({ request: { headers: {}, body: soap } }), [redaction('request-body-key', 'apikey')]);
    expect(masked.request?.body).toBe(soap);
    expect(count).toBe(0);
  });

  it('offers the control on a pretty-printed XML value line, not on a container line', () => {
    expect(redactableNameOf('    <wsse:Password Type="PasswordText">s3cret</wsse:Password>')).toBe('wsse:Password');
    expect(redactableNameOf('  <wsse:UsernameToken>')).toBeNull();
    expect(redactableNameOf('  "token": "x",')).toBe('token');
  });
});
