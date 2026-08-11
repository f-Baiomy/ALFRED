import { CallRecord } from '../../core/models/call.model';
import { buildBulkCurlScript, buildCurlCommand, bulkCurlFilename } from './curl-builder';

function makeCall(overrides: Partial<CallRecord> = {}): CallRecord {
  return {
    id: 'call-1',
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

describe('buildBulkCurlScript', () => {
  it('numbers each call with a comment header and saves its response to its own file', () => {
    const calls = [
      makeCall({ method: 'GET', url: 'https://a.example/x' }),
      makeCall({ method: 'POST', url: 'https://b.example/y', timestamp: 't2' }),
    ];
    const script = buildBulkCurlScript(calls, '2026-08-07T18:00:00Z');

    expect(script).toContain('#!/bin/sh');
    expect(script).toContain('# --- Call 1: GET https://a.example/x ---');
    expect(script).toContain("curl -X GET 'https://a.example/x' \\\n  -o call-1-response.json");
    expect(script).toContain('# --- Call 2: POST https://b.example/y ---');
    expect(script).toContain('-o call-2-response.json');
  });

  it('includes the supplier hint in the header comment when provided, omits it otherwise', () => {
    const withHint = buildBulkCurlScript([makeCall()], '2026-08-07T18:00:00Z', { supplierName: 'FlyNas', credentialsUsed: 'EGY' });
    expect(withHint).toContain('# Supplier: FlyNas | Credentials: EGY');

    const withoutHint = buildBulkCurlScript([makeCall()], '2026-08-07T18:00:00Z', null);
    expect(withoutHint).not.toContain('# Supplier:');
  });

  it('never truncates a call\'s body', () => {
    const bigBody = JSON.stringify(Array.from({ length: 200 }, (_, i) => i));
    const call = makeCall({ request: { headers: {}, body: bigBody } });
    const script = buildBulkCurlScript([call], '2026-08-07T18:00:00Z');
    expect(script).toContain(bigBody);
  });
});

describe('bulkCurlFilename', () => {
  it('names the file after the call count', () => {
    expect(bulkCurlFilename([makeCall(), makeCall(), makeCall()])).toBe('alfred-export-3-calls.sh');
  });
});
