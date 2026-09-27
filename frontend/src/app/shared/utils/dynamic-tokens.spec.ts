import vectors from '../../../../../specs/002-power-features/dynamic-token-vectors.json';
import { resolveDynamicTokens } from './dynamic-tokens';

/**
 * The shared vectors are the contract between this resolver, the proxy's and the resend
 * backend's - every case here also runs in proxy/test_dynamic_tokens.py and ResendService's tests.
 */
describe('resolveDynamicTokens', () => {
  const now = new Date(vectors.now);
  const variables: Record<string, string> = vectors.variables;
  const lookup = (name: string) => variables[name];

  for (const c of vectors.cases as Array<{ input: string; expect?: string; expectRegex?: string }>) {
    it(`resolves ${c.input}`, () => {
      const out = resolveDynamicTokens(c.input, lookup, now);
      if (c.expect !== undefined) expect(out).toBe(c.expect);
      else expect(out).toMatch(new RegExp(c.expectRegex!));
    });
  }

  it('draws randomInt from the whole inclusive range', () => {
    expect(resolveDynamicTokens('{{$randomInt:1:3}}', lookup, now, () => 0)).toBe('1');
    expect(resolveDynamicTokens('{{$randomInt:1:3}}', lookup, now, () => 0.9999)).toBe('3');
  });
});
