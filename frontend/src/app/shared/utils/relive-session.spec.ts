import { CookieJar, absorbSetCookies, applyCookieJar, sessionAppliedOf, swapRecordedValues, valueSwaps } from './relive-session';
import { regexValue, setCookies, xmlValue } from './resend-draft-chain';
import { StepResult } from './relive-types';

describe('relive-session', () => {
  describe('cookie jar', () => {
    it('replaces a recorded cookie with the one an earlier response set and keeps the others', () => {
      const jar: CookieJar = new Map();
      absorbSetCookies(jar, 'http://localhost:8080/auth/login', { 'Set-Cookie': 'JSESSIONID=NEW; Path=/; HttpOnly' });

      const applied = applyCookieJar(jar, 'http://localhost:8080/home', { Cookie: 'lang=en; JSESSIONID=OLD', Accept: '*/*' });

      expect(applied.headers).toEqual({ Accept: '*/*', Cookie: 'lang=en; JSESSIONID=NEW' });
      expect(applied.carried).toEqual(['JSESSIONID']);
    });

    it('adds a cookie the recording did not send, and drops one the server cleared', () => {
      const jar: CookieJar = new Map();
      absorbSetCookies(jar, 'http://localhost:8080/a', { 'set-cookie': 'csrf=abc12345; Path=/, remember=gone; Max-Age=0' });

      const applied = applyCookieJar(jar, 'http://localhost:8080/b', { cookie: 'remember=yes' });

      expect(applied.headers).toEqual({ cookie: 'csrf=abc12345' });
      expect(applied.carried).toEqual(['csrf']);
    });

    it('never sends a cookie to another host', () => {
      const jar: CookieJar = new Map();
      absorbSetCookies(jar, 'http://localhost:8080/a', { 'Set-Cookie': 'JSESSIONID=NEW' });

      const applied = applyCookieJar(jar, 'http://localhost:8083/b', { Cookie: 'JSESSIONID=OLD' });

      expect(applied.headers).toEqual({ Cookie: 'JSESSIONID=OLD' });
      expect(applied.carried).toEqual([]);
    });

    it('reads an Expires date inside a combined Set-Cookie header without splitting on its comma', () => {
      const cookies = setCookies({ 'Set-Cookie': 'a=1; Expires=Wed, 21 Oct 2015 07:28:00 GMT, b=2; Path=/' });

      expect(cookies).toEqual([{ name: 'a', value: '1', cleared: true }, { name: 'b', value: '2', cleared: false }]);
    });
  });

  describe('value swaps', () => {
    it('puts the run value wherever the recorded one appears, also URL-encoded, longest first', () => {
      const swaps = [{ name: 'short', recorded: 'abc123xy', current: 'S' }, { name: 'long', recorded: 'abc123xyz/=', current: 'n e w' }];

      const result = swapRecordedValues('h=abc123xyz/= q=abc123xyz%2F%3D t=abc123xy', swaps);

      expect(result.text).toBe('h=n e w q=n%20e%20w t=S');
      expect(result.swapped).toEqual(['long', 'short']);
    });

    it('offers a swap only for an extraction that remembers its recorded value and now holds another', () => {
      const steps = [{ extract: [
        { as: 'token', recordedValue: 'OLD-1' },
        { as: 'same', recordedValue: 'KEEP' },
        { as: 'plain' },
        { as: 'missing', recordedValue: 'X' },
      ] }];

      expect(valueSwaps(steps, { token: 'NEW-1', same: 'KEEP', plain: 'p' })).toEqual([{ name: 'token', recorded: 'OLD-1', current: 'NEW-1' }]);
    });

    it('reads what a step result says was swapped and carried', () => {
      const result = { editsApplied: { session: { swapped: ['token'], cookies: [] } } } as unknown as StepResult;

      expect(sessionAppliedOf(result)).toEqual({ swapped: ['token'], cookies: [] });
      expect(sessionAppliedOf({ editsApplied: null } as unknown as StepResult)).toBeNull();
    });
  });

  describe('XML and pattern extraction', () => {
    const soap = '<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body>'
      + '<m:LoginResponse xmlns:m="urn:x"><m:token type="bearer">T-123456</m:token></m:LoginResponse></soap:Body></soap:Envelope>';

    it('finds an element by its trailing names whatever the prefixes, and an attribute', () => {
      expect(xmlValue(soap, 'token')).toBe('T-123456');
      expect(xmlValue(soap, 'LoginResponse.token')).toBe('T-123456');
      expect(xmlValue(soap, 'Envelope.Body.LoginResponse.token')).toBe('T-123456');
      expect(xmlValue(soap, 'token.@type')).toBe('bearer');
      expect(xmlValue(soap, 'Body.token')).toBeUndefined();
      expect(xmlValue('not xml', 'token')).toBeUndefined();
    });

    it('takes a pattern\'s first group, or the whole match, and finds nothing for a bad pattern', () => {
      const html = '<input type="hidden" name="csrf" value="c5rf-9988">';
      expect(regexValue(html, 'name="csrf" value="([^"]+)"')).toBe('c5rf-9988');
      expect(regexValue(html, 'c5rf-[0-9]+')).toBe('c5rf-9988');
      expect(regexValue(html, '([')).toBeUndefined();
    });
  });
});
