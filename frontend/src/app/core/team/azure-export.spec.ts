import { CallRecord } from '../models/call.model';
import { azureEvidenceHtml, azureRedactions } from './azure-export';

const TOKEN = 'Bearer sk_live_abcdef123456';

function call(): CallRecord {
  return {
    id: 'c1',
    original_url: 'http://localhost:9001/v1/refund',
    url: 'https://api.example.com/v1/refund',
    method: 'POST',
    request: { headers: { Accept: 'application/json', Authorization: TOKEN, Cookie: 'sid=s3cr3t' }, body: '{"amount":5}' },
    timestamp: '2026-01-01T00:00:00.000Z',
    duration_ms: 10,
    response: { status: 500, headers: { 'content-type': 'application/json', 'set-cookie': 'sid=n3w; HttpOnly' }, body: '{"error":"boom"}' },
  };
}

/** specs/028 SC-007: evidence sent to Azure never carries a credential unless the user ticks "send unmasked". */
describe('azure-export', () => {
  it('masks Authorization, Cookie and Set-Cookie on top of no user redactions', () => {
    const html = azureEvidenceHtml([call()], [], false, 'Card #4');
    expect(html).not.toContain('sk_live_abcdef123456');
    expect(html).not.toContain('s3cr3t');
    expect(html).not.toContain('n3w');
    expect(html).toContain('secrets masked');
    expect(html).toContain('boom'); // the rest of the call is whole
  });

  it('sends the call as it is when "send unmasked" is ticked', () => {
    const html = azureEvidenceHtml([call()], [], true, 'Card #4');
    expect(html).toContain('sk_live_abcdef123456');
    expect(html).toContain('sent unmasked');
  });

  it('keeps the user\'s own redactions and adds both directions of each masked header', () => {
    const all = azureRedactions([{ id: 'u', scope: 'all', callId: null, kind: 'request-body-key', name: 'amount', createdAt: '' }]);
    expect(all.some((r) => r.name === 'amount')).toBeTrue();
    expect(all.filter((r) => r.name === 'authorization').map((r) => r.kind).sort()).toEqual(['request-header', 'response-header']);
    expect(azureEvidenceHtml([call()], all, false, 'x')).not.toContain('"amount":5');
  });
});
