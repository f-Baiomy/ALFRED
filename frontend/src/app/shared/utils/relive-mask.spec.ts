import { setSecretValues } from './redact';
import { maskRelive } from './relive-mask';

describe('maskRelive', () => {
  afterEach(() => setSecretValues([]));

  it('masks a secret variable value inside a body', () => {
    const result = maskRelive('{"bookingRef":"BK-6004"}', ['bookingRef'], { bookingRef: 'BK-6004' });
    expect(result).toBe('{"bookingRef":"•••"}');
  });

  it('masks a secret variable value inside a header', () => {
    const result = maskRelive('Bearer eyJhbGciOi9f2', ['token'], { token: 'eyJhbGciOi9f2' });
    expect(result).toBe('Bearer •••');
  });

  it('masks a secret variable value inside a URL', () => {
    const result = maskRelive('https://app.local/book?ref=BK-6004', ['bookingRef'], { bookingRef: 'BK-6004' });
    expect(result).toBe('https://app.local/book?ref=•••');
  });

  it('leaves a non-secret variable value untouched', () => {
    const result = maskRelive('searchId=S-90417', ['bookingRef'], { bookingRef: 'BK-6004', searchId: 'S-90417' });
    expect(result).toBe('searchId=S-90417');
  });

  it('also masks a global secret value via the reused redact.ts helper ("redaction rule")', () => {
    setSecretValues(['s3cret-shared-token']);
    const result = maskRelive('{"apiKey":"s3cret-shared-token"}', [], {});
    expect(result).toContain('***REDACTED***');
    expect(result).not.toContain('s3cret-shared-token');
  });

  it('masks an Authorization header value that matches a global secret value', () => {
    setSecretValues(['s3cret-shared-token']);
    const result = maskRelive('Bearer s3cret-shared-token', [], {});
    expect(result).toBe('Bearer ***REDACTED***');
  });
});
