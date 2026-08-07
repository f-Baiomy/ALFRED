import { CallRecord } from '../../core/models/call.model';
import { buildCurlCommand } from './curl-builder';

function makeCall(overrides: Partial<CallRecord> = {}): CallRecord {
  return {
    original_url: 'https://example.com-proxy/api/x',
    url: 'https://example.com/api/x',
    method: 'GET',
    request: { headers: {}, body: '' },
    timestamp: '2026-01-01T00:00:00.000000+00:00',
    duration_ms: 100,
    response: { status: 200, headers: {}, body: '{}' },
    ...overrides,
  };
}

describe('buildCurlCommand', () => {
  it('builds a GET request against the real forwarded url, not the -proxy host', () => {
    const cmd = buildCurlCommand(makeCall());
    expect(cmd).toContain("curl -X GET 'https://example.com/api/x'");
    expect(cmd).not.toContain('-proxy');
  });

  it('includes every request header and the body when present', () => {
    const call = makeCall({
      method: 'post',
      request: { headers: { Accept: 'application/json', 'X-Api-Key': 'abc' }, body: '{"x":1}' },
    });
    const cmd = buildCurlCommand(call);
    expect(cmd).toContain('-X POST');
    expect(cmd).toContain("-H 'Accept: application/json'");
    expect(cmd).toContain("-H 'X-Api-Key: abc'");
    expect(cmd).toContain(`--data-raw '{"x":1}'`);
  });

  it('escapes single quotes in header values and bodies so the command stays valid shell syntax', () => {
    const call = makeCall({
      request: { headers: { 'X-Note': `it's here` }, body: `{"msg":"it's a test"}` },
    });
    const cmd = buildCurlCommand(call);
    expect(cmd).toContain(`'X-Note: it'\\''s here'`);
    expect(cmd).toContain(`'{"msg":"it'\\''s a test"}'`);
  });

  it('omits --data-raw when there is no body', () => {
    expect(buildCurlCommand(makeCall({ request: { headers: {}, body: '' } }))).not.toContain('--data-raw');
  });
});
