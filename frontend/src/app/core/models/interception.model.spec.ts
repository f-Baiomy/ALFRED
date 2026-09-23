import { actionPhase, describeAction, describeMatch, isPauseAction, isTerminalAction } from './interception.model';

describe('interception model helpers', () => {
  describe('describeMatch', () => {
    it('says "any direction" and "any method" rather than leaving them blank', () => {
      // An empty match applies to ALL traffic, so the summary has to say so out loud - a blank
      // line in the rule list would read as "nothing in particular", which is the opposite.
      expect(describeMatch({})).toBe('any direction · any method');
    });

    it('lists every condition in the order the engine evaluates them', () => {
      expect(
        describeMatch({
          source: 'outbound',
          serviceName: 'Core-service',
          methods: ['POST', 'PUT'],
          host: '*.sabre.com',
          pathContains: '/order',
        })
      ).toBe('outbound · Core-service · POST/PUT · *.sabre.com · path contains /order');
    });

    it('shows a regex distinctly from a substring', () => {
      expect(describeMatch({ pathRegex: '/v\\d+/order' })).toContain('path ~ /v\\d+/order');
    });

    it('states the match tests, showing a plain value and hiding a secret one', () => {
      const sensitive = new Set(['x-api-key']);
      const text = describeMatch(
        {
          headers: [
            { name: 'x-test-scenario', operator: 'EQUALS', value: 'timeout' },
            { name: 'X-Api-Key', operator: 'EQUALS', value: 's3cret' },
          ],
          query: [{ name: 'mode', operator: 'EXISTS' }],
        },
        sensitive
      );
      expect(text).toContain('only when header x-test-scenario equals "timeout"');
      expect(text).toContain('header X-Api-Key equals (value hidden · 6 chars)');
      expect(text).toContain('query mode exists');
      expect(text).not.toContain('s3cret');
    });

    it('always hides a cookie value, and hides every value until the secret list has loaded', () => {
      expect(describeMatch({ cookies: [{ name: 'features', operator: 'CONTAINS', value: 'beta' }] }, new Set())).not.toContain(
        'beta'
      );
      expect(describeMatch({ headers: [{ name: 'x-tenant', operator: 'EQUALS', value: 'acme' }] })).not.toContain('acme');
    });
  });

  describe('describeAction', () => {
    it('names a cookie but never shows its value', () => {
      expect(describeAction({ type: 'SET_REQUEST_COOKIE', name: 'session', value: 's3cret' })).toBe('Set request cookie session');
      expect(
        describeAction({ type: 'SET_RESPONSE_COOKIE', name: 'session', value: '', cookieAttributes: { maxAge: 0 } })
      ).toBe('Expire response cookie session');
    });

    it('states the response encoding', () => {
      expect(describeAction({ type: 'SET_RESPONSE_ENCODING', encoding: 'br' })).toBe('Re-encode the response as br');
    });

    it('formats a delay with thousands separators', () => {
      expect(describeAction({ type: 'DELAY_REQUEST', durationMs: 10000 })).toBe('Delay request 10,000 ms');
    });

    it('shows a JSON field assignment with its value typed as it will be written', () => {
      expect(describeAction({ type: 'SET_RESPONSE_JSON_FIELD', path: 'status', value: 'FAILED' }))
        .toBe('Set status = "FAILED"');
      expect(describeAction({ type: 'SET_RESPONSE_JSON_FIELD', path: 'seats', value: 0 }))
        .toBe('Set seats = 0');
    });

    it('names the header rather than its value', () => {
      // A chip that printed the value would put a token in the rule list, which is exactly the
      // constraint the redaction feature exists to enforce elsewhere.
      const summary = describeAction({ type: 'SET_REQUEST_HEADER', name: 'Authorization', value: 'Bearer secret' });
      expect(summary).toContain('Authorization');
      expect(summary).not.toContain('secret');
    });

    it('states the wait for a pause, because that is how long a caller is held', () => {
      expect(describeAction({ type: 'PAUSE_RESPONSE', timeoutSeconds: 30, onTimeout: 'release' }))
        .toBe('Pause response — wait 30s');
    });

    // The one distinction that decides whether the supplier ever sees the call, so both chips have
    // to state it rather than both reading "500".
    it('distinguishes a mock from a replacement by whether the host was called', () => {
      expect(describeAction({ type: 'MOCK_RESPONSE', status: 500 })).toBe('Mock 500 — host never called');
      expect(describeAction({ type: 'REPLACE_RESPONSE', status: 500 })).toBe('Reply with 500 — host still called');
    });

    it('summarises send-to-host and a body replacement', () => {
      expect(describeAction({ type: 'SEND_TO_HOST' })).toBe('Send to the host');
      expect(describeAction({ type: 'SET_RESPONSE_BODY', body: '12345' })).toBe('Replace response body (5 chars)');
    });
  });

  describe('phase classification', () => {
    it('puts MOCK_RESPONSE in the REQUEST phase despite its name', () => {
      // It short-circuits before the request is forwarded - classifying it as a response action
      // would offer it in the wrong half of the action picker.
      expect(actionPhase('MOCK_RESPONSE')).toBe('request');
    });

    it('puts REPLACE_RESPONSE in the RESPONSE phase, unlike its mock counterpart', () => {
      // The pair is the whole point: MOCK_RESPONSE decides before the request goes out,
      // REPLACE_RESPONSE decides after the real answer came back.
      expect(actionPhase('REPLACE_RESPONSE')).toBe('response');
      expect(actionPhase('MOCK_RESPONSE')).toBe('request');
    });

    it('classifies the rest by their name', () => {
      expect(actionPhase('DELAY_REQUEST')).toBe('request');
      expect(actionPhase('PAUSE_REQUEST')).toBe('request');
      expect(actionPhase('SEND_TO_HOST')).toBe('request');
      expect(actionPhase('DELAY_RESPONSE')).toBe('response');
      expect(actionPhase('SET_RESPONSE_JSON_FIELD')).toBe('response');
      expect(actionPhase('SET_RESPONSE_BODY')).toBe('response');
      expect(actionPhase('PAUSE_RESPONSE')).toBe('response');
    });

    it('identifies terminal and pausing actions', () => {
      expect(isTerminalAction('ABORT_REQUEST')).toBeTrue();
      expect(isTerminalAction('MOCK_RESPONSE')).toBeTrue();
      expect(isTerminalAction('DELAY_REQUEST')).toBeFalse();
      expect(isPauseAction('PAUSE_REQUEST')).toBeTrue();
      expect(isPauseAction('PAUSE_RESPONSE')).toBeTrue();
      expect(isPauseAction('ABORT_REQUEST')).toBeFalse();
    });
  });
});
