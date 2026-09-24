import { CallRecord } from '../../core/models/call.model';
import {
  countMatches,
  draftFrom,
  editsOf,
  findReplaceAll,
  isEdited,
  moveDraft,
  removeHeaderFromAll,
  resetDraft,
  setCurrentSessionOnAll,
  setHeaderOnAll,
  setHostOnAll,
  setMethodOnAll,
} from './resend-draft';

const SOAP = '<?xml version="1.0"?><soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body><Quote><Currency>EUR</Currency></Quote></soap:Body></soap:Envelope>';

function call(overrides: Partial<CallRecord> = {}): CallRecord {
  return {
    id: 'c1',
    original_url: 'https://api.supplier.com/v2/fares?cur=EUR',
    url: 'https://api.supplier.com/v2/fares?cur=EUR',
    method: 'POST',
    timestamp: 't',
    duration_ms: 1,
    source: 'external',
    request: { headers: { 'Content-Type': 'application/json', Authorization: 'Bearer old', 'X-Env': 'staging' }, body: '{"currency":"EUR"}' },
    ...overrides,
  };
}

describe('resend-draft', () => {
  it('sends nothing for an untouched draft', () => {
    const draft = draftFrom(call(), null);
    expect(editsOf(draft)).toEqual({});
    expect(isEdited(draft)).toBeFalse();
    expect(draft.ref).toEqual({ source: 'external', callId: 'c1', cycleId: null });
  });

  it('sends only what changed: method, url, a changed, removed and added header', () => {
    const d = draftFrom(call(), 'cy1');
    const edited = {
      ...d,
      method: 'PUT',
      url: 'https://api.supplier.com/v2/fares?cur=USD',
      headers: [
        { name: 'Content-Type', value: 'application/json', removed: false },
        { name: 'Authorization', value: 'Bearer new', removed: false },
        { name: 'X-Env', value: 'staging', removed: true },
        { name: 'X-Added', value: 'yes', removed: false, added: true },
      ],
    };
    expect(editsOf(edited)).toEqual({
      method: 'PUT',
      url: 'https://api.supplier.com/v2/fares?cur=USD',
      headers: { Authorization: 'Bearer new', 'X-Env': null, 'X-Added': 'yes' },
    });
    expect(edited.ref.cycleId).toBe('cy1');
  });

  it('treats a header that vanished from the rows as removed', () => {
    const d = draftFrom(call(), null);
    expect(editsOf({ ...d, headers: d.headers.filter((h) => h.name !== 'X-Env') }).headers).toEqual({ 'X-Env': null });
  });

  it('never sends a reformat as a body edit - a SOAP envelope goes out as recorded', () => {
    const d = draftFrom(call({ request: { headers: { SOAPAction: '"Quote"' }, body: SOAP } }), null);
    const pretty = SOAP.replace(/></g, '>\n  <');
    expect(editsOf({ ...d, body: pretty })).toEqual({});
    expect(editsOf({ ...d, body: pretty.replace('EUR', 'USD') }).body).toContain('USD');
  });

  it('counts use-current-session as an edit, and resets back to the logged request', () => {
    const d = { ...draftFrom(call(), null), useCurrentSession: true, method: 'GET' };
    expect(isEdited(d)).toBeTrue();
    const reset = resetDraft({ ...d, include: false });
    expect(isEdited(reset)).toBeFalse();
    expect(reset.include).toBeFalse();
    expect(reset.key).toBe(d.key);
  });

  describe('edit all at once', () => {
    const two = () => [draftFrom(call(), null), draftFrom(call({ id: 'c2', request: { headers: { authorization: 'x' } } }), null)];

    it('sets a header case-insensitively, adding it where missing', () => {
      const [a, b] = setHeaderOnAll(two(), 'Authorization', 'Bearer new');
      expect(a.headers.find((h) => h.name === 'Authorization')?.value).toBe('Bearer new');
      expect(b.headers.find((h) => h.name === 'authorization')?.value).toBe('Bearer new');
      const [c] = setHeaderOnAll(two(), 'X-Bulk', '1');
      expect(c.headers.find((h) => h.name === 'X-Bulk')?.added).toBeTrue();
    });

    it('leaves skipped calls alone', () => {
      const drafts = two();
      const out = setMethodOnAll([drafts[0], { ...drafts[1], include: false }], 'get');
      expect(out[0].method).toBe('GET');
      expect(out[1].method).toBe('POST');
    });

    it('removes a header from all, and drops one that was only added', () => {
      const added = setHeaderOnAll(two(), 'X-Bulk', '1');
      const [a] = removeHeaderFromAll(removeHeaderFromAll(added, 'x-env'), 'X-Bulk');
      expect(a.headers.find((h) => h.name === 'X-Env')?.removed).toBeTrue();
      expect(a.headers.some((h) => h.name === 'X-Bulk')).toBeFalse();
      expect(editsOf(a).headers).toEqual({ 'X-Env': null });
    });

    it('counts and replaces in URL, header values and body, plain or regex', () => {
      const all = { inUrl: true, inHeaders: true, inBody: true };
      expect(countMatches(two(), /EUR/i, all)).toBe(3);
      expect(countMatches(two(), /EUR/i, { inUrl: false, inHeaders: false, inBody: true })).toBe(1);
      expect(countMatches(two(), null, all)).toBeNull();
      const [a] = findReplaceAll(two(), /c(u)r=EUR/, 'c$1r=USD', all);
      expect(a.url).toContain('cur=USD');
    });

    it('points outbound calls at another host and skips inbound ones', () => {
      const inbound = draftFrom(call({ id: 'in', source: 'internal', url: 'http://localhost:8081/app' }), null);
      const { drafts, skipped } = setHostOnAll([draftFrom(call(), null), inbound], 'api.staging.supplier.com');
      expect(drafts[0].url).toBe('https://api.staging.supplier.com/v2/fares?cur=EUR');
      expect(drafts[1].url).toBe('http://localhost:8081/app');
      expect(skipped).toBe(1);
    });

    it('switches current session on all, and reorders', () => {
      expect(setCurrentSessionOnAll(two(), true).every((d) => d.useCurrentSession)).toBeTrue();
      const drafts = two();
      expect(moveDraft(drafts, 1, 0).map((d) => d.ref.callId)).toEqual(['c2', 'c1']);
    });
  });
});
