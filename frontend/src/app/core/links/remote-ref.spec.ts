import { isRemoteRef, localPart, originOf, remoteCallRef, splitRef, withOrigin } from './remote-ref';
import { copiedFrom, copyName, untagged } from './keep-copy.service';

describe('remote refs (specs/035)', () => {
  it('splits the outermost link tag, and only a real tag', () => {
    expect(splitRef('8f1c@stg-83')).toEqual({ inner: '8f1c', slug: 'stg-83' });
    expect(splitRef('8f1c@stg-83@pc-1')).toEqual({ inner: '8f1c@stg-83', slug: 'pc-1' });
    expect(splitRef('a-local-uuid')).toBeNull();
    expect(splitRef('someone@example.com')).toBeNull(); // a dot is no tag
    expect(splitRef('@stg-83')).toBeNull();
    expect(splitRef('x@')).toBeNull();
    expect(splitRef('x@STG')).toBeNull();
    expect(splitRef(null)).toBeNull();
  });

  it('names the origin only for a known link when asked to', () => {
    const known = new Set(['stg-83']);
    expect(originOf('c1@stg-83', known)).toBe('stg-83');
    expect(originOf('c1@other', known)).toBeNull();
    expect(originOf('c1@other')).toBe('other');
    expect(isRemoteRef('c1', known)).toBeFalse();
  });

  it('builds and takes apart refs, a board call ref keeping its cycle', () => {
    expect(withOrigin('c1', 'stg-83')).toBe('c1@stg-83');
    expect(localPart('k@stg-83@pc-1')).toBe('k');
    expect(remoteCallRef('in', 'k9@stg-83', 'c1@stg-83')).toBe('in:k9@c1@stg-83');
    expect(remoteCallRef('out', 'k9@stg-83@pc-1', 'c1@stg-83@pc-1')).toBe('out:k9@c1@stg-83@pc-1');
  });
});

describe('Keep a copy (D34)', () => {
  it('takes the link tag off every id field and nothing else', () => {
    const call = {
      id: 'k1@stg-83', parentId: 'k0@stg-83', capturedByCycleIds: ['c1@stg-83'],
      response_body: '{"id":"k1@stg-83"}', request_headers: { 'X-Id': 'k1@stg-83' }, nested: { callId: 'k2@stg-83', note: 'k2@stg-83' },
    };
    const out = untagged(call, 'stg-83');
    expect(out.id).toBe('k1');
    expect(out.parentId).toBe('k0');
    expect(out.capturedByCycleIds).toEqual(['c1']);
    expect(out.nested.callId).toBe('k2');
    expect(out.nested.note).toBe('k2@stg-83');
    expect(out.response_body).toBe('{"id":"k1@stg-83"}');
    expect(out.request_headers['X-Id']).toBe('k1@stg-83');
    expect(call.id).toBe('k1@stg-83'); // the input is left as it was
  });

  it('names the copy so its chip can say where it came from', () => {
    const name = copyName('error flow', 'STG 83', new Date('2026-10-19T08:00:00Z'));
    expect(name).toBe('copy of error flow · from STG 83 · 2026-10-19');
    expect(copiedFrom(name)).toBe('STG 83');
    expect(copiedFrom('error flow')).toBeNull();
  });
});
