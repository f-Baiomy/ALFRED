import { CallRecord } from '../../core/models/call.model';
import { buildCopy, copySourceOf, copyTargetOf, defaultChoices } from './copy-from-call';

const SOAP = '<?xml version="1.0"?><soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body><Q>EUR</Q></soap:Body></soap:Envelope>';

const call: CallRecord = {
  id: 'c1',
  original_url: 'https://api.supplier.com:8443/soap/FareQuote?v=2',
  url: 'https://api.supplier.com:8443/soap/FareQuote?v=2',
  method: 'POST',
  timestamp: 't',
  duration_ms: 1,
  request: {
    headers: { 'Content-Type': 'text/xml; charset=utf-8', SOAPAction: '"FareQuote"', Authorization: 'Bearer x', 'Content-Length': '210', Host: 'api.supplier.com' },
    body: SOAP,
  },
  response: { status: 201, headers: { 'Content-Type': 'application/json', 'Set-Cookie': 's=1', 'X-Trace': 't1' }, body: '{"ok":true}' },
};

describe('copy-from-call', () => {
  it('knows which actions can copy from a call', () => {
    expect(copyTargetOf('SET_REQUEST_BODY')).toBe('request-body');
    expect(copyTargetOf('SET_RESPONSE_BODY')).toBe('response-body');
    expect(copyTargetOf('MOCK_RESPONSE')).toBe('response-whole');
    expect(copyTargetOf('REPLACE_RESPONSE')).toBe('response-whole');
    expect(copyTargetOf('DELAY_REQUEST')).toBeNull();
  });

  it('leaves out computed headers, marks secrets, and unticks secrets by default', () => {
    const source = copySourceOf(call, 'request-body', new Set(['authorization']));
    expect(source.skipped).toEqual(['Content-Length', 'Host']);
    expect(source.headers.find((h) => h.name === 'Authorization')?.secret).toBeTrue();
    expect(source.contentType).toBe('text/xml; charset=utf-8');
    const choices = defaultChoices(source);
    expect(choices.headers['Authorization']).toBeFalse();
    expect(choices.headers['SOAPAction']).toBeTrue();
    expect(choices.method).toBeFalse();
    expect(choices.url).toBeFalse();
  });

  it('copies a SOAP request: body and content type onto the action, other headers, method and URL as their own actions', () => {
    const source = copySourceOf(call, 'request-body', null);
    const result = buildCopy(source, 'request-body', { ...defaultChoices(source), method: true, url: true });
    expect(result.patch).toEqual({ body: SOAP, contentType: 'text/xml; charset=utf-8' });
    expect(result.extra).toEqual([
      { type: 'SET_REQUEST_HEADER', name: 'SOAPAction', value: '"FareQuote"' },
      { type: 'SET_METHOD', method: 'POST' },
      { type: 'REWRITE_URL', target: { scheme: 'https', host: 'api.supplier.com', port: 8443, path: '/soap/FareQuote' } },
    ]);
  });

  it('copies a response into a mock: status, headers and body all on the action', () => {
    const source = copySourceOf(call, 'response-whole', null);
    const result = buildCopy(source, 'response-whole', defaultChoices(source));
    expect(result.patch).toEqual({ body: '{"ok":true}', status: 201, headers: { 'Content-Type': 'application/json', 'X-Trace': 't1' } });
    expect(result.extra).toEqual([]);
  });

  it('copies a response body with its headers as response-header actions, and nothing unticked', () => {
    const source = copySourceOf(call, 'response-body', null);
    const result = buildCopy(source, 'response-body', { ...defaultChoices(source), body: false, headers: { 'X-Trace': true } });
    expect(result.patch).toEqual({});
    expect(result.extra).toEqual([{ type: 'SET_RESPONSE_HEADER', name: 'X-Trace', value: 't1' }]);
  });
});
