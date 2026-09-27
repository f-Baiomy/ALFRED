import { ResendResponseSnapshot } from './resend-draft';
import { extractValues, mergeThisValues, substituteDraft, substituteTokens, ThisValues } from './resend-draft-chain';

describe('resend-draft-chain', () => {
  const jsonResponse = (body: string, headers: Record<string, string> = {}): ResendResponseSnapshot => ({
    status: 200,
    headers,
    body,
  });

  describe('extractValues', () => {
    it('reads a JSON path from the response body', () => {
      const extracted = extractValues(jsonResponse('{"token":"abc123","nested":{"id":7}}'), [
        { from: 'JSON', path: 'token', as: 'auth', missing: 'SKIP' },
        { from: 'JSON', path: 'nested.id', as: 'id', missing: 'SKIP' },
      ]);
      expect(extracted).toEqual({ auth: 'abc123', id: '7' });
    });

    it('reads a header, case-insensitively', () => {
      const extracted = extractValues(jsonResponse('{}', { 'x-session-id': 'sess-1' }), [
        { from: 'HEADER', path: 'X-Session-Id', as: 'session', missing: 'SKIP' },
      ]);
      expect(extracted).toEqual({ session: 'sess-1' });
    });

    it('reads a cookie out of a joined set-cookie header, without splitting on a comma inside Expires', () => {
      const setCookie = 'a=1; Expires=Wed, 21 Oct 2026 07:28:00 GMT, b=2; Path=/';
      const extracted = extractValues(jsonResponse('{}', { 'set-cookie': setCookie }), [
        { from: 'COOKIE', path: 'b', as: 'bVal', missing: 'SKIP' },
      ]);
      expect(extracted).toEqual({ bVal: '2' });
    });

    it('skips a missing source when missing=SKIP, and falls back when missing=FALLBACK', () => {
      const extracted = extractValues(jsonResponse('{}'), [
        { from: 'JSON', path: 'absent', as: 'skipped', missing: 'SKIP' },
        { from: 'JSON', path: 'absent', as: 'fallenBack', missing: 'FALLBACK', fallback: 'default' },
      ]);
      expect(extracted).toEqual({ fallenBack: 'default' });
    });

    it('extracts nothing when there is no response at all', () => {
      expect(extractValues(null, [{ from: 'JSON', path: 'x', as: 'y', missing: 'SKIP' }])).toEqual({});
    });
  });

  describe('substituteTokens', () => {
    const thisValues: ThisValues = { token: 'abc123' };

    it('substitutes {{this.x}} with the stored value', () => {
      expect(substituteTokens('Bearer {{this.token}}', thisValues).text).toBe('Bearer abc123');
    });

    it('leaves an unknown this.x literal and reports it unavailable', () => {
      const result = substituteTokens('{{this.missing}}', thisValues);
      expect(result.text).toBe('{{this.missing}}');
      expect(result.unavailable).toEqual(['missing']);
    });

    it('substitutes {{row.x}} only when row values are given', () => {
      expect(substituteTokens('id={{row.id}}', thisValues, { id: '42' }).text).toBe('id=42');
      expect(substituteTokens('id={{row.id}}', thisValues).text).toBe('id={{row.id}}');
    });

    it('resolves {{$base64:this.x}} client-side, and leaves every other $ token for the backend', () => {
      const result = substituteTokens('{{$base64:this.token}} {{$uuid}} {{$now}}', thisValues);
      expect(result.text).toBe(`${btoa('abc123')} {{$uuid}} {{$now}}`);
    });

    it('reports an unavailable this.x used inside $base64 too', () => {
      const result = substituteTokens('{{$base64:this.missing}}', thisValues);
      expect(result.text).toBe('{{$base64:this.missing}}');
      expect(result.unavailable).toEqual(['missing']);
    });
  });

  describe('substituteDraft', () => {
    it('substitutes method, url, headers and body together, reporting every unavailable name once', () => {
      const draft = {
        method: '{{this.method}}',
        url: 'https://api/{{this.id}}',
        headers: [{ name: 'Authorization', value: 'Bearer {{this.token}}', removed: false }],
        body: '{"id":"{{this.id}}"}',
      };
      const result = substituteDraft(draft, { id: '7' });
      expect(result.method).toBe('{{this.method}}');
      expect(result.url).toBe('https://api/7');
      expect(result.headers[0].value).toBe('Bearer {{this.token}}');
      expect(result.body).toBe('{"id":"7"}');
      expect([...result.unavailable].sort()).toEqual(['method', 'token']);
    });

    it('never touches a removed header', () => {
      const draft = { method: 'GET', url: 'https://a', headers: [{ name: 'X', value: '{{this.x}}', removed: true }], body: '' };
      const result = substituteDraft(draft, {});
      expect(result.headers[0].value).toBe('{{this.x}}');
      expect(result.unavailable).toEqual([]);
    });
  });

  describe('mergeThisValues', () => {
    it('merges extracted values into the running map in place', () => {
      const target: ThisValues = { a: '1' };
      mergeThisValues(target, { b: '2' });
      expect(target).toEqual({ a: '1', b: '2' });
    });
  });
});
